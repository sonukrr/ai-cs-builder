import type { DesignDocument, DesignFrame, DesignNode } from "./types";

/**
 * Compresses a design into something an LLM can reason about.
 *
 * A raw Figma file is tens of thousands of nodes of layout minutiae. What
 * decides whether a band of a page is a hero, a job search or a footer is
 * almost entirely: where it sits vertically, how tall it is, its background,
 * and the words inside it. So we flatten each frame into an ordered list of
 * "bands" carrying exactly that, and throw the geometry away.
 *
 * This is also the privacy and cost boundary — it is the only thing about the
 * design that ever leaves the process.
 */

export interface DesignBand {
  index: number;
  nodeId: string;
  /** The designer's layer name. Often unhelpful; included as a weak signal. */
  layerName: string;
  heightPx: number;
  background?: string;
  /** Every string in the band, in reading order, longest kept first. */
  text: string[];
  /** Structural tells: how many of each interactive-looking thing is inside. */
  counts: {
    textNodes: number;
    images: number;
    /** Rectangles roughly input-shaped: wide, 40-72px tall. */
    inputLike: number;
    /** Instances of a component whose name mentions a button. */
    buttonLike: number;
    /** Repeated sibling subtrees — the signal for lists, grids and cards. */
    repeatedGroups: number;
  };
  /** Names of Figma components instantiated inside, if the file uses them. */
  componentNames: string[];
}

export interface DesignSummary {
  fileName: string;
  backend: string;
  palette: { hex: string; name: string }[];
  typeRamp: { fontFamily: string; fontSize: number; fontWeight: number }[];
  frames: { id: string; name: string; widthPx: number; bands: DesignBand[] }[];
  warnings: string[];
}

const MAX_STRINGS_PER_BAND = 14;
const MAX_STRING_LENGTH = 160;

function collectText(node: DesignNode, out: string[]): void {
  if (node.text?.trim()) out.push(node.text.trim().slice(0, MAX_STRING_LENGTH));
  for (const child of node.children ?? []) collectText(child, out);
}

function walk(node: DesignNode, visit: (n: DesignNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Two subtrees are "the same shape" if their type skeletons match. */
function skeleton(node: DesignNode, depth = 0): string {
  if (depth > 2) return node.type;
  const children = (node.children ?? []).map((c) => skeleton(c, depth + 1)).join(",");
  return children ? `${node.type}(${children})` : node.type;
}

function countRepeatedGroups(node: DesignNode): number {
  const shapes = new Map<string, number>();
  for (const child of node.children ?? []) {
    if (!child.children || child.children.length === 0) continue;
    const key = skeleton(child);
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  // A card grid shows up as 3+ siblings with identical skeletons.
  return Math.max(0, ...[...shapes.values()].filter((n) => n >= 2));
}

function bandOf(node: DesignNode, index: number): DesignBand {
  const text: string[] = [];
  collectText(node, text);

  let textNodes = 0;
  let images = 0;
  let inputLike = 0;
  let buttonLike = 0;
  const componentNames = new Set<string>();

  walk(node, (n) => {
    if (n.type === "TEXT") textNodes += 1;
    if (n.imageUrl !== undefined || /image|photo|avatar|logo|illustration/i.test(n.name)) images += 1;
    if (n.componentName) componentNames.add(n.componentName);

    // Naming beats geometry. A layer called "Button / Primary" is a button
    // whatever its box says, and checking shape first would misread every
    // full-width button as a search field.
    const named = `${n.name} ${n.componentName ?? ""}`;
    if (/\bbutton\b|\bcta\b|\bbtn\b/i.test(named)) {
      buttonLike += 1;
      return;
    }
    if (/input|search box|field|text ?box|placeholder/i.test(named)) {
      inputLike += 1;
      return;
    }

    // Otherwise only a bare rectangle of input proportions counts. Frames of
    // that height are usually bars and rails, not fields.
    const { width, height } = n.bounds;
    if (n.type === "RECTANGLE" && height >= 36 && height <= 72 && width >= 240) {
      inputLike += 1;
    }
  });

  // Keep the longest strings: headlines and body copy carry the meaning, while
  // one-word labels ("1", "2", "Next") mostly add noise.
  const ranked = [...new Set(text)].sort((a, b) => b.length - a.length).slice(0, MAX_STRINGS_PER_BAND);
  // ...but restore reading order, which is itself a signal.
  const kept = text.filter((t, i) => ranked.includes(t) && text.indexOf(t) === i);

  return {
    index,
    nodeId: node.id,
    layerName: node.name,
    heightPx: Math.round(node.bounds.height),
    background: node.fills?.[0],
    text: kept,
    counts: { textNodes, images, inputLike, buttonLike, repeatedGroups: countRepeatedGroups(node) },
    componentNames: [...componentNames].slice(0, 6),
  };
}

function bandsOf(frame: DesignFrame): DesignBand[] {
  const children = [...frame.children];

  // Prefer visual order when the coordinates are meaningful. Some backends
  // (and auto-layout frames) report every child at y=0, in which case the array
  // order is the layout order and sorting would scramble it.
  const ys = new Set(children.map((c) => Math.round(c.bounds.y)));
  if (ys.size > 1) children.sort((a, b) => a.bounds.y - b.bounds.y);

  return children.map((child, index) => bandOf(child, index));
}

export function summarizeDesign(design: DesignDocument): DesignSummary {
  return {
    fileName: design.fileName,
    backend: design.backend,
    palette: design.styles.colors.map((c) => ({ hex: c.hex, name: c.name })),
    typeRamp: design.styles.text.map((t) => ({
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      fontWeight: t.fontWeight,
    })),
    frames: design.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      widthPx: Math.round(frame.bounds.width),
      bands: bandsOf(frame),
    })),
    warnings: design.warnings,
  };
}

/** Renders the summary as prose. Cheaper in tokens than the equivalent JSON. */
export function renderSummary(summary: DesignSummary): string {
  const lines: string[] = [];
  lines.push(`FIGMA FILE: ${summary.fileName} (via ${summary.backend})`);

  if (summary.palette.length > 0) {
    lines.push(`PALETTE (most used first): ${summary.palette.map((c) => c.hex).join(", ")}`);
  }
  if (summary.typeRamp.length > 0) {
    lines.push(
      `TYPE RAMP: ${summary.typeRamp.map((t) => `${t.fontFamily} ${t.fontSize}px/${t.fontWeight}`).join(", ")}`,
    );
  }

  for (const frame of summary.frames) {
    lines.push("", `FRAME "${frame.name}" (id ${frame.id}, ${frame.widthPx}px wide)`);
    for (const band of frame.bands) {
      const tells = [
        `${band.heightPx}px tall`,
        band.background ? `bg ${band.background}` : null,
        band.counts.textNodes > 0 ? `${band.counts.textNodes} text` : null,
        band.counts.images > 0 ? `${band.counts.images} image` : null,
        band.counts.inputLike > 0 ? `${band.counts.inputLike} input-like` : null,
        band.counts.buttonLike > 0 ? `${band.counts.buttonLike} button-like` : null,
        band.counts.repeatedGroups >= 2 ? `${band.counts.repeatedGroups} repeated items` : null,
        band.componentNames.length > 0 ? `components: ${band.componentNames.join("/")}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      lines.push(`  [${band.index}] node ${band.nodeId} layer "${band.layerName}" — ${tells}`);
      for (const text of band.text) lines.push(`        "${text}"`);
    }
  }

  if (summary.warnings.length > 0) {
    lines.push("", `IMPORT WARNINGS: ${summary.warnings.join(" | ")}`);
  }

  return lines.join("\n");
}
