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

export interface DesignDocument {
  fileKey: string;
  fileName: string;
  lastModified: string;
  /** Where this came from, so the studio can be honest about fidelity. */
  backend: "mcp" | "rest" | "mock";
  frames: DesignFrame[];
  styles: DesignStyles;
  /** Rendered PNGs of top-level frames, keyed by node id, when available. */
  images: Record<string, string>;
  /** Non-fatal problems, e.g. a frame that was too deep to fully traverse. */
  warnings: string[];
}

export interface FigmaProvider {
  readonly backend: "mcp" | "rest" | "mock";
  /**
   * Fetches a design.
   *
   * @param fileKey Figma file key, from the URL: figma.com/design/<key>/...
   * @param nodeId  Optional node to scope the import to a single frame.
   */
  fetchDesign(fileKey: string, nodeId?: string): Promise<DesignDocument>;
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
