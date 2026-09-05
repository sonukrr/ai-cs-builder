import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { store } from "@/lib/store/store";
import { applyOperations, BlueprintOperation } from "@/lib/blueprint/operations";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import type { DesignDocument, DesignFrame, DesignNode } from "@/lib/providers/figma/types";
import type { Section } from "@/lib/blueprint/schema";

/**
 * The design-replica tools.
 *
 * The importer maps a band of a design onto an approved component or onto one
 * of the fixed static section types, and the fixed types are the ceiling on
 * fidelity: a band that is neither a hero nor a FAQ gets flattened into the
 * nearest shape or dropped. These two tools are the way past that ceiling for
 * bands that carry no behaviour — the agent reads the real geometry of one node
 * and writes an HTML/CSS replica of it.
 *
 * They are split from tools.ts because they share a constraint the others do
 * not. Everything else the agent writes is a value in a schema somebody else
 * validated; this is markup, and markup can lie. So `set_custom_html` never
 * writes to the blueprint itself — it goes through the same `applyOperations`
 * path as every other edit, where the sanitizer runs, and its job here is to
 * relay what that sanitizer said back to the model in words it can act on.
 */

export interface DesignToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

/** Levels of the subtree printed. Deeper than this is usually icon internals. */
const MAX_DEPTH = 6;
/** Nodes printed. Roughly 6KB of output at the worst case, which is the point. */
const MAX_NODES = 110;
const MAX_TEXT_LENGTH = 220;
const MAX_IMAGES = 12;
const MAX_PALETTE = 10;
const MAX_TYPE_STYLES = 8;

interface Entry {
  node: DesignNode;
  depth: number;
  parent: Entry | null;
  kids: Entry[];
  /** Children not walked because the depth cap was reached. */
  unwalked: number;
  weight: number;
  shown: boolean;
}

/**
 * What is worth printing when the budget runs out.
 *
 * Copy first, and the longest copy first: a headline is what a replica is built
 * around, while a node named "Rectangle 47" with no paint teaches nothing. An
 * image is worth roughly a long headline because a missing one leaves a hole
 * the replica cannot fill from anywhere else.
 */
function weigh(node: DesignNode): number {
  return (
    (node.text?.trim().length ?? 0) * 3 +
    (node.imageUrl ? 400 : 0) +
    (node.componentName ? 120 : 0) +
    (node.fills?.length ? 60 : 0) +
    (node.cornerRadius ? 20 : 0) +
    Math.min(Math.round((node.bounds.width * node.bounds.height) / 4000), 80)
  );
}

function collect(
  node: DesignNode,
  depth: number,
  parent: Entry | null,
  out: Entry[],
): Entry {
  const entry: Entry = { node, depth, parent, kids: [], unwalked: 0, weight: weigh(node), shown: false };
  out.push(entry);
  const children = node.children ?? [];
  if (depth >= MAX_DEPTH) {
    entry.unwalked = children.length;
    return entry;
  }
  for (const child of children) entry.kids.push(collect(child, depth + 1, entry, out));
  return entry;
}

/** A frame is a node for describing purposes; the caller may name either. */
function frameAsNode(frame: DesignFrame): DesignNode {
  return { id: frame.id, name: frame.name, type: "FRAME", bounds: frame.bounds, children: frame.children };
}

function locate(
  design: DesignDocument,
  ref: string,
): { node: DesignNode; frame: DesignFrame } | null {
  for (const frame of design.frames) {
    if (frame.id === ref) return { node: frameAsNode(frame), frame };
    const stack: DesignNode[] = [...frame.children];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.id === ref) return { node, frame };
      for (const child of node.children ?? []) stack.push(child);
    }
  }
  return null;
}

function typeOf(node: DesignNode): string | null {
  if (!node.fontSize && !node.fontFamily) return null;
  const size = node.fontSize ? `${node.fontSize}px` : "size unknown";
  // Naming a family the file never gave us would be worse than saying nothing:
  // the agent would write it into a font-family and it would not resolve.
  return node.fontFamily ? `${node.fontFamily} ${size}/${node.fontWeight ?? 400}` : `${size}/${node.fontWeight ?? 400}`;
}

/** One node as a line dense enough to write the CSS rule straight from. */
function renderEntry(entry: Entry, originX: number, originY: number): string[] {
  const { node } = entry;
  const indent = "  ".repeat(entry.depth);
  const parts = [
    `${indent}${node.id} ${node.type} "${node.name}" ${node.bounds.width}×${node.bounds.height} at ${
      node.bounds.x - originX
    },${node.bounds.y - originY}`,
  ];

  const detail: string[] = [];
  const font = typeOf(node);
  if (font) detail.push(font);
  // On a TEXT node the fill is the colour of the letters, which is a different
  // CSS property from every other node's fill, so it is named differently here.
  if (node.fills?.length) detail.push(`${node.type === "TEXT" ? "colour" : "fill"} ${node.fills.join(" ")}`);
  if (node.cornerRadius) detail.push(`radius ${node.cornerRadius}`);
  if (node.componentName) detail.push(`component "${node.componentName}"`);
  if (node.imageUrl) detail.push("has an image");

  const hidden = entry.kids.filter((kid) => !kid.shown).length + entry.unwalked;
  if (hidden > 0) detail.push(`+${hidden} more inside — describe_design_node on ${node.id} to expand`);
  if (detail.length > 0) parts.push(` · ${detail.join(" · ")}`);

  const lines = [parts.join("")];
  const text = node.text?.trim();
  if (text) lines.push(`${indent}  “${text.slice(0, MAX_TEXT_LENGTH)}${text.length > MAX_TEXT_LENGTH ? "…" : ""}”`);
  return lines;
}

function describeSubtree(node: DesignNode, frame: DesignFrame, warnings: string[]): string {
  const entries: Entry[] = [];
  const root = collect(node, 0, null, entries);
  root.shown = true;

  // Ancestors are printed whether or not they earned their place, because a
  // line with no parent above it has no position on the page.
  let budget = MAX_NODES - 1;
  for (const entry of [...entries].sort((a, b) => b.weight - a.weight)) {
    if (budget <= 0) break;
    const chain: Entry[] = [];
    for (let cursor: Entry | null = entry; cursor && !cursor.shown; cursor = cursor.parent) {
      chain.push(cursor);
    }
    if (chain.length === 0 || chain.length > budget) continue;
    for (const link of chain) link.shown = true;
    budget -= chain.length;
  }

  const shown = entries.filter((entry) => entry.shown);
  const omitted = entries.length - shown.length;

  const palette = new Map<string, number>();
  const typeStyles = new Map<string, number>();
  const images: DesignNode[] = [];
  for (const { node: candidate } of entries) {
    for (const fill of candidate.fills ?? []) palette.set(fill, (palette.get(fill) ?? 0) + 1);
    const font = typeOf(candidate);
    if (font) typeStyles.set(font, (typeStyles.get(font) ?? 0) + 1);
    if (candidate.imageUrl) images.push(candidate);
  }

  const rank = (map: Map<string, number>, limit: number) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  const own = [
    node.fills?.length ? `background ${node.fills.join(" ")}` : null,
    node.cornerRadius ? `corner radius ${node.cornerRadius}` : null,
    node.componentName ? `Figma component "${node.componentName}"` : null,
  ].filter(Boolean);

  const lines = [
    `DESIGN NODE ${node.id} — "${node.name}" (${node.type}), ${node.bounds.width}×${node.bounds.height}px.`,
    node.id === frame.id
      ? `This is a whole screen, ${Math.round(frame.bounds.width)}px wide. Its top-level children are the bands of the page.`
      : `It sits in frame "${frame.name}" (${frame.id}, ${Math.round(frame.bounds.width)}px wide) at x ${
          node.bounds.x - Math.round(frame.bounds.x)
        }, y ${node.bounds.y - Math.round(frame.bounds.y)}.`,
    own.length > 0 ? `This node itself: ${own.join(" · ")}.` : "This node itself has no fill of its own — it inherits the page background.",
    "",
    `CONTENTS — x,y are offsets from this node's top-left, so a child at 120,0 is 120px in. ${shown.length} of ${entries.length} nodes shown.`,
  ];

  for (const entry of shown) {
    if (entry === root) continue;
    lines.push(...renderEntry(entry, node.bounds.x, node.bounds.y));
  }
  if (shown.length === 1) lines.push("  (nothing inside it — this band is empty)");

  if (images.length > 0) {
    lines.push("", "IMAGES — these are the design's own assets. Use search_stock_images for a replacement photograph rather than linking a Figma URL:");
    for (const image of images.slice(0, MAX_IMAGES)) {
      lines.push(`  ${image.id} "${image.name}" ${image.bounds.width}×${image.bounds.height} → ${image.imageUrl}`);
    }
    if (images.length > MAX_IMAGES) lines.push(`  …and ${images.length - MAX_IMAGES} more.`);
  }

  if (palette.size > 0) {
    lines.push("", `COLOURS USED HERE: ${rank(palette, MAX_PALETTE).map(([hex, n]) => `${hex} ×${n}`).join(", ")}`);
  }
  if (typeStyles.size > 0) {
    lines.push(`TYPE USED HERE (family, then size/weight): ${rank(typeStyles, MAX_TYPE_STYLES).map(([style]) => style).join(", ")}`);
  }

  if (omitted > 0) {
    lines.push(
      "",
      `${omitted} node(s) were left out to keep this readable — the shortest copy and the smallest boxes go first. Call describe_design_node again on any id above to see inside it.`,
    );
  }
  if (warnings.length > 0) lines.push("", `NOTE FROM THE IMPORT: ${warnings.join(" | ")}`);

  return lines.join("\n");
}

/** Sections nest, so a replica target can sit inside a layout container. */
function findSection(sections: Section[], sectionId: string): Section | null {
  for (const section of sections) {
    if (section.id === sectionId) return section;
    const nested = findSection(section.children ?? [], sectionId);
    if (nested) return nested;
  }
  return null;
}

function listSectionIds(sections: Section[], out: string[] = []): string[] {
  for (const section of sections) {
    out.push(`${section.id} [${section.type}]`);
    listSectionIds(section.children ?? [], out);
  }
  return out;
}

export function buildDesignTools(context: DesignToolContext) {
  const { projectId, onActivity } = context;

  const describeDesignNode = betaZodTool({
    name: "describe_design_node",
    description:
      "Read one node of the imported Figma design as it actually looks: the box sizes and offsets, the fill colours, the fonts and sizes, the corner radii, the real copy and the images inside it. " +
      "This is for REPLICATING a band's appearance in HTML and CSS — it is not for deciding what a band is. What a band is comes from the plan and from search_components; a search box is a search box however it is drawn, and no amount of geometry makes it something you may hand-write. " +
      "Call this after you have decided a band is presentational, and before writing any markup for it: authoring from a layer name instead of from these numbers is how a replica ends up looking nothing like the design. " +
      "The ref is the Figma node id printed by the import as `node 1:23`, by the site plan as the section's origin, and by review_fidelity as a band's ref. A frame id works too. Output is capped, so call it again on a child id to see inside a node it summarised.",
    inputSchema: z.object({
      ref: z.string().describe("Figma node id, e.g. '1:23' — the band you are about to replicate"),
    }),
    run: async ({ ref }) => {
      const design = await store.getDesign(projectId);
      if (!design) {
        return "No Figma design is stored for this project. Either it was started from the base site rather than imported, or it was imported before designs were kept. Run import_figma again to store one — until then you cannot author a faithful replica, and you should say so rather than guessing at a band's appearance.";
      }

      const found = locate(design, ref.trim());
      if (!found) {
        const frames = design.frames
          .map((frame) => `  frame ${frame.id} "${frame.name}" — bands: ${frame.children.map((c) => c.id).join(", ") || "none"}`)
          .join("\n");
        return `No node "${ref}" in the imported design "${design.fileName}". Node ids look like "1:23". The frames and their top-level bands are:\n${frames}`;
      }

      onActivity("describe_design_node", `Read the design detail of “${found.node.name}”`);
      return describeSubtree(found.node, found.frame, design.warnings);
    },
  });

  const setCustomHtml = betaZodTool({
    name: "set_custom_html",
    description:
      "Write the HTML and CSS of a custom-html replica section, replacing whatever it held before. Use this for a band that is presentation only — a bespoke hero, a stats strip, an editorial block, an unusual footer — after describe_design_node has told you what it looks like. " +
      "Before you reach for it, work down this order: anything FUNCTIONAL (search, filtering, listings, pagination, apply, resume upload) is an approved component from search_components and must never be hand-written; a band that is only a WRAPPER around the bands below it is a layout container (row/stack/grid); a band that carries nothing — zero height, empty, or a duplicate of something you already built — is a record_unsupported and nothing else, because inventing copy to fill it is worse than leaving it out. Only what is left is a replica. " +
      "The section must already exist as type \"custom-html\", source \"custom\": add it with apply_operations first. " +
      "The markup is sanitized server-side before it is saved, and the sanitizer is not advisory — form, input, textarea, select, button, label and fieldset are REJECTED outright, because a hand-written search box that does not search is exactly the false claim the approved component catalog exists to prevent. A link styled as a button is fine; an <a> is honest about being a link. script, style, iframe, on* handlers and javascript:/data: URLs are rejected too. Anything the sanitizer changes or refuses comes back to you verbatim — read it and fix the markup rather than reporting success.",
    inputSchema: z.object({
      sectionId: z.string().describe("id of an existing custom-html section, from get_blueprint"),
      html: z
        .string()
        .describe(
          "the markup. No <style> and no <script> — CSS goes in the css field so it can be scoped. Put the design's real copy in it, taken from describe_design_node; never write filler. Image src must be a URL a tool gave you: search_stock_images, create_placeholder_image, or this project's own asset store.",
        ),
      css: z
        .string()
        .describe(
          "plain CSS for this section. Every selector is prefixed with the section's own id at save time, so write ordinary selectors (.hero-title, .stats li) and never target html, body, :root or *. @media is kept. No @import, no @font-face, no position: fixed.",
        ),
      note: z
        .string()
        .describe("one line naming the design band this replicates, e.g. 'Homepage band 3 — stats strip (node 1:24)'"),
      credits: z
        .array(z.object({ text: z.string(), url: z.string() }))
        .optional()
        .describe(
          "attribution for every stock photograph used, exactly as search_stock_images returned it. Both licences require it to be shown, and the renderers display it.",
        ),
    }),
    run: async ({ sectionId, html, css, note, credits }) => {
      const blueprint = await store.getCurrentBlueprint(projectId);
      if (!blueprint) return "This project has no site blueprint yet, so there is no section to write into.";

      let section: Section | null = null;
      for (const page of blueprint.pages) section = section ?? findSection(page.sections, sectionId);
      if (!section) {
        const ids = blueprint.pages
          .map((page) => `  ${page.id}: ${listSectionIds(page.sections).join(", ") || "(none)"}`)
          .join("\n");
        return [
          `No section "${sectionId}". Create it first with apply_operations, then call this again:`,
          `[{"op":"add_section","pageId":"<page>","id":"${sectionId}","type":"custom-html","source":"custom","label":"<what it is>","content":{},"props":{}}]`,
          `Existing sections:\n${ids}`,
        ].join("\n");
      }
      if (section.type !== "custom-html" || section.source !== "custom") {
        return `"${section.label}" (${sectionId}) is a ${section.source} section of type "${section.type}", not a custom-html replica. Replicas only go into sections added as type "custom-html", source "custom". Either name the right section, or remove this one and add a custom-html section in its place — do not try to write markup into a ${section.type}.`;
      }
      if (!html.trim()) {
        return "The html was empty. A replica with no markup renders nothing; if the band genuinely carries nothing, remove the section and record it with a record_unsupported operation instead of leaving an empty one on the page.";
      }

      // Attribution is a licence condition, not a nicety, and the agent is the
      // only place it can be caught — by the time the markup renders the credit
      // is either in `content.credits` or it is nowhere.
      const usesStock = /https:\/\/images\.(unsplash|pexels)\.com\//.test(html);
      if (usesStock && (credits === undefined || credits.length === 0)) {
        return "This markup uses a stock photograph but passes no credits. Both Unsplash and Pexels require attribution wherever the image is shown. Pass the credit line search_stock_images returned, exactly as it returned it, and call this again.";
      }

      const operation = BlueprintOperation.safeParse({
        op: "update_section",
        sectionId,
        content: { html, css, note, ...(credits ? { credits } : {}) },
      });
      if (!operation.success) {
        return `The replica could not be turned into an operation: ${operation.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`;
      }

      // Deliberately through applyOperations rather than writing content
      // directly: the sanitizer lives on that path, and a replica saved around
      // it would be the one piece of the blueprint nobody checked.
      const result = applyOperations(blueprint, [operation.data]);

      if (result.rejected.length > 0) {
        return [
          `NOT SAVED — "${section.label}" is unchanged. The markup was refused:`,
          ...result.rejected.map((rejection) => `  ${rejection.reason}`),
          "Fix the markup and call set_custom_html again. If something was refused because it is interactive — a form, an input, a button — that is not a style rule you can work around: find the approved component with search_components and add it instead.",
        ].join("\n");
      }

      const issues = validateBlueprint(result.blueprint);
      if (!isBuildable(issues)) {
        return [
          `NOT SAVED — the site would not be valid with this replica in it:`,
          ...issues.filter((issue) => issue.level === "error").map((issue) => `  ${issue.path}: ${issue.message}`),
        ].join("\n");
      }

      const version = await store.saveVersion(projectId, {
        blueprint: result.blueprint,
        summary: `Replicated ${note}`,
        operations: [operation.data as unknown as Record<string, unknown>],
      });

      // The operations layer owns the sanitizer and may report what it stripped
      // on a channel this file does not import a type for; read it if it is
      // there so drops reach the model rather than dying in a log.
      const reported = (result as { notes?: unknown }).notes;
      const sanitizerNotes = Array.isArray(reported) ? reported.filter((n): n is string => typeof n === "string") : [];

      let saved: Section | null = null;
      for (const page of result.blueprint.pages) saved = saved ?? findSection(page.sections, sectionId);
      const savedHtml = typeof saved?.content.html === "string" ? saved.content.html : "";
      const savedCss = typeof saved?.content.css === "string" ? saved.content.css : "";
      const rewritten = savedHtml !== html || savedCss !== css;

      onActivity("set_custom_html", `Replicated ${note} (version ${version.version})`);

      return [
        `Saved as version ${version.version}: "${section.label}" now renders your markup.`,
        rewritten
          ? `The sanitizer changed what you sent. This is what is actually on the page — check the replica still says what the design says, and re-send it if something you needed was removed:\n--- html\n${savedHtml.slice(0, 1500)}${savedHtml.length > 1500 ? "\n…(truncated)" : ""}\n--- css\n${savedCss.slice(0, 800)}${savedCss.length > 800 ? "\n…(truncated)" : ""}`
          : "The sanitizer passed the markup and the CSS through unchanged.",
        sanitizerNotes.length > 0 ? `Sanitizer:\n${sanitizerNotes.map((n) => `  ${n}`).join("\n")}` : null,
        credits && credits.length > 0
          ? `Attribution for ${credits.length} image(s) was stored and will be rendered with the section.`
          : null,
        "Tell the administrator this band is a hand-authored replica rather than a library component, so they know what they are approving.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  return [describeDesignNode, setCustomHtml];
}
