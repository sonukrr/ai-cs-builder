import { existsSync } from "node:fs";
import { PNG } from "pngjs";
import { type Browser, type ElementHandle, type Page, chromium } from "playwright-core";
import { MAX_UPLOAD_BYTES, assets } from "@/lib/store/assets";
import { persistDesignImage } from "@/lib/providers/figma/rest";
import { store } from "@/lib/store/store";
import type { FidelityCapture } from "./types";

/**
 * The "actual" half of the fidelity evidence: screenshots of the real preview.
 *
 * Everything here is best-effort by contract. The review exists to put a human
 * in front of the evidence, and a human who cannot open the review because
 * Chrome is missing is worse off than one reading a report that says so in a
 * sentence. So there is one failure mode — a populated `capture.unavailable` —
 * and nothing thrown reaches the caller.
 *
 * `playwright-core` rather than `playwright`: the full package downloads its own
 * Chromium on install, which is ~150MB nobody asked for and a postinstall step
 * that fails behind a proxy. This drives the Chrome already on the machine.
 */

const DEFAULT_PREVIEW_ORIGIN = process.env.PREVIEW_ORIGIN ?? "http://localhost:4200";
const DEFAULT_STUDIO_ORIGIN = process.env.STUDIO_ORIGIN ?? "http://localhost:3000";
const DEFAULT_CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

/** The width careers designs are drawn at, so bands line up with the design. */
const DEFAULT_VIEWPORT_WIDTH = 1440;

/**
 * A full-page PNG of a long careers page can pass the asset store's 8MB limit.
 * Clipping to this loses the tail of a very long page, which beats losing the
 * screenshot altogether.
 */
const MAX_CLIP_HEIGHT = 6000;

export interface CapturePreviewOptions {
  /** Project whose blueprint the preview renders, and where shots are stored. */
  projectId: string;
  /** Blueprint page to render. Empty renders the first, as the host does. */
  pageId?: string;
  /**
   * Figma frame this page was built from. Used to find the stored reference
   * image for that frame, so the caller does not have to know where the import
   * put its pictures.
   */
  frameId?: string;
  /**
   * An explicit reference image, when the caller already has one. An http(s)
   * URL is pulled into the asset store first: Figma's render links are signed
   * and expire, and a report is read long after it is written.
   */
  designImageUrl?: string;
  viewportWidth?: number;
  previewOrigin?: string;
  studioOrigin?: string;
  /** Per-step budget for navigation and for waiting on the sections. */
  timeoutMs?: number;
  chromePath?: string;
}

/**
 * A capture, plus the per-section scores only this layer can produce.
 *
 * The scores ride on the capture rather than being a second export because
 * only the code that took the screenshots knows which ones it actually got,
 * and where on the page each one sat.
 */
export interface PreviewCapture extends FidelityCapture {
  /** sectionId -> 0..1 against the matching slice of the design. */
  visualScores: Record<string, number>;
}

export async function capturePreview(options: CapturePreviewOptions): Promise<PreviewCapture> {
  const previewOrigin = (options.previewOrigin ?? DEFAULT_PREVIEW_ORIGIN).replace(/\/+$/, "");
  const studioOrigin = (options.studioOrigin ?? DEFAULT_STUDIO_ORIGIN).replace(/\/+$/, "");
  const viewportWidth = options.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const timeout = options.timeoutMs ?? 25_000;
  const chromePath = options.chromePath ?? DEFAULT_CHROME_PATH;

  const notes: string[] = [];
  const designImageUrl = await resolveDesignImage(options, notes);

  const base: PreviewCapture = {
    designImageUrl,
    previewImageUrl: "",
    sectionImages: {},
    visualScores: {},
    viewportWidth,
    capturedAt: new Date().toISOString(),
    unavailable: "",
  };

  // Checked before launching a browser so the admin gets "start the preview
  // host" rather than a navigation timeout that says nothing.
  const hostProblem = await previewHostProblem(previewOrigin);
  if (hostProblem) return { ...base, unavailable: hostProblem };

  let browser: Browser | null = null;
  try {
    browser = await launchChrome(chromePath);
  } catch (error) {
    return { ...base, unavailable: describeLaunchFailure(error, chromePath) };
  }

  try {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: 900 },
      // The comparison downsamples to 32x32, so a retina-density capture would
      // quadruple the stored bytes and change nothing about the score.
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const url =
      `${previewOrigin}/?project=${encodeURIComponent(options.projectId)}` +
      (options.pageId ? `&page=${encodeURIComponent(options.pageId)}` : "") +
      `&studio=${encodeURIComponent(studioOrigin)}&source=sample`;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      return { ...base, unavailable: `Could not open ${url}: ${message(error)}` };
    }

    // The host fetches the blueprint over HTTP and only then renders, so no
    // fixed delay is both safe and quick. The sections' own marker attribute is
    // the real signal that there is something worth photographing.
    try {
      await page.waitForSelector("[data-section-id]", { state: "attached", timeout });
    } catch {
      return { ...base, unavailable: await describeEmptyPage(page, studioOrigin, pageErrors) };
    }

    // Web fonts and section imagery move enough pixels to matter to the score,
    // and both are usually still in flight when the sections attach.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page
      .evaluate(async () => {
        await document.fonts?.ready;
      })
      .catch(() => {});

    const previewImageUrl = await capturePage(page, options.projectId, notes);
    const sections = await captureSections(page, options.projectId, notes);

    const sectionImages: Record<string, string> = {};
    for (const section of sections) sectionImages[section.id] = section.url;

    return {
      ...base,
      previewImageUrl,
      sectionImages,
      visualScores: await scoreSections(options.projectId, designImageUrl, sections),
      capturedAt: new Date().toISOString(),
      // A partial capture is still a usable visual axis, and `unavailable` is
      // what the UI uses to hide that axis entirely — so only a capture that
      // produced nothing at all sets it.
      unavailable:
        previewImageUrl || sections.length > 0
          ? ""
          : notes.join(" ") || "The preview rendered but no screenshot could be stored.",
    };
  } catch (error) {
    return { ...base, unavailable: `The preview capture failed: ${message(error)}` };
  } finally {
    // A leaked Chrome outlives the request and eventually the machine's
    // patience, so this closes on every path, thrown ones included.
    await browser?.close().catch(() => {});
  }
}

/**
 * Compares two PNGs as a 32x32 grid of average colour, 1 = identical.
 *
 * Deliberately coarse. The preview renders approved `zm-careers-lib`
 * components, which can never be pixel-identical to the rectangles a designer
 * drew, so a per-pixel diff would report ~0 for a perfectly good build. Average
 * colour per cell answers the question a reviewer actually has: is the same
 * sort of thing, in the same colours, in the same place down the page?
 *
 * The grid also normalises size, which is the only reason a 1440x4200 Figma
 * frame can be compared against a preview of a completely different height.
 */
export function visualScore(a: Uint8Array, b: Uint8Array): number {
  const left = decode(a);
  const right = decode(b);
  // Never blocking and never a verdict, so an unreadable image scores 0 rather
  // than taking down the report that was about to be shown to a human.
  if (!left || !right) return 0;
  return compareGrids(gridOf(left), gridOf(right));
}

/**
 * Reads back an image this module or the Figma import stored.
 *
 * Callers hold URLs, not bytes — `FidelityCapture` carries no buffers on
 * purpose, because a report is JSON on disk. This turns one of those URLs back
 * into pixels. Returns null for anything it does not own.
 */
export async function readStoredImage(projectId: string, url: string): Promise<Uint8Array | null> {
  if (!url) return null;

  // The mock backend inlines its frames; that is legitimate evidence too.
  if (url.startsWith("data:image/")) {
    try {
      return new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    } catch {
      return null;
    }
  }

  const match = url.match(/^\/api\/projects\/([^/]+)\/assets\/([^/?#]+)$/);
  if (!match) return null;
  try {
    // The id in the URL wins over the caller's: an asset only ever reads out of
    // the project it was written into.
    const asset = await assets.read(decodeURIComponent(match[1]) || projectId, match[2]);
    return asset ? new Uint8Array(asset.data) : null;
  } catch {
    return null;
  }
}

/** `visualScore` for two stored URLs; undefined when either is missing. */
export async function scoreStoredImages(
  projectId: string,
  designUrl: string,
  builtUrl: string,
): Promise<number | undefined> {
  const [design, built] = await Promise.all([
    readStoredImage(projectId, designUrl),
    readStoredImage(projectId, builtUrl),
  ]);
  if (!design || !built) return undefined;
  return visualScore(design, built);
}

/** Where a section sat on the built page, as a fraction of its full height. */
interface CapturedSection {
  id: string;
  url: string;
  top: number;
  bottom: number;
}

/**
 * Scores each section against the slice of the design it lines up with.
 *
 * There is only ever one rendered image per Figma frame — the whole screen —
 * so a band-level score has to come from cropping it. The built page and the
 * design run the same sections in the same order, which makes "the part of the
 * design at the same relative depth" a fair, if rough, counterpart. It is rough
 * on purpose: this number is shown to a reviewer as evidence, and the UI says
 * out loud that a low score is expected where an approved component replaced a
 * bespoke design.
 */
async function scoreSections(
  projectId: string,
  designImageUrl: string,
  sections: CapturedSection[],
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  if (!designImageUrl || sections.length === 0) return scores;

  const designBytes = await readStoredImage(projectId, designImageUrl);
  // Decoded once: a full-height frame PNG is expensive to parse and every
  // section would otherwise pay for it again.
  const design = designBytes ? decode(designBytes) : null;
  if (!design) return scores;

  for (const section of sections) {
    const shot = await readStoredImage(projectId, section.url);
    const built = shot ? decode(shot) : null;
    if (!built) continue;
    scores[section.id] = compareGrids(
      gridOf(design, section.top, section.bottom),
      gridOf(built),
    );
  }
  return scores;
}

/** Grid edge; 32x32 cells of RGB is 3072 numbers, cheap to hold and compare. */
const GRID = 32;

function decode(input: Uint8Array): PNG | null {
  try {
    const png = PNG.sync.read(Buffer.from(input));
    return png.width > 0 && png.height > 0 ? png : null;
  } catch {
    return null;
  }
}

/** Average colour per cell over a vertical slice, `top`..`bottom` as 0..1. */
function gridOf(png: PNG, top = 0, bottom = 1): Float64Array {
  const fromY = Math.max(0, Math.min(png.height - 1, Math.floor(top * png.height)));
  const toY = Math.max(fromY + 1, Math.min(png.height, Math.ceil(bottom * png.height)));
  const height = toY - fromY;

  const sums = new Float64Array(GRID * GRID * 3);
  const counts = new Float64Array(GRID * GRID);

  for (let y = fromY; y < toY; y += 1) {
    const row = Math.min(GRID - 1, Math.floor(((y - fromY) / height) * GRID));
    for (let x = 0; x < png.width; x += 1) {
      const column = Math.min(GRID - 1, Math.floor((x / png.width) * GRID));
      const source = (png.width * y + x) << 2;
      // Element screenshots keep their transparency; composited over white so a
      // transparent gap reads as the page behind it rather than as black.
      const alpha = png.data[source + 3] / 255;
      const cell = (row * GRID + column) * 3;
      sums[cell] += png.data[source] * alpha + 255 * (1 - alpha);
      sums[cell + 1] += png.data[source + 1] * alpha + 255 * (1 - alpha);
      sums[cell + 2] += png.data[source + 2] * alpha + 255 * (1 - alpha);
      counts[row * GRID + column] += 1;
    }
  }

  const grid = new Float64Array(GRID * GRID * 3);
  for (let cell = 0; cell < counts.length; cell += 1) {
    const count = counts[cell] || 1;
    grid[cell * 3] = sums[cell * 3] / count;
    grid[cell * 3 + 1] = sums[cell * 3 + 1] / count;
    grid[cell * 3 + 2] = sums[cell * 3 + 2] / count;
  }
  return grid;
}

function compareGrids(a: Float64Array, b: Float64Array): number {
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference += Math.abs(a[index] - b[index]);
  }
  const mean = difference / a.length / 255;
  return Math.max(0, Math.min(1, 1 - mean));
}

/**
 * Finds the reference image for this page.
 *
 * The import stores frame renders and records them on the plan, so a caller
 * that only knows the frame id still gets a picture. Everything is optional
 * because every one of these can legitimately be absent — an older project
 * imported before renders were kept, a design Figma would not render — and the
 * report is expected to cope.
 */
async function resolveDesignImage(
  options: CapturePreviewOptions,
  notes: string[],
): Promise<string> {
  const explicit = options.designImageUrl ?? "";
  const url = explicit || (await designImageFromPlan(options.projectId, options.frameId ?? ""));
  if (!url) return "";
  if (!/^https?:\/\//.test(url)) return url;

  // Belt and braces: the import persists these, but a design imported before
  // that existed still holds a Figma link that has since expired.
  return persistDesignImage(options.projectId, url, "the design reference", notes);
}

/** `DesignDocument.images`, as the importer recorded it against the plan. */
async function designImageFromPlan(projectId: string, frameId: string): Promise<string> {
  try {
    const stored = await store.getPlan(projectId);
    const meta = (stored?.meta ?? {}) as Record<string, unknown>;
    // The key has moved between "images" and "designImages" as the importer
    // grew; read both rather than making the review depend on which one wrote.
    const images = (meta.images ?? meta.designImages ?? {}) as Record<string, unknown>;
    if (typeof images !== "object" || images === null) return "";

    const direct = images[frameId];
    if (typeof direct === "string" && direct) return direct;

    // One frame, one image: the id is not worth insisting on.
    const values = Object.values(images).filter((v): v is string => typeof v === "string" && !!v);
    return values.length === 1 ? values[0] : "";
  } catch {
    return "";
  }
}

/** "" when the host answered at all — even a 404 proves something is there. */
async function previewHostProblem(previewOrigin: string): Promise<string> {
  try {
    await fetch(previewOrigin, { signal: AbortSignal.timeout(5_000) });
    return "";
  } catch {
    return (
      `The preview host is not running at ${previewOrigin}; start it with \`npm run preview\` ` +
      `(or set PREVIEW_ORIGIN if it runs elsewhere) and run the review again.`
    );
  }
}

/**
 * `channel: "chrome"` first: it resolves the system install through the OS's
 * own registry, which survives a distro that puts Chrome somewhere other than
 * /usr/bin. The explicit path is the fallback for the ones it misses.
 */
async function launchChrome(chromePath: string): Promise<Browser> {
  // --no-sandbox because the studio is frequently run as root in a container,
  // where Chrome's own sandbox refuses to start at all.
  const args = ["--no-sandbox"];
  try {
    return await chromium.launch({ channel: "chrome", args });
  } catch (channelError) {
    if (!existsSync(chromePath)) throw channelError;
    return chromium.launch({ executablePath: chromePath, args });
  }
}

function describeLaunchFailure(error: unknown, chromePath: string): string {
  if (!existsSync(chromePath)) {
    return (
      `Google Chrome was not found at ${chromePath}, so the preview could not be screenshotted. ` +
      `Install Google Chrome, or point CHROME_PATH at an existing install. ` +
      `Everything else in this review is unaffected.`
    );
  }
  return `Google Chrome is installed at ${chromePath} but would not start: ${message(error)}`;
}

/**
 * The sections never appeared. The host puts its own diagnosis on the page and
 * that is nearly always the actionable one — the studio API unreachable, or the
 * project having no saved version to render.
 */
async function describeEmptyPage(
  page: Page,
  studioOrigin: string,
  pageErrors: string[],
): Promise<string> {
  const shown = (await page.textContent(".preview-error").catch(() => null))?.trim();
  if (shown) return `The preview host could not render this project: ${shown}`;
  if (pageErrors.length > 0) return `The preview host errored before rendering: ${pageErrors[0]}`;
  return (
    `The preview loaded but rendered no sections. It fetches the blueprint from ${studioOrigin}, ` +
    `so check the studio is running there and that this project has a saved version.`
  );
}

async function capturePage(page: Page, projectId: string, notes: string[]): Promise<string> {
  try {
    let png = await page.screenshot({ fullPage: true, type: "png" });
    if (png.byteLength > MAX_UPLOAD_BYTES) {
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      png = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height: MAX_CLIP_HEIGHT },
      });
      notes.push(`The page was too tall to store whole; the top ${MAX_CLIP_HEIGHT}px was kept.`);
    }
    return await persistPng(projectId, png, "Preview of the built page", notes);
  } catch (error) {
    notes.push(`The full-page screenshot failed: ${message(error)}`);
    return "";
  }
}

/**
 * One shot per section, keyed by the id the blueprint uses.
 *
 * Per-section images are what make a band-level score possible at all — a
 * whole-page comparison cannot tell a reviewer *which* band drifted. Layout
 * sections contain other sections, so the shots nest; that is intended, the
 * report joins them back up by id.
 */
async function captureSections(
  page: Page,
  projectId: string,
  notes: string[],
): Promise<CapturedSection[]> {
  const captured: CapturedSection[] = [];

  let elements: ElementHandle<SVGElement | HTMLElement>[];
  let pageHeight: number;
  try {
    elements = await page.$$("[data-section-id]");
    pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  } catch (error) {
    notes.push(`Per-section screenshots failed: ${message(error)}`);
    return captured;
  }

  const seen = new Set<string>();
  for (const element of elements) {
    const id = await element.getAttribute("data-section-id").catch(() => null);
    if (!id || seen.has(id)) continue;
    try {
      // A collapsed or hidden section has no box, and asking Chrome to
      // photograph a 0x0 element throws rather than returning an empty image.
      const box = await element.boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;

      const png = await element.screenshot({ type: "png" });
      const url = await persistPng(projectId, png, `Preview of section ${id}`, notes);
      if (!url) continue;

      seen.add(id);
      captured.push({
        id,
        url,
        // boundingBox is document-relative, which is what the design slice
        // needs: both are measured from the top of the whole page.
        top: pageHeight > 0 ? Math.max(0, box.y / pageHeight) : 0,
        bottom: pageHeight > 0 ? Math.min(1, (box.y + box.height) / pageHeight) : 1,
      });
    } catch (error) {
      notes.push(`Section ${id} could not be screenshotted: ${message(error)}`);
    }
  }

  return captured;
}

/** Screenshots leave this module as URLs; a report is JSON, not a buffer. */
async function persistPng(
  projectId: string,
  png: Uint8Array,
  alt: string,
  notes: string[],
): Promise<string> {
  if (png.byteLength > MAX_UPLOAD_BYTES) {
    notes.push(`${alt} was ${Math.round(png.byteLength / 1024)}KB, over the asset limit.`);
    return "";
  }
  try {
    const saved = await assets.save(projectId, { data: png, contentType: "image/png", alt });
    return saved.url;
  } catch (error) {
    notes.push(`${alt} could not be stored: ${message(error)}`);
    return "";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
