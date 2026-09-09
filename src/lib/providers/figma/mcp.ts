import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesignDocument,
  DesignFrame,
  DesignNode,
  FigmaProvider,
} from "./types";
import { collectStyles, persistDesignImage, storeDesignImage } from "./rest";
import {
  credentialsPath,
  invalidateFigmaMcpAuth,
  needsAuth,
  resolveFigmaMcpAuth,
  type FigmaMcpAuth,
} from "./mcp-auth";

/**
 * Figma MCP backend, for either of Figma's two MCP servers.
 *
 * The Dev Mode server runs locally inside the Figma desktop app (Preferences
 * -> Enable Dev Mode MCP Server) on http://127.0.0.1:3845/mcp and needs no
 * credentials. The hosted server at https://mcp.figma.com/mcp needs an OAuth
 * bearer token but no desktop app, which is the only one of the two that works
 * on a headless box or in CI. `mcp-auth.ts` supplies the token; everything
 * below is transport-agnostic between the two.
 *
 * Three things make this backend defensive by design. Figma has renamed its
 * MCP tools across releases (`get_metadata` / `get_design_context` /
 * `get_code`), so we discover the tool list at connect time and match by
 * intent rather than hardcoding a name. The two servers disagree about their
 * arguments — the hosted one requires `fileKey` and refuses unknown extras,
 * the desktop one wants neither — so arguments are shaped per call from each
 * tool's advertised schema rather than sent as a fixed superset. And neither
 * server is guaranteed to resolve a node: when it cannot, we surface that
 * instead of silently returning an empty design.
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

/** Pages to walk when the hosted server hands back a page list to choose from. */
const MAX_PAGES = 4;

/**
 * Shapes arguments for one tool from its own advertised schema.
 *
 * This replaces what used to be a deliberate superset of every argument name
 * Figma's releases have used, which worked only because the desktop server
 * ignores extras. The hosted server declares `additionalProperties: false`, so
 * that same superset is now a hard schema violation — and the tools disagree
 * with each other besides: `get_design_context` accepts `clientFrameworks`
 * while `get_metadata` rejects it, and `nodeId` has `minLength: 1`, so the old
 * `nodeId: nodeId ?? ""` was invalid the moment it was empty.
 *
 * Reading the schema instead of guessing keeps one code path correct against
 * both servers, and against whatever Figma renames next.
 */
function shapeArgs(tool: Tool, candidates: Record<string, unknown>): Record<string, unknown> {
  const declared = tool.inputSchema?.properties as Record<string, unknown> | undefined;
  const shaped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(candidates)) {
    // An absent value is not the same as an empty one: both are omitted, since
    // every string argument these tools take is declared minLength 1.
    if (value === undefined || value === null || value === "") continue;
    // With no schema to read (an older server), fall back to sending it and
    // letting the server ignore what it does not know.
    if (declared && !(key in declared)) continue;
    shaped[key] = value;
  }
  return shaped;
}

/** Whether a tool declares an argument mandatory. */
function requiresArg(tool: Tool, name: string): boolean {
  const required = tool.inputSchema?.required;
  return Array.isArray(required) && required.includes(name);
}

/** Whether a tool will refuse to answer without a concrete node id. */
function requiresNode(tool: Tool): boolean {
  return requiresArg(tool, "nodeId");
}

/**
 * Pulls page ids out of the hosted structure tool's page-list answer.
 *
 * That answer is a list of guid + name pairs rather than a layer tree, and has
 * been both XML-ish and JSON, so this matches the id shape in either — a page
 * guid is always `<int>:<int>`.
 */
function parsePageIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:id|guid)"?\s*[:=]\s*"(\d+:\d+)"/gi)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function emptyStructureMessage(tool: string, url: string, nodeId?: string): string {
  const scope = nodeId ? `node ${nodeId}` : "that file";
  return needsAuth(url)
    ? `${tool} returned nothing for ${scope}. Check that the Figma URL points at a /design/ file ` +
        `(FigJam boards and Slides are not supported) and that ${nodeId ? "the node exists in it" : "it is not empty"}.`
    : `${tool} returned nothing for ${scope}. The Dev Mode MCP server reads the file open in ` +
        `Figma — open the design and select the frame you want to import.`;
}

export class FigmaMcpProvider implements FigmaProvider {
  readonly backend = "mcp" as const;

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async connect(): Promise<Client> {
    const auth = await resolveFigmaMcpAuth(this.url);
    if (!auth && needsAuth(this.url)) {
      throw new Error(unauthenticatedMessage(this.url));
    }

    const client = new Client(CLIENT_INFO);
    const endpoint = new URL(this.url);
    const fetchImpl = authedFetch(auth);

    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: fetchImpl }));
      return client;
    } catch (streamableError) {
      // Older Figma builds serve the legacy SSE transport at /sse.
      try {
        const sse = new URL(this.url.replace(/\/mcp\/?$/, "/sse"));
        const fallback = new Client(CLIENT_INFO);
        await fallback.connect(new SSEClientTransport(sse, { fetch: fetchImpl }));
        return fallback;
      } catch {
        throw new Error(unreachableMessage(this.url, auth, streamableError));
      }
    }
  }

  /**
   * Imports a design, retrying once if the borrowed token has gone stale.
   *
   * The access token lives in a cache shared with Claude Code, so it can be
   * rotated out from under us between one import and the next. A single retry
   * after dropping the cache turns that into an invisible refresh rather than
   * a failed import the admin has to understand.
   */
  async fetchDesign(fileKey: string, nodeId?: string, projectId?: string): Promise<DesignDocument> {
    try {
      return await this.attemptFetch(fileKey, nodeId, projectId);
    } catch (error) {
      if (!isUnauthorized(error) || !needsAuth(this.url)) throw error;
      invalidateFigmaMcpAuth();
      return this.attemptFetch(fileKey, nodeId, projectId);
    }
  }

  private async attemptFetch(
    fileKey: string,
    nodeId?: string,
    projectId?: string,
  ): Promise<DesignDocument> {
    const warnings: string[] = [];
    const client = await this.connect();

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      const pick = (intent: keyof typeof TOOL_INTENTS): Tool | undefined => {
        for (const fragment of TOOL_INTENTS[intent]) {
          const hit = tools.find((t) => t.name.toLowerCase().includes(fragment));
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

      // The hosted server identifies a design by file key and cannot proceed
      // without one; the desktop server does not take it at all. Checking the
      // schema rather than the URL keeps this from guessing which we are on.
      if (requiresArg(metadataTool, "fileKey")) {
        if (!fileKey) {
          throw new Error(
            `${metadataTool.name} on ${this.url} requires a Figma file key and none was supplied. ` +
              `Import a file URL like https://www.figma.com/design/<key>/<name>.`,
          );
        }
        if (!/^[0-9a-zA-Z]{22,128}$/.test(fileKey)) {
          throw new Error(
            `"${fileKey}" is not a Figma file key. Copy the key out of a /design/ URL — ` +
              `it is the 22-character segment after /design/.`,
          );
        }
      }

      // Every value either server has ever wanted. Which of them actually get
      // sent is decided per tool from its own schema — see shapeArgs.
      const candidates: Record<string, unknown> = {
        fileKey,
        nodeId,
        node_id: nodeId,
        clientName: CLIENT_INFO.name,
        clientLanguages: "typescript",
        clientFrameworks: "react",
      };

      const { frames, nodeUsed } = await this.fetchStructure(
        client,
        metadataTool,
        candidates,
        nodeId,
        warnings,
      );
      if (frames.length === 0) {
        warnings.push(
          `Could not derive frames from ${metadataTool.name}'s output; the import will be thin.`,
        );
      }

      // Variables give real token names, which beats inferring them from usage.
      // The hosted server requires a concrete node for this, so it falls back
      // to whatever node the structure came from.
      let styles = collectStyles(frames);
      const variablesTool = pick("variables");
      const variablesNode = nodeId ?? nodeUsed ?? frames[0]?.id;
      if (variablesTool) {
        try {
          const vars = await client.callTool({
            name: variablesTool.name,
            arguments: shapeArgs(variablesTool, {
              ...candidates,
              nodeId: variablesNode,
              node_id: variablesNode,
            }),
          });
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
      const images = await this.captureFrames(
        client,
        pick("image"),
        frames,
        projectId,
        candidates,
        warnings,
      );

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
   * Gets the layer structure, discovering a node to ask about if it must.
   *
   * The two servers disagree about what identifies a design. The desktop one
   * reads whatever file is open, so a node id is a refinement. The hosted one
   * takes a `fileKey` and treats `nodeId` as optional on its structure tool
   * only — omit it and you get the document's *page list* rather than a layer
   * dump, which is the discovery step this method exists to perform: list the
   * pages, then ask each page for its structure.
   *
   * Returns the node the structure actually came from, because the variables
   * tool requires a concrete node and has no page-list mode to fall back on.
   */
  private async fetchStructure(
    client: Client,
    tool: Tool,
    candidates: Record<string, unknown>,
    nodeId: string | undefined,
    warnings: string[],
  ): Promise<{ frames: DesignFrame[]; nodeUsed?: string }> {
    const call = async (node?: string): Promise<string> => {
      const result = await client.callTool({
        name: tool.name,
        arguments: shapeArgs(tool, { ...candidates, nodeId: node, node_id: node }),
      });
      return textOf(result);
    };

    // An explicit node is what the caller asked for; take it at its word.
    if (nodeId) {
      const text = await call(nodeId);
      if (!text.trim()) throw new Error(emptyStructureMessage(tool.name, this.url, nodeId));
      return { frames: parseStructure(text, warnings), nodeUsed: nodeId };
    }

    if (requiresNode(tool)) {
      throw new Error(
        `${tool.name} on ${this.url} requires a node id, and the Figma URL supplied none. ` +
          `Open the frame in Figma, copy its link (Share -> Copy link, which appends ?node-id=...), ` +
          `and import that instead.`,
      );
    }

    const first = await call(undefined);
    if (!first.trim()) throw new Error(emptyStructureMessage(tool.name, this.url));

    // The answer is either already a layer dump (desktop) or a page list
    // (hosted). Frames mean the former, so there is nothing left to do.
    const direct = parseStructure(first, []);
    if (direct.length > 0) return { frames: direct };

    const pages = parsePageIds(first);
    if (pages.length === 0) {
      // Neither frames nor pages: let the tolerant parser's warnings stand.
      return { frames: parseStructure(first, warnings) };
    }

    const targets = pages.slice(0, MAX_PAGES);
    if (pages.length > targets.length) {
      warnings.push(
        `The design has ${pages.length} pages; only the first ${MAX_PAGES} were imported. ` +
          `Import a specific frame's link to scope this narrowly.`,
      );
    }

    const frames: DesignFrame[] = [];
    let nodeUsed: string | undefined;
    for (const page of targets) {
      try {
        const found = parseStructure(await call(page), warnings);
        if (found.length > 0) {
          frames.push(...found);
          nodeUsed ??= page;
        }
      } catch (error) {
        warnings.push(
          `Page ${page} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { frames, nodeUsed };
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
    tool: Tool | undefined,
    frames: DesignFrame[],
    projectId: string | undefined,
    candidates: Record<string, unknown>,
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
          name: tool.name,
          arguments: shapeArgs(tool, {
            ...candidates,
            nodeId: frame.id,
            node_id: frame.id,
          }),
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
          warnings.push(`${tool.name} returned no image for ${alt}.`);
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
 * Wraps `fetch` so every request on either transport carries the bearer token.
 *
 * Injecting at the fetch layer rather than through `requestInit` is what makes
 * this cover the SSE transport's initial GET as well, which is opened
 * separately from the POSTs that carry the RPC traffic.
 */
function authedFetch(auth: FigmaMcpAuth | null): FetchLike | undefined {
  if (!auth) return undefined;
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${auth.token}`);
    return globalThis.fetch(url, { ...init, headers });
  };
}

/** A 401 anywhere in the chain means the token, not the request, was wrong. */
function isUnauthorized(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized/i.test(message);
}

function unauthenticatedMessage(url: string): string {
  return (
    `The Figma MCP server at ${url} needs an OAuth token and none was found. ` +
    `It is Figma's hosted server, which rejects personal access tokens — only OAuth works, ` +
    `and Figma's public client registration is closed, so the studio cannot mint its own. ` +
    `Authenticate once by running \`claude\` and connecting the figma server with /mcp ` +
    `(the token is cached in ${credentialsPath()} and refreshed from then on), ` +
    `or set FIGMA_MCP_TOKEN directly, ` +
    `or switch to FIGMA_PROVIDER=rest with a FIGMA_TOKEN.`
  );
}

function unreachableMessage(url: string, auth: FigmaMcpAuth | null, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const remedy = needsAuth(url)
    ? auth?.source === "env"
      ? `Check that FIGMA_MCP_TOKEN is a current OAuth token — Figma's hosted server rejects figd_ personal access tokens.`
      : `The cached OAuth token may have been revoked; reconnect the figma server with /mcp in \`claude\`.`
    : `Open the Figma desktop app and enable Preferences -> Dev Mode MCP Server.`;

  return (
    `Could not reach the Figma MCP server at ${url}. ${remedy} ` +
    `Alternatively set FIGMA_PROVIDER=rest with a FIGMA_TOKEN, which works headless. (${detail})`
  );
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

/**
 * First data: URI or image URL in a text answer.
 *
 * The hosted screenshot tool returns a short-lived signed URL rather than
 * inline bytes, and those carry a query string (`...png?X-Amz-Signature=...`),
 * so the extension cannot be anchored to the end of the URL.
 */
function imageLinkIn(text: string): string | null {
  const dataUri = text.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/);
  if (dataUri) return dataUri[0];
  const link = text.match(
    /https?:\/\/[^\s"'()]+?\.(?:png|jpe?g|webp)(?:\?[^\s"'()]*)?(?=[)\s"']|$)/i,
  );
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
