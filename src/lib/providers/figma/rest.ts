import { MAX_UPLOAD_BYTES, assets } from "@/lib/store/assets";
import {
  type DesignDocument,
  type DesignFrame,
  type DesignNode,
  type DesignRect,
  type DesignStyles,
  type FigmaProvider,
  rgbaToHex,
} from "./types";

/**
 * Figma REST backend.
 *
 * Works headless with a personal access token, which makes it the backend that
 * survives CI and a demo laptop that is not running the Figma desktop app. The
 * MCP backend gives richer semantics when it is available; this one gives
 * reliability.
 */

const API = "https://api.figma.com/v1";

/** Beyond this the tree is layout minutiae, not page structure. */
const MAX_DEPTH = 6;
/** Guards against a pathological file blowing out the analyzer's context. */
const MAX_NODES = 4000;

interface FigmaRestNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: DesignRect | null;
  characters?: string;
  fills?: { type: string; color?: { r: number; g: number; b: number }; opacity?: number; visible?: boolean; imageRef?: string }[];
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number };
  cornerRadius?: number;
  componentId?: string;
  children?: FigmaRestNode[];
  visible?: boolean;
}

export class FigmaRestProvider implements FigmaProvider {
  readonly backend = "rest" as const;

  private readonly token: string;

  constructor(token: string) {
    if (!token) throw new Error("FIGMA_TOKEN is required for the Figma REST backend");
    this.token = token;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      headers: { "X-Figma-Token": this.token },
      // Figma is slow on large files; the caller shows a progress state.
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Figma API ${response.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async fetchDesign(fileKey: string, nodeId?: string, projectId?: string): Promise<DesignDocument> {
    const warnings: string[] = [];
    let nodeCount = 0;

    const toNode = (raw: FigmaRestNode, depth: number): DesignNode | null => {
      if (raw.visible === false) return null;
      if (nodeCount >= MAX_NODES) return null;
      nodeCount += 1;

      const solidFills = (raw.fills ?? [])
        .filter((f) => f.visible !== false && f.type === "SOLID" && f.color)
        .map((f) => rgbaToHex({ ...f.color!, a: f.opacity }));

      const hasImageFill = (raw.fills ?? []).some((f) => f.type === "IMAGE" && f.visible !== false);

      const node: DesignNode = {
        id: raw.id,
        name: raw.name,
        type: raw.type,
        bounds: raw.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        ...(raw.characters ? { text: raw.characters } : {}),
        ...(solidFills.length > 0 ? { fills: solidFills } : {}),
        ...(raw.style?.fontFamily ? { fontFamily: raw.style.fontFamily } : {}),
        ...(raw.style?.fontSize ? { fontSize: raw.style.fontSize } : {}),
        ...(raw.style?.fontWeight ? { fontWeight: raw.style.fontWeight } : {}),
        ...(raw.cornerRadius !== undefined ? { cornerRadius: raw.cornerRadius } : {}),
        // Image fills are resolved to real URLs below, in one batched call.
        ...(hasImageFill ? { imageUrl: "" } : {}),
      };

      if (raw.children && depth < MAX_DEPTH) {
        const children = raw.children
          .map((child) => toNode(child, depth + 1))
          .filter((c): c is DesignNode => c !== null);
        if (children.length > 0) node.children = children;
      } else if (raw.children && raw.children.length > 0) {
        warnings.push(`"${raw.name}" was truncated at depth ${MAX_DEPTH}`);
      }

      return node;
    };

    // Scoping to a node keeps large multi-flow files manageable.
    let fileName: string;
    let lastModified: string;
    let topLevel: FigmaRestNode[];

    if (nodeId) {
      const data = await this.get<{
        name: string;
        lastModified: string;
        nodes: Record<string, { document: FigmaRestNode } | null>;
      }>(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${MAX_DEPTH}`);
      fileName = data.name;
      lastModified = data.lastModified;
      const entry = data.nodes[nodeId];
      if (!entry) throw new Error(`Figma node ${nodeId} not found in file ${fileKey}`);
      topLevel = [entry.document];
    } else {
      const data = await this.get<{
        name: string;
        lastModified: string;
        document: FigmaRestNode;
      }>(`/files/${fileKey}?depth=${MAX_DEPTH}`);
      fileName = data.name;
      lastModified = data.lastModified;
      // document -> CANVAS pages -> frames. We want the frames.
      topLevel = (data.document.children ?? []).flatMap((canvas) => canvas.children ?? []);
    }

    // Only frame-like top-level nodes are screens; ignore stray notes and shapes.
    const frames: DesignFrame[] = topLevel
      .filter((n) => ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "GROUP"].includes(n.type))
      .map((raw) => {
        const node = toNode(raw, 0);
        return node
          ? { id: node.id, name: node.name, bounds: node.bounds, children: node.children ?? [] }
          : null;
      })
      .filter((f): f is DesignFrame => f !== null)
      // Designers lay screens out left-to-right; that order is usually the flow.
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);

    if (frames.length === 0) {
      warnings.push("No top-level frames found — is this file a component library?");
    }

    const rendered = await this.renderFrames(fileKey, frames.map((f) => f.id), warnings);
    // Figma's render URLs are signed S3 links that stop resolving well before
    // anyone opens the fidelity review, so the bytes are pulled across into the
    // asset store here, while they are still live.
    const images = projectId
      ? await persistDesignImages(projectId, rendered, warnings, (id) =>
          frames.find((f) => f.id === id)?.name ?? id,
        )
      : {};
    if (!projectId && Object.keys(rendered).length > 0) {
      warnings.push(
        "Frame previews were rendered but not stored: this import had no project to store them against.",
      );
    }
    const styles = collectStyles(frames);

    return {
      fileKey,
      fileName,
      lastModified,
      backend: this.backend,
      frames,
      styles,
      images,
      warnings,
    };
  }

  /** One batched render call; a failure here degrades fidelity, not the import. */
  private async renderFrames(
    fileKey: string,
    ids: string[],
    warnings: string[],
  ): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    try {
      const data = await this.get<{ images: Record<string, string | null>; err?: string }>(
        `/images/${fileKey}?ids=${ids.map(encodeURIComponent).join(",")}&format=png&scale=1`,
      );
      return Object.fromEntries(
        Object.entries(data.images ?? {}).filter(([, url]) => Boolean(url)) as [string, string][],
      );
    } catch (error) {
      warnings.push(
        `Frame previews unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }
}

/**
 * Derives the design's palette and type ramp from actual usage.
 *
 * Figma's published styles are often incomplete or absent in files that were
 * not built as a design system, so counting real usage is more reliable than
 * reading `/v1/files/:key/styles`.
 */
export function collectStyles(frames: DesignFrame[]): DesignStyles {
  const colorCounts = new Map<string, number>();
  const textStyles = new Map<string, { fontFamily: string; fontSize: number; fontWeight: number; count: number }>();

  const walk = (node: DesignNode) => {
    for (const hex of node.fills ?? []) {
      colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
    }
    if (node.type === "TEXT" && node.fontSize) {
      const key = `${node.fontFamily ?? "unknown"}/${node.fontSize}/${node.fontWeight ?? 400}`;
      const existing = textStyles.get(key);
      if (existing) existing.count += 1;
      else
        textStyles.set(key, {
          fontFamily: node.fontFamily ?? "unknown",
          fontSize: node.fontSize,
          fontWeight: node.fontWeight ?? 400,
          count: 1,
        });
    }
    for (const child of node.children ?? []) walk(child);
  };

  for (const frame of frames) for (const child of frame.children) walk(child);

  return {
    colors: [...colorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([hex], index) => ({ name: `color-${index + 1}`, hex })),
    text: [...textStyles.values()]
      .sort((a, b) => b.fontSize - a.fontSize)
      .slice(0, 8)
      .map((style, index) => ({
        name: `text-${index + 1}`,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      })),
  };
}

/**
 * Moves rendered frame PNGs into the project's asset store.
 *
 * Shared by all three backends rather than living in one of them: whichever
 * backend produced the design, the fidelity review reads `images` back hours
 * later and every transport hands us something that does not survive that
 * long — a signed S3 link from REST, an in-memory blob from MCP.
 *
 * Nothing in here is allowed to fail an import. A design that arrived without
 * its pictures is still a design; a review with no reference image says so in
 * plain English instead.
 *
 * @param altFor Optional layer-name lookup, so the stored asset carries the
 *   Figma name an admin would recognise rather than a bare node id.
 */
export async function persistDesignImages(
  projectId: string,
  images: Record<string, string>,
  warnings: string[],
  altFor?: (nodeId: string) => string,
): Promise<Record<string, string>> {
  const entries = Object.entries(images).filter(([, url]) => Boolean(url));
  if (entries.length === 0 || !projectId) return {};

  const stored: Record<string, string> = {};
  // Sequential on purpose: a dozen full-page PNGs downloaded at once is enough
  // to make a laptop-sized import feel like it has hung.
  for (const [nodeId, url] of entries) {
    // Already ours — re-importing a design must not re-download our own files.
    if (url.startsWith("/api/projects/")) {
      stored[nodeId] = url;
      continue;
    }
    const saved = await persistDesignImage(
      projectId,
      url,
      `Figma frame “${altFor?.(nodeId) ?? nodeId}”`,
      warnings,
    );
    if (saved) stored[nodeId] = saved;
  }
  return stored;
}

/** One frame. Returns "" when the bytes could not be fetched or stored. */
export async function persistDesignImage(
  projectId: string,
  url: string,
  alt: string,
  warnings: string[],
): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    return await storeDesignImage(projectId, data, response.headers.get("content-type"), alt, warnings);
  } catch (error) {
    warnings.push(
      `Could not store the reference image for ${alt}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/**
 * Stores image bytes we already hold — the MCP backend returns base64 rather
 * than a URL, and the mock backend draws its own.
 */
export async function storeDesignImage(
  projectId: string,
  data: Uint8Array,
  contentType: string | null | undefined,
  alt: string,
  warnings: string[],
): Promise<string> {
  // A tall careers frame renders large; the asset store's ceiling is a real
  // limit, and blowing past it should cost one picture, not the import.
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    warnings.push(
      `Reference image for ${alt} is ${Math.round(data.byteLength / 1024)}KB, over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB asset limit — skipped.`,
    );
    return "";
  }

  // Figma answers `format=png` with PNG, but a proxy or a CDN in front of it
  // can send back `application/octet-stream`, which the asset store rejects.
  // The bytes themselves are the honest answer.
  const type = sniffImageType(data) ?? (contentType ?? "").split(";")[0].trim();
  if (!assets.isAllowed(type)) {
    warnings.push(`Reference image for ${alt} was ${type || "an unknown type"}, not an image — skipped.`);
    return "";
  }

  try {
    const saved = await assets.save(projectId, { data, contentType: type, alt });
    return saved.url;
  } catch (error) {
    warnings.push(
      `Could not store the reference image for ${alt}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/** Magic-byte sniff, limited to what the asset store will accept. */
export function sniffImageType(data: Uint8Array): string | null {
  const at = (index: number) => data[index];
  if (data.length < 12) return null;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  // RIFF....WEBP
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(data.slice(0, 256)).trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}
