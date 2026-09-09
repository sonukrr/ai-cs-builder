import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { store } from "@/lib/store/store";
import { assets } from "@/lib/store/assets";
import { getStockProvider } from "@/lib/providers/images/stock";
import { IMAGE_SLOTS, type ImageCandidate, type Orientation } from "@/lib/providers/images/types";
import type { Blueprint } from "@/lib/blueprint/schema";

/**
 * The imagery tools.
 *
 * Split out from tools.ts because they share a concern the others do not: every
 * URL the agent writes into a blueprint has to come from somewhere real. The
 * agent cannot browse the web for a photograph and cannot invent a CDN link
 * that happens to resolve, so these tools are the only sanctioned sources —
 * uploads the company owns, a stock provider when one is configured, and a
 * generated placeholder that always works.
 */

export interface ImageToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

/** Sensible pixel dimensions per slot, so placeholders are not all one shape. */
const SLOT_SIZES: Record<Orientation, { w: number; h: number }> = {
  landscape: { w: 1600, h: 900 },
  portrait: { w: 800, h: 1000 },
  square: { w: 800, h: 800 },
  any: { w: 1600, h: 900 },
};

function describe(candidate: ImageCandidate, index: number): string {
  const credit = candidate.credit
    ? ` — ${candidate.credit.photographer} on ${candidate.credit.source}`
    : "";
  return `${index + 1}. ${candidate.url}\n   ${candidate.width}×${candidate.height} · alt: "${candidate.alt}"${credit}`;
}

export function buildImageTools(context: ImageToolContext) {
  const { projectId, onActivity } = context;

  const brandColors = async (): Promise<{ bg: string; fg: string }> => {
    const blueprint: Blueprint | null = await store.getCurrentBlueprint(projectId);
    const colors = blueprint?.company.brand.tokens.colors;
    return { bg: colors?.primary ?? "#0f2a4a", fg: colors?.background ?? "#ffffff" };
  };

  const listImageSources = betaZodTool({
    name: "list_image_sources",
    description:
      "Find out where images can come from for this site: the imported design's own photographs and logos, what the company has uploaded, whether stock photography is available, and which sections take an image. Call this before promising an administrator any imagery.",
    inputSchema: z.object({}),
    run: async () => {
      onActivity("list_image_sources", "Checked what imagery is available");

      const uploaded = await assets.list(projectId);
      const stock = getStockProvider();
      const design = await store.getDesign(projectId);
      // Renders of whole frames are reference material for the fidelity
      // review, not content — offering one as a section image would put a
      // picture of the page inside the page.
      const fromDesign = (design?.assets ?? []).filter((asset) => asset.kind !== "export");

      const slots = Object.entries(IMAGE_SLOTS)
        .map(([type, slot]) => `  ${type}: content key "${slot.key}" (${slot.orientation}) — ${slot.note}`)
        .join("\n");

      return [
        `FROM THE IMPORTED DESIGN (${fromDesign.length}):`,
        fromDesign.length > 0
          ? fromDesign
              .map(
                (asset) =>
                  `  ${asset.url} — ${asset.kind === "svg" ? "icon or logo" : "photograph"} (${asset.format || "image"}) from the frame “${asset.frameName}”`,
              )
              .join("\n")
          : design
            ? "  none. This design carried no images the importer could extract, so dress the site from the sources below."
            : "  no design imported. This project was started from the base site, or predates image import.",
        "",
        "These are the design's own files, already hosted by this project. They are the best imagery available — use them before anything below, and re-import the design if you need more of them.",
        "",
        `UPLOADED BY THE COMPANY (${uploaded.length}):`,
        uploaded.length > 0
          ? uploaded
              .map((asset) => `  ${asset.url} — ${asset.alt || "no description"} (${Math.round(asset.bytes / 1024)}KB)`)
              .join("\n")
          : "  none yet. The administrator can upload from the studio; these are preferable to stock.",
        "",
        `STOCK PHOTOGRAPHY: ${
          stock.configured
            ? `available via ${stock.name}. Use search_stock_images.`
            : "not configured. Do not promise stock photography; use placeholders or ask the administrator to upload."
        }`,
        "",
        "PLACEHOLDERS: always available via create_placeholder_image. Drawn in the site's own brand colours.",
        "",
        "SECTIONS THAT TAKE AN IMAGE:",
        slots,
        "",
        "Never write an image URL you did not get from one of these tools.",
      ].join("\n");
    },
  });

  const searchStockImages = betaZodTool({
    name: "search_stock_images",
    description:
      "Search stock photography for a section. Returns real, licensed image URLs with the attribution the licence requires. Only works when a stock provider is configured — check list_image_sources first.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("what the photo should show, e.g. 'engineering team collaborating in a bright office'"),
      orientation: z
        .enum(["landscape", "portrait", "square", "any"])
        .describe("landscape for heroes and banners, portrait for people, square for logos"),
      count: z.number().int().min(1).max(10).optional(),
    }),
    run: async ({ query, orientation, count }) => {
      const stock = getStockProvider();
      if (!stock.configured) {
        return "No stock photography provider is configured (set UNSPLASH_ACCESS_KEY or PEXELS_API_KEY). Use create_placeholder_image instead, or ask the administrator to upload their own photographs — which is the better result anyway.";
      }

      onActivity("search_stock_images", `Searched ${stock.name} for “${query}”`);

      try {
        const results = await stock.search(query, { orientation, count: count ?? 5 });
        if (results.length === 0) return `No ${stock.name} results for "${query}". Try a broader description.`;

        return [
          `${results.length} result(s) from ${stock.name}:`,
          ...results.map(describe),
          "",
          "To use one, call set_section_image with its URL. Pass the credit exactly as shown — both licences require attribution on display.",
        ].join("\n");
      } catch (error) {
        return `Stock search failed: ${error instanceof Error ? error.message : String(error)}. Fall back to create_placeholder_image.`;
      }
    },
  });

  const createPlaceholder = betaZodTool({
    name: "create_placeholder_image",
    description:
      "Generate a branded placeholder for a section that has no photograph yet. Uses the site's own colours, and labels what belongs there. Always available — no credentials needed.",
    inputSchema: z.object({
      label: z.string().describe("what should eventually go here, e.g. 'Engineering team photo'"),
      orientation: z.enum(["landscape", "portrait", "square", "any"]),
    }),
    run: async ({ label, orientation }) => {
      const { bg, fg } = await brandColors();
      const size = SLOT_SIZES[orientation];
      const url = `/api/placeholder?w=${size.w}&h=${size.h}&label=${encodeURIComponent(label)}&bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(fg)}`;

      onActivity("create_placeholder_image", `Made a branded placeholder for “${label}”`);
      return `${url}\n\nUse this with set_section_image. Tell the administrator it is a placeholder and that uploading a real photograph will look considerably better.`;
    },
  });

  const setSectionImage = betaZodTool({
    name: "set_section_image",
    description:
      "Put an image into a section, with its alt text and any required credit. The URL must have come from list_image_sources, search_stock_images or create_placeholder_image. Saves a new version.",
    inputSchema: z.object({
      sectionId: z.string(),
      url: z.string().describe("the image URL, exactly as a source tool returned it"),
      alt: z
        .string()
        .describe("what the image shows, for screen readers. Describe the content, never 'image of…'"),
      itemIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("for sections with a list — employee stories, teams, locations — which item to set"),
      creditText: z
        .string()
        .optional()
        .describe("attribution line, when the source returned one"),
      creditUrl: z.string().optional(),
    }),
    run: async ({ sectionId, url, alt, itemIndex, creditText, creditUrl }) => {
      const blueprint = await store.getCurrentBlueprint(projectId);
      if (!blueprint) return "This project has no site blueprint yet.";

      // The whole point of the capability is that URLs are traceable. Anything
      // outside the sanctioned sources is refused rather than silently written.
      const isOwn = url.startsWith(`/api/projects/${projectId}/assets/`);
      const isPlaceholder = url.startsWith("/api/placeholder?");
      const isStock = /^https:\/\/(images\.unsplash\.com|images\.pexels\.com)\//.test(url);
      if (!isOwn && !isPlaceholder && !isStock) {
        return `Refusing to set "${url}". Image URLs must come from list_image_sources, search_stock_images or create_placeholder_image — not from memory or a guess.`;
      }
      if (!alt.trim()) {
        return "Every image needs alt text describing what it shows. Add one and call again.";
      }

      let found: { pageName: string; section: (typeof blueprint.pages)[number]["sections"][number] } | null = null;
      for (const page of blueprint.pages) {
        const section = page.sections.find((candidate) => candidate.id === sectionId);
        if (section) found = { pageName: page.name, section };
      }
      if (!found) return `No section "${sectionId}". Call get_blueprint for the real ids.`;

      const slot = IMAGE_SLOTS[found.section.type];
      if (!slot) {
        return `"${found.section.label}" does not display an image. Sections that do: ${Object.keys(IMAGE_SLOTS).join(", ")}.`;
      }

      const content = { ...found.section.content } as Record<string, unknown>;
      const credit = creditText ? { text: creditText, url: creditUrl ?? "" } : undefined;

      if (itemIndex === undefined) {
        content[slot.key] = url;
        content[`${slot.key}Alt`] = alt;
        if (credit) content[`${slot.key}Credit`] = credit;
      } else {
        // Per-item imagery: employee photos, team tiles, location cards.
        const items = Array.isArray(content["items"]) ? [...(content["items"] as Record<string, unknown>[])] : [];
        if (itemIndex >= items.length) {
          return `"${found.section.label}" has ${items.length} item(s); there is no item ${itemIndex}.`;
        }
        items[itemIndex] = {
          ...items[itemIndex],
          [slot.key]: url,
          [`${slot.key}Alt`]: alt,
          ...(credit ? { [`${slot.key}Credit`]: credit } : {}),
        };
        content["items"] = items;
      }

      const updated = structuredClone(blueprint);
      for (const page of updated.pages) {
        const section = page.sections.find((candidate) => candidate.id === sectionId);
        if (section) section.content = content;
      }

      const where = itemIndex === undefined ? "" : ` (item ${itemIndex + 1})`;
      const summary = `Set the image on "${found.section.label}"${where}`;
      const version = await store.saveVersion(projectId, {
        blueprint: updated,
        summary,
        operations: [{ op: "set_section_image", sectionId, url, alt, itemIndex }],
      });

      onActivity("set_section_image", `${summary} (version ${version.version})`);
      return `${summary}. Saved as version ${version.version}${
        isPlaceholder ? " — this is a placeholder, so say so." : ""
      }`;
    },
  });

  return [listImageSources, searchStockImages, createPlaceholder, setSectionImage];
}
