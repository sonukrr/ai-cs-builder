import type { Browser, Page } from "playwright-core";
import { BROWSER_USER_AGENT, describeLaunchFailure, launchChrome } from "@/lib/browser";
import { MAX_UPLOAD_BYTES, assets } from "@/lib/store/assets";
import type { WebBand, WebImage, WebPageCapture, WebTokens } from "./types";

/**
 * Reading a live page well enough to replicate it.
 *
 * WHY A BROWSER AND NOT A FETCH. The pages this is pointed at are careers
 * sites, and careers sites are applications: the one that prompted this serves
 * an `<app-root>` and three tracking pixels, and every band, every photograph
 * and every word arrives later from JavaScript. Fetching the HTML gets a shell.
 * So the page is rendered in the Chrome already on the machine — the same
 * browser the fidelity review drives — and read from the live DOM.
 *
 * WHAT IS EXTRACTED, AND WHY THAT. Bands, not a DOM dump. The agent already
 * knows how to turn "here is a band, here is its geometry, its copy, its
 * colours and its pictures" into a faithful `custom-html` replica, because that
 * is exactly what a Figma import hands it. This produces the same shape from a
 * URL, so the replica pipeline is reused rather than rebuilt.
 *
 * IMAGES ARE COPIED, NOT LINKED. A blueprint that pointed at the original
 * site's image URLs would break the moment that site moved a file, and would
 * make the published site quietly dependent on somebody else's server. Every
 * picture is pulled into the project's own asset store, which is also what
 * makes it survive publishing — both emitters copy assets into the repository.
 */

/** Bands past this are below anything an administrator is judging. */
const MAX_BANDS = 24;
/** Images past this stop being a page and start being a crawl. */
const MAX_IMAGES = 60;
/** Rendered smaller than this in both axes: a spacer, an icon, or a tracker. */
const MIN_IMAGE_EDGE = 24;
/** The width careers pages are designed at. */
const DEFAULT_VIEWPORT_WIDTH = 1440;
/** Markup kept per band. Enough to see the structure, not the whole document. */
const MAX_MARKUP = 4000;
const MAX_BAND_TEXT = 1200;
/**
 * Elements per band whose styling is read.
 *
 * Every node would be most of a megabyte of framework defaults. The band's own
 * box plus its headings, buttons, images and direct children is what decides
 * how it looks; anything past that is detail a replica infers.
 */
const MAX_STYLED_ELEMENTS = 14;
/** Distinct animations kept. A page that defines more is not animating more. */
const MAX_KEYFRAMES = 20;

export interface CaptureWebPageOptions {
  projectId: string;
  url: string;
  viewportWidth?: number;
  timeoutMs?: number;
}

/**
 * What the in-page script returns.
 *
 * Kept separate from `WebBand` because the browser side knows nothing about the
 * asset store: it reports the URLs it found, and this side turns them into
 * stored assets.
 */
interface RawBand {
  index: number;
  name: string;
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  text: string;
  headings: string[];
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  images: { sourceUrl: string; alt: string; width: number; height: number; background: boolean }[];
  markup: string;
  selector: string;
  styles: { selector: string; declarations: string }[];
  animations: string[];
}

interface RawCapture {
  title: string;
  description: string;
  pageHeight: number;
  bands: RawBand[];
  images: { sourceUrl: string; alt: string; width: number; height: number; background: boolean }[];
  tokens: WebTokens;
  keyframes: string[];
  notes: string[];
}

export async function captureWebPage(options: CaptureWebPageOptions): Promise<WebPageCapture> {
  const viewportWidth = options.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const timeout = options.timeoutMs ?? 45_000;
  const warnings: string[] = [];

  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new Error(`"${options.url}" is not a URL.`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`Refusing to open ${target.protocol} — only http and https pages can be read.`);
  }

  let browser: Browser;
  try {
    browser = await launchChrome();
  } catch (error) {
    throw new Error(describeLaunchFailure(error));
  }

  try {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: 1000 },
      userAgent: BROWSER_USER_AGENT,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const response = await page.goto(target.toString(), {
      waitUntil: "networkidle",
      timeout,
    });
    if (response && !response.ok()) {
      warnings.push(`The page answered ${response.status()}; what was read may be an error page.`);
    }

    // A careers page renders its listings after its first paint, and a band
    // captured mid-render is a band of skeletons.
    await page.waitForTimeout(2500);
    await settlePage(page);

    const raw = (await page.evaluate(extractPage, {
      maxBands: MAX_BANDS,
      maxImages: MAX_IMAGES,
      minImageEdge: MIN_IMAGE_EDGE,
      maxMarkup: MAX_MARKUP,
      maxText: MAX_BAND_TEXT,
      maxStyledElements: MAX_STYLED_ELEMENTS,
      maxKeyframes: MAX_KEYFRAMES,
    })) as RawCapture;

    warnings.push(...raw.notes);

    /* Pictures first: the bands reference them. */
    const imported = new Map<string, WebImage>();
    for (const found of raw.images) {
      if (imported.size >= MAX_IMAGES) break;
      const stored = await importImage(options.projectId, found, target, warnings);
      if (stored) imported.set(found.sourceUrl, stored);
    }

    const screenshotUrl = await captureFullPage(page, options.projectId, warnings);

    const bands: WebBand[] = [];
    for (const band of raw.bands) {
      const shot = await captureBand(page, band, options.projectId, warnings);
      bands.push({
        index: band.index,
        name: band.name,
        tag: band.tag,
        bounds: band.bounds,
        text: band.text,
        headings: band.headings,
        backgroundColor: band.backgroundColor,
        textColor: band.textColor,
        fontFamily: band.fontFamily,
        images: band.images
          .map((image) => imported.get(image.sourceUrl))
          .filter((image): image is WebImage => image !== undefined),
        screenshotUrl: shot,
        markup: band.markup,
        styles: band.styles,
        animations: band.animations,
      });
    }

    if (bands.length === 0) {
      warnings.push(
        "No bands could be read from this page. It may render its content only after an interaction, or block automated browsers.",
      );
    }

    return {
      url: target.toString(),
      title: raw.title,
      description: raw.description,
      viewportWidth,
      pageHeight: raw.pageHeight,
      bands,
      images: [...imported.values()],
      tokens: raw.tokens,
      keyframes: raw.keyframes,
      screenshotUrl,
      warnings,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Waits for the page to stop moving.
 *
 * Lazy-loaded imagery is the reason: a careers page defers everything below the
 * fold, so a capture that never scrolls records a page of empty boxes. Scrolling
 * to the bottom and back triggers the loaders, and then the height has to settle
 * before anything is measured.
 */
async function settlePage(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  } catch {
    // A page that will not scroll is still worth reading.
  }
}

/**
 * The in-page reader.
 *
 * Runs in the browser, so it can use nothing from this module. It answers the
 * questions a replica needs and deliberately not more: a whole serialised DOM
 * would be most of a megabyte of framework attributes the agent has no use for.
 */
function extractPage(config: {
  maxBands: number;
  maxImages: number;
  minImageEdge: number;
  maxMarkup: number;
  maxText: number;
  maxStyledElements: number;
  maxKeyframes: number;
}): RawCapture {
  const notes: string[] = [];

  const seen = (element: Element): boolean => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return false;

    /*
      Off-canvas drawers. A mobile menu is usually present, sized and visible by
      every other measure, and parked outside the viewport by a transform — it
      came back from a real page as a 720x940 "band" that nobody can see. An
      element wholly to the left or right of the page is not part of the layout
      being replicated.
    */
    const pageWidth = document.documentElement.clientWidth;
    if (box.right <= 0 || box.left >= pageWidth) return false;

    return true;
  };

  const absolute = (value: string): string => {
    try {
      return new URL(value, document.baseURI).toString();
    } catch {
      return "";
    }
  };

  /*
    The walk starts at `body`, not at `main`.

    Rooting it at `main` looked tidier and lost the two bands an administrator
    notices first: the header and the footer are siblings of `main`, not
    children of it. The recursion below already steps through an app shell, so
    starting higher costs nothing and keeps the page whole.
  */
  const root = document.body;

  /*
    Bands are the top-level blocks of that container. A child that is nearly the
    whole page is a wrapper rather than a band, so the walk steps into it — the
    same reasoning the Figma summarizer applies to a frame named "Container".
  */
  const bandsOf = (element: Element, depth: number): Element[] => {
    const children = [...element.children].filter(
      (child) => seen(child) && !["script", "style", "noscript", "link"].includes(child.tagName.toLowerCase()),
    );
    if (children.length === 0) return [element];

    const pageHeight = document.documentElement.scrollHeight;
    const out: Element[] = [];
    for (const child of children) {
      const box = child.getBoundingClientRect();
      const tall = box.height > pageHeight * 0.8;
      const single = children.length === 1;
      if ((tall || single) && depth < 4) out.push(...bandsOf(child, depth + 1));
      else if (box.height >= 40) out.push(child);
    }
    return out;
  };

  const elements = bandsOf(root, 0).slice(0, config.maxBands);
  if (elements.length === config.maxBands) {
    notes.push(`The page has more than ${config.maxBands} bands; the rest were not read.`);
  }

  /*
    Images are swept from the whole document rather than accumulated band by
    band. A logo lives in the header, a payment mark in the footer, and a
    background photograph on a wrapper that is nobody's band — collecting only
    what fell inside a recognised band returned, on a real page, none of them.
  */

  const allImages: RawCapture["images"] = [];
  const pushImage = (image: RawCapture["images"][number]) => {
    if (!image.sourceUrl) return;
    if (image.width < config.minImageEdge && image.height < config.minImageEdge) return;
    if (allImages.some((existing) => existing.sourceUrl === image.sourceUrl)) return;
    allImages.push(image);
  };

  const imagesIn = (element: Element): RawCapture["images"] => {
    const found: RawCapture["images"] = [];

    for (const img of element.querySelectorAll("img")) {
      if (!seen(img)) continue;
      const box = img.getBoundingClientRect();
      const entry = {
        sourceUrl: absolute(img.currentSrc || img.getAttribute("src") || ""),
        alt: (img.getAttribute("alt") ?? "").trim().slice(0, 160),
        width: Math.round(box.width),
        height: Math.round(box.height),
        background: false,
      };
      found.push(entry);
      pushImage(entry);
    }

    // Background images carry as much of a careers page as <img> does — heroes
    // especially — and a replica without them is a grey box.
    const candidates = [element, ...element.querySelectorAll("*")].slice(0, 1200);
    for (const node of candidates) {
      if (!(node instanceof HTMLElement) || !seen(node)) continue;
      const background = getComputedStyle(node).backgroundImage;
      const match = background && background !== "none" ? background.match(/url\(["']?(.*?)["']?\)/) : null;
      if (!match) continue;
      const box = node.getBoundingClientRect();
      const entry = {
        sourceUrl: absolute(match[1]),
        alt: "",
        width: Math.round(box.width),
        height: Math.round(box.height),
        background: true,
      };
      found.push(entry);
      pushImage(entry);
    }

    return found;
  };

  imagesIn(document.body);

  /** Animation names actually used, so only those keyframes are collected. */
  const usedAnimations = new Set<string>();

  const nameOf = (element: Element): string => {
    const heading = element.querySelector("h1, h2, h3");
    const text = heading?.textContent?.trim();
    if (text) return text.slice(0, 60);
    const id = element.getAttribute("id");
    if (id) return id.slice(0, 60);
    const tag = element.tagName.toLowerCase();
    const cls = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)[0];
    return cls ? `${tag}.${cls}`.slice(0, 60) : tag;
  };

  const selectorOf = (element: Element, index: number): string => {
    const id = element.getAttribute("id");
    if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
    // Fall back to a marker, so the caller can screenshot exactly this element.
    element.setAttribute("data-studio-band", String(index));
    return `[data-studio-band="${index}"]`;
  };

  /*
    The properties that describe a design.

    Computed style has ~340 entries per element, nearly all of them defaults.
    These are the ones that answer "why does this band look like that" —
    including the two the caller specifically wants, `transition` and
    `animation`, which are the whole of how a page moves.
  */
  const DESIGN_PROPERTIES = [
    "display", "position", "width", "height", "max-width", "min-height",
    "margin", "padding", "box-sizing",
    "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "flex",
    "grid-template-columns", "grid-template-rows",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "text-transform", "text-decoration", "white-space",
    "color", "background-color", "background-image", "background-size",
    "background-position", "background-repeat",
    "border", "border-radius", "box-shadow", "outline",
    "opacity", "transform", "transform-origin", "filter", "backdrop-filter",
    "transition", "animation", "overflow", "z-index", "object-fit",
  ];

  /** Defaults nobody needs to read back. */
  const UNINTERESTING = new Set([
    "none", "normal", "auto", "0px", "0px 0px 0px 0px", "rgba(0, 0, 0, 0)",
    "visible", "static", "baseline", "repeat", "start", "0s", "medium none rgb(0, 0, 0)",
  ]);

  const pathTo = (element: Element, band: Element): string => {
    const step = (node: Element): string => {
      const tag = node.tagName.toLowerCase();
      const cls = (node.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((name) => name && !/^ng-|^_ng|^mat-/.test(name))[0];
      return cls ? `${tag}.${cls}` : tag;
    };

    const parts: string[] = [step(element)];
    let cursor = element.parentElement;
    while (cursor && cursor !== band && parts.length < 3) {
      parts.unshift(step(cursor));
      cursor = cursor.parentElement;
    }
    return parts.join(" > ");
  };

  const declarationsOf = (element: Element): string => {
    const style = getComputedStyle(element);
    const out: string[] = [];
    for (const property of DESIGN_PROPERTIES) {
      const value = style.getPropertyValue(property).trim();
      if (!value || UNINTERESTING.has(value)) continue;
      out.push(`${property}: ${value.length > 160 ? `${value.slice(0, 160)}…` : value};`);
    }
    return out.join(" ");
  };

  /** Elements worth reading: the band, then what carries its design. */
  const styledElements = (band: Element): Element[] => {
    const picked: Element[] = [band];
    const notable = band.querySelectorAll(
      "h1, h2, h3, p, a, button, img, [class*=btn], [class*=card], [class*=hero]",
    );
    for (const node of [...band.children, ...notable]) {
      if (picked.length >= config.maxStyledElements) break;
      if (!picked.includes(node) && seen(node)) picked.push(node);
    }
    return picked;
  };

  /** Anything that moves, and what moves it. */
  const animationsOf = (band: Element): string[] => {
    const found: string[] = [];
    for (const node of [band, ...band.querySelectorAll("*")].slice(0, 200)) {
      if (!seen(node)) continue;
      const style = getComputedStyle(node);
      const animation = style.animationName;
      const transition = style.transitionProperty;
      const parts: string[] = [];

      if (animation && animation !== "none") {
        parts.push(
          `animation: ${animation} ${style.animationDuration} ${style.animationTimingFunction} ${style.animationDelay} ${style.animationIterationCount}`.trim(),
        );
        usedAnimations.add(animation);
      }
      if (transition && transition !== "all" && transition !== "none") {
        parts.push(`transition: ${transition} ${style.transitionDuration} ${style.transitionTimingFunction}`.trim());
      } else if (transition === "all" && style.transitionDuration !== "0s") {
        parts.push(`transition: all ${style.transitionDuration} ${style.transitionTimingFunction}`);
      }

      if (parts.length > 0) found.push(`${pathTo(node, band)} — ${parts.join("; ")}`);
      if (found.length >= 12) break;
    }
    return found;
  };

  const bands: RawBand[] = elements.map((element, index) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const scrollY = window.scrollY;

    return {
      index,
      name: nameOf(element),
      tag: element.tagName.toLowerCase(),
      bounds: {
        x: Math.round(box.x),
        y: Math.round(box.y + scrollY),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, config.maxText),
      headings: [...element.querySelectorAll("h1, h2, h3")]
        .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 8),
      backgroundColor: style.backgroundColor,
      textColor: style.color,
      fontFamily: style.fontFamily,
      images: imagesIn(element),
      markup: element.outerHTML.slice(0, config.maxMarkup),
      selector: selectorOf(element, index),
      styles: styledElements(element).map((node) => ({
        selector: node === element ? `(the band itself)` : pathTo(node, element),
        declarations: declarationsOf(node),
      })),
      animations: animationsOf(element),
    };
  });

  /* Tokens, inferred from what the page actually uses. */
  const frequency = (values: string[]): string => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };

  const hex = (colour: string): string => {
    const match = colour.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!match) return "";
    if (match[4] !== undefined && Number(match[4]) < 0.5) return "";
    const [, r, g, b] = match;
    const to = (value: string) => Number(value).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  };

  const buttons = [...document.querySelectorAll("button, .btn, a.button, [class*=btn]")]
    .filter((node) => node instanceof HTMLElement && seen(node))
    .slice(0, 40) as HTMLElement[];

  const accent =
    frequency(
      buttons
        .map((button) => hex(getComputedStyle(button).backgroundColor))
        .filter((colour) => colour && colour !== "#ffffff" && colour !== "#000000"),
    ) || "";

  const headings = [...document.querySelectorAll("h1, h2")]
    .filter((node) => node instanceof HTMLElement && seen(node))
    .slice(0, 20) as HTMLElement[];

  const bodyStyle = getComputedStyle(document.body);
  const radii = buttons
    .map((button) => Number.parseFloat(getComputedStyle(button).borderRadius))
    .filter((value) => Number.isFinite(value) && value >= 0 && value < 64);

  const tokens: WebTokens = {
    primary: frequency(headings.map((heading) => hex(getComputedStyle(heading).color)).filter(Boolean)) || "#111111",
    accent: accent || "#2563eb",
    background: hex(bodyStyle.backgroundColor) || "#ffffff",
    surface:
      frequency(
        bands
          .map((band) => hex(band.backgroundColor))
          .filter((colour) => colour && colour !== hex(bodyStyle.backgroundColor)),
      ) || "#f5f6f8",
    text: hex(bodyStyle.color) || "#111111",
    muted: "",
    headingFont: (headings[0] ? getComputedStyle(headings[0]).fontFamily : bodyStyle.fontFamily)
      .split(",")[0]
      .replace(/["']/g, "")
      .trim(),
    bodyFont: bodyStyle.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
    radius: radii.length > 0 ? Math.round(radii.sort((a, b) => a - b)[Math.floor(radii.length / 2)]) : 8,
  };

  /*
    The keyframes behind those animation names.

    A stylesheet served from another origin throws on `.cssRules` — the browser
    will not let a page read a foreign stylesheet's contents. That is reported
    rather than swallowed, because it is the difference between "this page does
    not animate" and "the animation is defined somewhere this cannot see".
  */
  const keyframes: string[] = [];
  let blockedSheets = 0;
  for (const sheet of [...document.styleSheets]) {
    if (keyframes.length >= config.maxKeyframes) break;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      blockedSheets += 1;
      continue;
    }
    for (const rule of [...rules]) {
      if (keyframes.length >= config.maxKeyframes) break;
      if (rule.constructor.name !== "CSSKeyframesRule") continue;
      const named = rule as CSSKeyframesRule;
      if (!usedAnimations.has(named.name)) continue;
      keyframes.push(named.cssText.slice(0, 1200));
    }
  }

  if (blockedSheets > 0) {
    notes.push(
      `${blockedSheets} stylesheet(s) are served from another origin, so their rules could not be read. Animations defined only there are named in the bands but have no keyframes here.`,
    );
  }

  return {
    title: document.title.slice(0, 200),
    description:
      document.querySelector('meta[name="description"]')?.getAttribute("content")?.slice(0, 400) ?? "",
    pageHeight: document.documentElement.scrollHeight,
    bands,
    images: allImages.slice(0, config.maxImages),
    tokens,
    keyframes,
    notes,
  };
}

/* --------------------------------------------------------------- importing */

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/svg+xml"]);

/**
 * Pulls one picture into the project's asset store.
 *
 * Fetched with a browser's user agent and the page as referer, because a
 * careers site's CDN commonly refuses anything else — and a 403 here is an
 * image the replica would silently lose.
 */
async function importImage(
  projectId: string,
  found: { sourceUrl: string; alt: string; width: number; height: number; background: boolean },
  page: URL,
  warnings: string[],
): Promise<WebImage | null> {
  try {
    if (found.sourceUrl.startsWith("data:")) {
      const match = found.sourceUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (!match) return null;
      const [, contentType, base64, payload] = match;
      if (!IMAGE_TYPES.has(contentType)) return null;
      const data = Buffer.from(base64 ? payload : decodeURIComponent(payload), base64 ? "base64" : "utf8");
      return await store(projectId, data, contentType, found, warnings);
    }

    const response = await fetch(found.sourceUrl, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Referer: page.toString(),
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      warnings.push(`${short(found.sourceUrl)} could not be downloaded (${response.status}).`);
      return null;
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(contentType)) {
      warnings.push(`${short(found.sourceUrl)} is ${contentType || "an unknown type"}, not an image.`);
      return null;
    }

    const data = Buffer.from(await response.arrayBuffer());
    return await store(projectId, data, contentType, found, warnings);
  } catch (error) {
    warnings.push(`${short(found.sourceUrl)} could not be downloaded: ${message(error)}`);
    return null;
  }
}

async function store(
  projectId: string,
  data: Buffer,
  contentType: string,
  found: { sourceUrl: string; alt: string; width: number; height: number; background: boolean },
  warnings: string[],
): Promise<WebImage | null> {
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    warnings.push(`${short(found.sourceUrl)} is ${Math.round(data.byteLength / 1024)}KB, over the asset limit.`);
    return null;
  }

  const saved = await assets.save(projectId, {
    data,
    contentType,
    // The page's own alt text is the best description available, and it is what
    // the replica should carry.
    alt: found.alt,
  });

  return {
    sourceUrl: found.sourceUrl,
    url: saved.url,
    alt: found.alt,
    width: found.width,
    height: found.height,
    background: found.background,
    bytes: saved.bytes,
  };
}

async function captureFullPage(page: Page, projectId: string, warnings: string[]): Promise<string> {
  try {
    const png = await page.screenshot({ fullPage: true, type: "png" });
    if (png.byteLength > MAX_UPLOAD_BYTES) {
      const clipped = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 1440, height: 6000 },
      });
      return await persist(projectId, clipped, "The imported page", warnings);
    }
    return await persist(projectId, png, "The imported page", warnings);
  } catch (error) {
    warnings.push(`The page screenshot failed: ${message(error)}`);
    return "";
  }
}

async function captureBand(
  page: Page,
  band: RawBand,
  projectId: string,
  warnings: string[],
): Promise<string> {
  try {
    const element = await page.$(band.selector);
    if (!element) return "";
    const png = await element.screenshot({ type: "png", timeout: 15_000 });
    return await persist(projectId, png, `Band ${band.index}: ${band.name}`, warnings);
  } catch {
    // A band that will not screenshot is still describable; its geometry, copy
    // and images are already read.
    return "";
  }
}

async function persist(
  projectId: string,
  png: Uint8Array,
  alt: string,
  warnings: string[],
): Promise<string> {
  if (png.byteLength > MAX_UPLOAD_BYTES) {
    warnings.push(`${alt} was too large to store.`);
    return "";
  }
  try {
    const saved = await assets.save(projectId, { data: png, contentType: "image/png", alt });
    return saved.url;
  } catch (error) {
    warnings.push(`${alt} could not be stored: ${message(error)}`);
    return "";
  }
}

function short(url: string): string {
  return url.length > 80 ? `${url.slice(0, 80)}…` : url;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
