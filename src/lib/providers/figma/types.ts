/**
 * A design, normalized away from any one Figma transport.
 *
 * The REST API, the Dev Mode MCP server and the demo fixture all produce this
 * shape, so the semantic analysis in analyze.ts has exactly one input format to
 * reason about. Keeping the normalization here rather than in the analyzer is
 * what makes the three backends interchangeable.
 */

export interface DesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignNode {
  id: string;
  name: string;
  /** Figma node type: FRAME, GROUP, TEXT, RECTANGLE, COMPONENT, INSTANCE, ... */
  type: string;
  bounds: DesignRect;
  /** Text content, for TEXT nodes. */
  text?: string;
  /** Solid fill colours on this node, as hex. */
  fills?: string[];
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  cornerRadius?: number;
  /** Set when the node is an image fill or an exportable asset. */
  imageUrl?: string;
  /** The name of the Figma component this instance came from, if any. */
  componentName?: string;
  children?: DesignNode[];
}

/** A top-level frame — usually one screen, e.g. "Homepage" or "Job Listing". */
export interface DesignFrame {
  id: string;
  name: string;
  bounds: DesignRect;
  children: DesignNode[];
}

export interface DesignStyles {
  colors: { name: string; hex: string }[];
  text: { name: string; fontFamily: string; fontSize: number; fontWeight: number }[];
}

/**
 * A real file lifted out of the design and stored by the studio.
 *
 * `nodeId` is the band the file was found in, which is the whole point of this
 * shape: the importer maps a band onto a section, so an image attributed to a
 * band can be attached to that section automatically instead of waiting for
 * someone to place it by hand.
 *
 * Precision comes from how it is fetched, not from what Figma volunteers. The
 * asset tool reports the images found *anywhere in a node's subtree*, so asking
 * about a frame returns every picture on the page with no way to tell them
 * apart — the import therefore asks band by band. The same file can appear
 * under two bands (a logo in both header and footer) and is stored once and
 * listed twice, because the band is the part that differs.
 */
export interface DesignAsset {
  /** Stable studio URL — `/api/projects/:id/assets/:file`, never Figma's. */
  url: string;
  /**
   * `export` is a render of the frame itself, so it is reference rather than
   * content. `raw` is an original uploaded photograph, `svg` a vector layer
   * (icon or logo) — those two are the ones worth putting on a page.
   */
  kind: "export" | "raw" | "svg";
  /** The frame it was found under. */
  frameId: string;
  frameName: string;
  format: string;
  /** The band this was found in — or the frame itself, for an `export`. */
  nodeId: string;
}

export interface DesignDocument {
  fileKey: string;
  fileName: string;
  lastModified: string;
  /** Where this came from, so the studio can be honest about fidelity. */
  backend: "mcp" | "rest" | "mock";
  frames: DesignFrame[];
  styles: DesignStyles;
  /**
   * Rendered PNGs of top-level frames, keyed by node id, when available.
   *
   * These are stable studio URLs — `/api/projects/:id/assets/:file` — not the
   * URLs the backend originally got them from. Figma's render endpoint hands
   * back short-lived S3 links, so anything that reads a design back later (the
   * fidelity review, which happens after the build) would find them expired.
   * Passing `projectId` to `fetchDesign` makes the backend download the bytes
   * and put them in the content-addressed asset store instead, which is also
   * why the same node re-imported twice costs one file rather than two.
   */
  images: Record<string, string>;
  /**
   * The design's own photographs, icons and logos, already in the asset store.
   *
   * Empty unless the backend can extract them — the REST backend sees image
   * fills but cannot resolve the originals, and the Dev Mode server exposes no
   * asset tool. When this is populated the importer attaches these to the
   * sections their bands became, and the agent dresses anything left over from
   * here before reaching for stock photography.
   */
  assets?: DesignAsset[];
  /** Non-fatal problems, e.g. a frame that was too deep to fully traverse. */
  warnings: string[];
}

/** One node, rendered on demand rather than at import time. */
export interface DesignNodeRender {
  /** Stable studio URL — the render is stored, so asking twice is free. */
  url: string;
  warnings: string[];
}

/**
 * Figma's own generated markup for a node.
 *
 * Not something to ship: it is React-flavoured, references Figma's asset URLs
 * and knows nothing about this project's components or tokens. Its value is as
 * a starting point — the nesting, the spacing and the type scale are the
 * designer's real intent, which is a better basis for a replica than reading
 * coordinates off a list.
 */
export interface DesignNodeReference {
  code: string;
  warnings: string[];
}

export interface FigmaProvider {
  readonly backend: "mcp" | "rest" | "mock";
  /**
   * Fetches a design.
   *
   * @param fileKey Figma file key, from the URL: figma.com/design/<key>/...
   * @param nodeId  Optional node to scope the import to a single frame.
   * @param projectId Project to store frame renders against. Optional because
   *   not every caller has one (the smoke script, `figmaStatus`), but omitting
   *   it means `images` comes back empty or holding a URL that will expire —
   *   pass it from anywhere the import belongs to a project.
   */
  fetchDesign(fileKey: string, nodeId?: string, projectId?: string): Promise<DesignDocument>;

  /**
   * Renders one node, for a caller that wants to look at it.
   *
   * Optional because only a backend with a live connection to Figma can do it:
   * the import stores whole frames, and a band is a node inside one. A caller
   * that gets `undefined` here should fall back to the frame render rather than
   * treat it as an error.
   *
   * @param maxDimension Cap on the longer edge, in pixels. A full-page render
   *   is worth thousands of tokens to look at, so callers that are showing the
   *   result to a model should ask for less than the design's natural size.
   */
  renderNode?(
    fileKey: string,
    nodeId: string,
    projectId: string,
    maxDimension?: number,
  ): Promise<DesignNodeRender | null>;

  /** Figma's own markup for one node, when the backend can produce it. */
  referenceNode?(fileKey: string, nodeId: string): Promise<DesignNodeReference | null>;
}

/** Parses a Figma URL into a file key and optional node id. */
export function parseFigmaUrl(input: string): { fileKey: string; nodeId?: string } | null {
  const trimmed = input.trim();

  // A bare key: 22-ish alphanumerics, no slashes.
  if (/^[A-Za-z0-9]{10,64}$/.test(trimmed)) return { fileKey: trimmed };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;

  // Both /file/<key>/ (legacy) and /design/<key>/ (current) are in the wild.
  const match = url.pathname.match(/\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (!match) return null;

  // node-id arrives as "12:34" or, from the share button, "12-34".
  const rawNode = url.searchParams.get("node-id") ?? undefined;
  const nodeId = rawNode ? rawNode.replace(/-/g, ":") : undefined;

  return { fileKey: match[1], nodeId };
}

/** Figma colour channels are 0..1 floats; the blueprint stores hex. */
export function rgbaToHex(color: { r: number; g: number; b: number; a?: number }): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  // Only carry alpha when it is actually doing something.
  return color.a === undefined || color.a >= 0.999 ? base : `${base}${channel(color.a)}`;
}
