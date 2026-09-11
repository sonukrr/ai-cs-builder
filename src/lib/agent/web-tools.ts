import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { captureWebPage } from "@/lib/providers/web/capture";
import type { WebBand, WebPageCapture } from "@/lib/providers/web/types";
import { store } from "@/lib/store/store";
import { readStoredImage } from "@/lib/fidelity/capture";

/**
 * Replicating a page the administrator points at.
 *
 * The gap this closes: the agent could research a page's *text* and could read
 * a Figma file's geometry, but had no way to see a live page — so asked to
 * reproduce one it invented a layout and left every image behind. A careers
 * site is an application, so its markup, its pictures and its styling only
 * exist after JavaScript runs; `captureWebPage` renders it in Chrome and reads
 * the result.
 *
 * These tools deliberately mirror the Figma ones, because the agent already
 * knows that pipeline and it is the right one:
 *
 *   import_web_page    ↔ import_figma          — read the page, store its images
 *   list_web_bands     ↔ (the plan)            — what the page is made of
 *   render_web_band    ↔ render_design_node    — look at one band
 *   describe_web_band  ↔ describe_design_node  — its geometry, copy and images
 *   get_web_band_css   ↔ get_design_reference  — how it is styled and animated
 *
 * WHOSE PAGE. Copying a competitor's site is not what this is for, and the
 * system prompt says so: research summarises another company's *patterns*,
 * never their markup or imagery. This exists because an administrator asks for
 * their own careers page — the one they are migrating — to be reproduced
 * faithfully. The URL always comes from them, and the capture is recorded on
 * the project so what was copied, and from where, is auditable.
 */

export interface WebToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

/** Bands are described one at a time; a whole page of CSS is unreadable. */
const MAX_LISTED_TEXT = 220;

function describeBand(band: WebBand): string {
  const size = `${band.bounds.width}×${band.bounds.height}`;
  const at = `top ${band.bounds.y}px`;
  return [
    `[${band.index}] ${band.name} — <${band.tag}>, ${size} at ${at}`,
    band.headings.length > 0 ? `    headings: ${band.headings.slice(0, 4).join(" · ")}` : "",
    `    background ${band.backgroundColor}, text ${band.textColor}, ${band.fontFamily.split(",")[0]}`,
    band.images.length > 0 ? `    ${band.images.length} image(s)` : "",
    band.animations.length > 0 ? `    ${band.animations.length} animated element(s)` : "",
    band.text ? `    copy: ${band.text.slice(0, MAX_LISTED_TEXT)}${band.text.length > MAX_LISTED_TEXT ? "…" : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWebTools({ projectId, onActivity }: WebToolContext) {
  /** The capture for this project, held between tool calls within a turn. */
  let capture: WebPageCapture | null = null;

  const requireCapture = (): WebPageCapture => {
    if (!capture) {
      throw new Error("No page has been imported yet — call import_web_page with the URL first.");
    }
    return capture;
  };

  const bandAt = (index: number): WebBand => {
    const page = requireCapture();
    const band = page.bands[index];
    if (!band) {
      throw new Error(
        `There is no band ${index}. The page has ${page.bands.length}, numbered 0 to ${page.bands.length - 1}.`,
      );
    }
    return band;
  };

  const importPage = betaZodTool({
    name: "import_web_page",
    description:
      "Open a live web page in a real browser and read it: its bands top to bottom, the copy and headings in each, the colours, fonts and animations, and every image — which is downloaded into this project so the site does not depend on the original. Use this whenever the administrator gives you a URL they want reproduced. Takes about half a minute.",
    inputSchema: z.object({
      url: z.string().describe("the page to read, exactly as the administrator gave it"),
      viewportWidth: z
        .number()
        .int()
        .min(320)
        .max(2560)
        .optional()
        .describe("the width to render at; 1440 unless the administrator asks for a phone"),
    }),
    run: async ({ url, viewportWidth }) => {
      onActivity("import_web_page", `Reading ${url}`);

      const page = await captureWebPage({ projectId, url, viewportWidth });
      capture = page;

      // Recorded on the project so a later reader can see what was copied and
      // from where, long after the conversation has gone.
      await store.saveWebCapture(projectId, page);

      onActivity(
        "import_web_page",
        `Read ${page.bands.length} bands and imported ${page.images.length} images from ${new URL(page.url).hostname}`,
      );

      return [
        `Read ${page.url}`,
        `"${page.title}"${page.description ? ` — ${page.description.slice(0, 160)}` : ""}`,
        `${page.viewportWidth}px wide, ${page.pageHeight}px tall, ${page.bands.length} bands.`,
        "",
        `Its design tokens, as rendered: primary ${page.tokens.primary}, accent ${page.tokens.accent}, background ${page.tokens.background}, surface ${page.tokens.surface}, text ${page.tokens.text}, headings in ${page.tokens.headingFont}, body in ${page.tokens.bodyFont}, radius ${page.tokens.radius}px. Apply them with update_theme so the replica starts from the real palette.`,
        "",
        `${page.images.length} image(s) are now in this project's asset library and can be used with set_section_image. list_image_sources shows them.`,
        page.keyframes.length > 0 ? `${page.keyframes.length} animation(s) were captured; get_web_band_css includes the keyframes.` : "",
        "",
        "Bands:",
        ...page.bands.map(describeBand),
        "",
        page.warnings.length > 0 ? `Notes:\n${page.warnings.map((w) => `  - ${w}`).join("\n")}` : "",
        "",
        "Now rebuild it band by band: render_web_band to look at one, describe_web_band for its numbers and pictures, get_web_band_css for how it is styled and animated, then set_custom_html to author the replica. Functional bands — search, filters, job lists, apply — are approved components from the catalog, never hand-written markup, however simple they look.",
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  });

  const listBands = betaZodTool({
    name: "list_web_bands",
    description: "List the bands of the imported page again, with their sizes and copy.",
    inputSchema: z.object({}),
    run: async () => {
      const page = requireCapture();
      onActivity("list_web_bands", `Listed ${page.bands.length} bands`);
      return [`${page.url} — ${page.bands.length} bands:`, ...page.bands.map(describeBand)].join("\n");
    },
  });

  /**
   * Looking at a band.
   *
   * The single most useful tool here, for the same reason `render_design_node`
   * is on the Figma side: coordinates say a box is 1440×359, and only the
   * picture says it is a dark hero with a breadcrumb above a headline.
   */
  const renderBand = betaZodTool({
    name: "render_web_band",
    description:
      "Look at one band of the imported page as an image. Do this before authoring its replica — the geometry tells you the size, only the picture tells you the shape.",
    inputSchema: z.object({ index: z.number().int().min(0) }),
    run: async ({ index }) => {
      const band = bandAt(index);
      if (!band.screenshotUrl) {
        return `Band ${index} (${band.name}) could not be screenshotted. describe_web_band and get_web_band_css still have its numbers, copy and styling.`;
      }

      const image = await readStoredImage(projectId, band.screenshotUrl);
      if (!image) return `The screenshot for band ${index} is no longer in the asset store.`;

      onActivity("render_web_band", `Looked at band ${index}: ${band.name}`);

      return [
        {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: "image/png" as const,
            data: Buffer.from(image).toString("base64"),
          },
        },
        {
          type: "text" as const,
          text: `Band ${index}: ${band.name} — ${band.bounds.width}×${band.bounds.height} at top ${band.bounds.y}px.`,
        },
      ];
    },
  });

  const describe = betaZodTool({
    name: "describe_web_band",
    description:
      "The exact numbers for one band: its box, colours, fonts, every heading and line of copy, and the images inside it with the asset URLs to reuse.",
    inputSchema: z.object({ index: z.number().int().min(0) }),
    run: async ({ index }) => {
      const band = bandAt(index);
      onActivity("describe_web_band", `Read band ${index}: ${band.name}`);

      return [
        `Band ${index}: ${band.name} <${band.tag}>`,
        `Box: ${band.bounds.width}×${band.bounds.height} at x ${band.bounds.x}, y ${band.bounds.y}`,
        `Background ${band.backgroundColor} · text ${band.textColor} · ${band.fontFamily}`,
        "",
        band.headings.length > 0 ? `Headings:\n${band.headings.map((h) => `  ${h}`).join("\n")}` : "No headings.",
        "",
        `Copy:\n${band.text || "  (none)"}`,
        "",
        band.images.length > 0
          ? `Images (already in this project — use these URLs with set_section_image, or in the replica's markup):\n${band.images
              .map(
                (image) =>
                  `  ${image.url} — ${image.width}×${image.height}${image.background ? ", a CSS background" : ""}${
                    image.alt ? `, alt "${image.alt}"` : ", no alt text on the original"
                  }`,
              )
              .join("\n")}`
          : "No images in this band.",
      ].join("\n");
    },
  });

  /**
   * How a band is styled, and what moves.
   *
   * Reference, in the same sense as `get_design_reference`: it is here to be
   * read and translated, not pasted. What the agent writes still goes through
   * the replica sanitizer, which decides what markup and CSS are allowed.
   */
  const bandCss = betaZodTool({
    name: "get_web_band_css",
    description:
      "The styling behind one band as the browser resolved it — layout, spacing, type, colour, borders and shadows for the band and the elements inside it, plus its transitions and animations and the keyframes they use. Read it and translate it; never paste it wholesale.",
    inputSchema: z.object({ index: z.number().int().min(0) }),
    run: async ({ index }) => {
      const page = requireCapture();
      const band = bandAt(index);
      onActivity("get_web_band_css", `Read the styling of band ${index}`);

      const usesKeyframes = page.keyframes.filter((frame) =>
        band.animations.some((animation) => frame.includes(animation.split("animation: ")[1]?.split(" ")[0] ?? " ")),
      );

      return [
        `Band ${index}: ${band.name} — resolved styling`,
        "",
        ...band.styles.map((rule) => `${rule.selector} {\n  ${rule.declarations}\n}`),
        "",
        band.animations.length > 0
          ? `Movement:\n${band.animations.map((line) => `  ${line}`).join("\n")}`
          : "Nothing in this band animates.",
        "",
        usesKeyframes.length > 0 ? `Keyframes:\n${usesKeyframes.join("\n")}` : "",
        "",
        "These are computed values at the width the page was read. Translate them into the replica's own CSS — relative units and a media query where the original clearly reflows — rather than freezing this width into the site.",
      ]
        .filter((line) => line !== "")
        .join("\n");
    },
  });

  return [importPage, listBands, renderBand, describe, bandCss];
}
