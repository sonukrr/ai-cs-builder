import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  DesignDocument,
  DesignFrame,
  DesignNode,
  FigmaProvider,
} from "./types";
import { collectStyles, persistDesignImage, storeDesignImage } from "./rest";

/**
 * Figma Dev Mode MCP backend.
 *
 * The Dev Mode MCP server runs locally inside the Figma desktop app
 * (Preferences -> Enable Dev Mode MCP Server) and serves on
 * http://127.0.0.1:3845/mcp. It is the richest source we have: it exposes the
 * designer's own variables and component names rather than making us infer
 * them from geometry.
 *
 * Two things make this backend defensive by design. Figma has renamed its MCP
 * tools across releases (`get_metadata` / `get_design_context` / `get_code`),
 * so we discover the tool list at connect time and match by intent rather than
 * hardcoding a name. And the server only serves the *current selection or a
 * node in the open file*, so a file key alone is not always enough — when the
 * server cannot resolve the node we surface that instead of silently returning
 * an empty design.
 */

const CLIENT_INFO = { name: "career-site-studio", version: "0.1.0" };

/** Tool-name fragments, best first, for each thing we need from the server. */
const TOOL_INTENTS = {
  metadata: ["get_metadata", "design_context", "get_design", "metadata", "get_code"],
  variables: ["get_variable_defs", "variable", "get_design_tokens", "tokens"],
  image: ["get_screenshot", "get_image", "screenshot", "image"],
} as const;

/** Dev Mode re-renders per call; past this an import stops feeling live. */
const MAX_SCREENSHOTS = 6;

export class FigmaMcpProvider implements FigmaProvider {
  readonly backend = "mcp" as const;

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async connect(): Promise<Client> {
    const client = new Client(CLIENT_INFO);
    const endpoint = new URL(this.url);

    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint));
      return client;
    } catch (streamableError) {
      // Older Figma builds serve the legacy SSE transport at /sse.
      try {
        const sse = new URL(this.url.replace(/\/mcp\/?$/, "/sse"));
        const fallback = new Client(CLIENT_INFO);
        await fallback.connect(new SSEClientTransport(sse));
        return fallback;
      } catch {
        throw new Error(
          `Could not reach the Figma Dev Mode MCP server at ${this.url}. ` +
            `Open the Figma desktop app and enable Preferences -> Dev Mode MCP Server, ` +
            `or set FIGMA_PROVIDER=rest with a FIGMA_TOKEN. ` +
            `(${streamableError instanceof Error ? streamableError.message : String(streamableError)})`,
        );
      }
    }
  }

  async fetchDesign(fileKey: string, nodeId?: string, projectId?: string): Promise<DesignDocument> {
    const warnings: string[] = [];
    const client = await this.connect();

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      const pick = (intent: keyof typeof TOOL_INTENTS): string | undefined => {
        for (const fragment of TOOL_INTENTS[intent]) {
          const hit = names.find((n) => n.toLowerCase().includes(fragment));
          if (hit) return hit;
        }
        return undefined;
      };

      const metadataTool = pick("metadata");
      if (!metadataTool) {
        throw new Error(
          `The Figma MCP server at ${this.url} exposes no structure tool. Saw: ${names.join(", ") || "no tools"}.`,
        );
      }

      // Figma's tools take a nodeId and ignore unknown extras, so we pass the
      // superset of argument names its releases have used.
      const args: Record<string, unknown> = {
        nodeId: nodeId ?? "",
        clientName: CLIENT_INFO.name,
        clientLanguages: "typescript",
        clientFrameworks: "react",
      };
      if (nodeId) args.node_id = nodeId;

      const raw = await client.callTool({ name: metadataTool, arguments: args });
      const text = textOf(raw);
      if (!text.trim()) {
        throw new Error(
          `${metadataTool} returned nothing. The Dev Mode MCP server reads the file open in ` +
            `Figma — open the design and select the frame you want to import.`,
        );
      }

      const frames = parseStructure(text, warnings);
      if (frames.length === 0) {
        warnings.push(
          `Could not derive frames from ${metadataTool}'s output; the import will be thin.`,
        );
      }

      // Variables give real token names, which beats inferring them from usage.
      let styles = collectStyles(frames);
      const variablesTool = pick("variables");
      if (variablesTool) {
        try {
          const vars = await client.callTool({ name: variablesTool, arguments: args });
          const declared = parseVariables(textOf(vars));
          if (declared.colors.length > 0) styles = { ...styles, colors: declared.colors };
          if (declared.text.length > 0) styles = { ...styles, text: declared.text };
        } catch (error) {
          warnings.push(
            `Design variables unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // The screenshot is the design half of the fidelity review's evidence —
      // without it a reviewer is comparing the built page against nothing.
      const images = await this.captureFrames(client, pick("image"), frames, projectId, args, warnings);

      return {
        fileKey,
        fileName: frames[0]?.name ?? "Figma design",
        lastModified: new Date().toISOString(),
        backend: this.backend,
        frames,
        styles,
        images,
        warnings,
      };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Screenshots the imported frames, if this server will do it.
   *
   * Same defensive contract as everything else here: the tool is discovered by
   * intent because Figma keeps renaming it, and every way this can fail — no
   * such tool, a server that answers with prose, a node it cannot resolve —
   * degrades to a warning. An import that produced a good structure must never
   * fall over because a picture did not arrive.
   *
   * The result may be inline base64, a resource blob or just a URL depending on
   * the release, so all three are handled and the bytes land in the asset store
   * either way — nothing the MCP server hands back survives this process.
   */
  private async captureFrames(
    client: Client,
    tool: string | undefined,
    frames: DesignFrame[],
    projectId: string | undefined,
    baseArgs: Record<string, unknown>,
    warnings: string[],
  ): Promise<Record<string, string>> {
    if (frames.length === 0) return {};
    if (!tool) {
      warnings.push(
        "This Figma MCP server exposes no screenshot tool, so the design review will have no reference image.",
      );
      return {};
    }
    if (!projectId) {
      warnings.push(
        "Frame screenshots were skipped: this import had no project to store them against.",
      );
      return {};
    }

    // The Dev Mode server re-renders on every call, so a wide file would turn
    // an import into a minutes-long stall. The review only ever looks at the
    // frame that was built; the rest are a bonus.
    const targets = frames.slice(0, MAX_SCREENSHOTS);
    if (frames.length > targets.length) {
      warnings.push(
        `Only the first ${MAX_SCREENSHOTS} frames were screenshotted; the rest were skipped to keep the import responsive.`,
      );
    }

    const images: Record<string, string> = {};
    for (const frame of targets) {
      const alt = `Figma frame “${frame.name}”`;
      try {
        const result = await client.callTool({
          name: tool,
          arguments: { ...baseArgs, nodeId: frame.id, node_id: frame.id },
        });

        const inline = imageBlocksOf(result);
        if (inline.length > 0) {
          const url = await storeDesignImage(projectId, inline[0].data, inline[0].mimeType, alt, warnings);
          if (url) images[frame.id] = url;
          continue;
        }

        // Some builds answer with a link or a data: URI in the text block.
        const link = imageLinkIn(textOf(result));
        if (!link) {
          warnings.push(`${tool} returned no image for ${alt}.`);
          continue;
        }
        const url = link.startsWith("data:")
          ? await storeDesignImage(projectId, decodeDataUri(link), mimeOfDataUri(link), alt, warnings)
          : await persistDesignImage(projectId, link, alt, warnings);
        if (url) images[frame.id] = url;
      } catch (error) {
        warnings.push(
          `Screenshot of ${alt} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return images;
  }
}

/**
 * Pulls the binary blocks out of a tool result.
 *
 * The spec's `image` block carries base64 in `data`; a `resource` block carries
 * it in `resource.blob`. Figma has used both, so neither is assumed.
 */
function imageBlocksOf(result: unknown): { data: Uint8Array; mimeType: string }[] {
  const content = (result as { content?: Record<string, any>[] })?.content ?? [];
  const found: { data: Uint8Array; mimeType: string }[] = [];

  for (const block of content) {
    const base64 =
      block?.type === "image" && typeof block.data === "string"
        ? block.data
        : typeof block?.resource?.blob === "string"
          ? block.resource.blob
          : null;
    if (!base64) continue;

    const mimeType = String(block.mimeType ?? block.resource?.mimeType ?? "image/png");
    if (!mimeType.startsWith("image/")) continue;
    try {
      found.push({ data: new Uint8Array(Buffer.from(base64, "base64")), mimeType });
    } catch {
      // A block we cannot decode is not worth failing an import over.
    }
  }
  return found;
}

/** First data: URI or image URL in a text answer. */
function imageLinkIn(text: string): string | null {
  const dataUri = text.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUri) return dataUri[0];
  const link = text.match(/https?:\/\/\S+?\.(?:png|jpe?g|webp)(?=[)\s"']|$)/i);
  return link ? link[0] : null;
}

function decodeDataUri(uri: string): Uint8Array {
  return new Uint8Array(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
}

function mimeOfDataUri(uri: string): string {
  return uri.slice(5, uri.indexOf(";"));
}

/** MCP tool results are content blocks; we want the concatenated text. */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content ?? [];
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Turns whatever the server returned into frames.
 *
 * Figma has shipped this payload as JSON and as an XML-ish layer dump depending
 * on the release, so we try JSON first and fall back to a tolerant tag scan.
 */
function parseStructure(text: string, warnings: string[]): DesignFrame[] {
  const json = tryJson(text);
  if (json) {
    const roots = Array.isArray(json) ? json : [json];
    const nodes = roots
      .flatMap((root) => (root?.children ? [root] : (root?.nodes ?? root?.frames ?? [])))
      .map((node: unknown) => normalizeJsonNode(node))
      .filter((n): n is DesignNode => n !== null);
    return nodes.map(toFrame);
  }

  const fromXml = parseXmlish(text);
  if (fromXml.length > 0) return fromXml.map(toFrame);

  warnings.push("Figma MCP output was neither JSON nor a recognisable layer tree.");
  return [];
}

function tryJson(text: string): any | null {
  const trimmed = text.trim();
  // The payload is sometimes wrapped in a fenced code block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeJsonNode(input: unknown): DesignNode | null {
  const node = input as Record<string, any> | null;
  if (!node || typeof node !== "object") return null;

  const id = String(node.id ?? node.nodeId ?? node.node_id ?? "");
  const name = String(node.name ?? node.characters ?? "unnamed");
  if (!id && !node.children) return null;

  const box = node.absoluteBoundingBox ?? node.boundingBox ?? node.bounds ?? {};

  const children = (node.children ?? [])
    .map((child: unknown) => normalizeJsonNode(child))
    .filter((c: DesignNode | null): c is DesignNode => c !== null);

  return {
    id: id || name,
    name,
    type: String(node.type ?? "FRAME"),
    bounds: {
      x: Number(box.x ?? 0),
      y: Number(box.y ?? 0),
      width: Number(box.width ?? node.width ?? 0),
      height: Number(box.height ?? node.height ?? 0),
    },
    ...(node.characters ? { text: String(node.characters) } : {}),
    ...(node.componentName ? { componentName: String(node.componentName) } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Tolerant scan of Figma's XML-ish layer dump.
 *
 * Lines look roughly like:
 *   <frame id="1:2" name="Hero" x="0" y="0" width="1440" height="720">
 *     <text id="1:3" name="Headline">Build your career</text>
 */
function parseXmlish(text: string): DesignNode[] {
  const tag =
    /<(\w+)\s+([^>]*?)(\/?)>(?:([^<]*)<\/\1>)?/g;
  const roots: DesignNode[] = [];
  const stack: DesignNode[] = [];

  // Track nesting by indentation, which the dump preserves and self-closing
  // tags do not otherwise reveal.
  for (const line of text.split("\n")) {
    tag.lastIndex = 0;
    const match = tag.exec(line);
    if (!match) {
      if (/^\s*<\/\w+>/.test(line)) stack.pop();
      continue;
    }

    const [, type, attrsRaw, selfClosing, inner] = match;
    const attrs: Record<string, string> = {};
    for (const attr of attrsRaw.matchAll(/(\w[\w-]*)="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }

    const node: DesignNode = {
      id: attrs.id || attrs.nodeId || `${type}-${roots.length}-${stack.length}`,
      name: attrs.name || type,
      type: type.toUpperCase(),
      bounds: {
        x: Number(attrs.x ?? 0),
        y: Number(attrs.y ?? 0),
        width: Number(attrs.width ?? 0),
        height: Number(attrs.height ?? 0),
      },
      ...(inner?.trim() ? { text: inner.trim() } : {}),
      ...(attrs.fill ? { fills: [attrs.fill] } : {}),
      ...(attrs.fontSize ? { fontSize: Number(attrs.fontSize) } : {}),
      ...(attrs.fontFamily ? { fontFamily: attrs.fontFamily } : {}),
    };

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length > 0 && indent <= (stack[stack.length - 1] as any).__indent) stack.pop();

    if (stack.length === 0) roots.push(node);
    else {
      const parent = stack[stack.length - 1];
      (parent.children ??= []).push(node);
    }

    if (!selfClosing && !inner) {
      (node as any).__indent = indent;
      stack.push(node);
    }
  }

  // Strip the bookkeeping field before the tree leaves this module.
  const clean = (node: DesignNode) => {
    delete (node as any).__indent;
    for (const child of node.children ?? []) clean(child);
  };
  roots.forEach(clean);

  return roots;
}

function toFrame(node: DesignNode): DesignFrame {
  return { id: node.id, name: node.name, bounds: node.bounds, children: node.children ?? [] };
}

/** `get_variable_defs` returns a flat name -> value map. */
function parseVariables(text: string): { colors: { name: string; hex: string }[]; text: { name: string; fontFamily: string; fontSize: number; fontWeight: number }[] } {
  const json = tryJson(text);
  const colors: { name: string; hex: string }[] = [];
  const typography: { name: string; fontFamily: string; fontSize: number; fontWeight: number }[] = [];
  if (!json || typeof json !== "object") return { colors, text: typography };

  for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)) {
      colors.push({ name, hex: value });
    } else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.fontSize === "number") {
        typography.push({
          name,
          fontFamily: String(v.fontFamily ?? "Inter"),
          fontSize: v.fontSize,
          fontWeight: Number(v.fontWeight ?? 400),
        });
      }
    }
  }

  return { colors: colors.slice(0, 12), text: typography.slice(0, 8) };
}
