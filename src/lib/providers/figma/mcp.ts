import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesignAsset,
  DesignDocument,
  DesignFrame,
  DesignNode,
  DesignNodeReference,
  DesignNodeRender,
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
  assets: ["download_assets", "download_images", "get_assets"],
} as const;

/** Dev Mode re-renders per call; past this an import stops feeling live. */
const MAX_SCREENSHOTS = 6;

/** Pages to walk when the hosted server hands back a page list to choose from. */
const MAX_PAGES = 4;

/**
 * Frames to pull assets from, and the ceiling on how many files an import may
 * add. A careers design can carry a hundred images across its pages, and an
 * import that downloads all of them is an import that looks broken.
 */
const MAX_ASSET_FRAMES = 3;
const MAX_ASSETS = 40;

/**
 * Asset-tool calls one import may make.
 *
 * Images are fetched per band rather than per frame, because an image is only
 * useful to the importer if it can be attributed to the section that band
 * becomes — a frame's own image list is every picture on the page at once. That
 * costs one call per band, so it needs a ceiling.
 */
const MAX_ASSET_CALLS = 20;

/**
 * Files any one band may contribute.
 *
 * Without this the global ceiling is spent in document order, and document
 * order is not need order: a real import spent its entire budget on the first
 * three bands — a footer whose social icons are eight separate files, a banner
 * and a testimonial strip — and never looked at the hero, the logo wall or the
 * culture band, which are the sections that actually display an image. Bounding
 * each band leaves room for all of them.
 */
const MAX_ASSETS_PER_BAND = 4;

/**
 * Longer edge of an on-demand node render, in pixels.
 *
 * Sized for a model to look at rather than for print. A full-width careers
 * frame is 1440px and renders tall enough that the image alone costs a couple
 * of thousand tokens; 1200 keeps a band legible for a fraction of that.
 */
const DEFAULT_RENDER_DIMENSION = 1200;

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

/** First tool whose name matches an intent, best fragment first. */
function pickTool(tools: Tool[], intent: keyof typeof TOOL_INTENTS): Tool | undefined {
  for (const fragment of TOOL_INTENTS[intent]) {
    const hit = tools.find((tool) => tool.name.toLowerCase().includes(fragment));
    if (hit) return hit;
  }
  return undefined;
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

      const pick = (intent: keyof typeof TOOL_INTENTS) => pickTool(tools, intent);

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

      // The design's real photographs, icons and logos. One call per frame
      // yields both these and a render of the frame itself, so when this tool
      // is available it also supplies the reference image and the screenshot
      // tool is not needed.
      const assetsTool = pick("assets");
      const { assets, images: rendered } = await this.collectAssets(
        client,
        assetsTool,
        frames,
        projectId,
        candidates,
        warnings,
      );

      // The screenshot is the design half of the fidelity review's evidence —
      // without it a reviewer is comparing the built page against nothing.
      const images =
        Object.keys(rendered).length > 0
          ? rendered
          : await this.captureFrames(client, pick("image"), frames, projectId, candidates, warnings);

      return {
        fileKey,
        fileName: frames[0]?.name ?? "Figma design",
        lastModified: new Date().toISOString(),
        backend: this.backend,
        frames,
        styles,
        images,
        ...(assets.length > 0 ? { assets } : {}),
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
   * Renders one node on demand.
   *
   * The import stores whole frames because that is what the fidelity review
   * compares; a band is a node inside one, and a model asked to replicate a
   * band from a picture of the entire page is being asked to squint. This
   * renders exactly the node in question, capped small enough to be worth
   * looking at, and puts it in the asset store so asking twice is free.
   */
  async renderNode(
    fileKey: string,
    nodeId: string,
    projectId: string,
    maxDimension = DEFAULT_RENDER_DIMENSION,
  ): Promise<DesignNodeRender | null> {
    const warnings: string[] = [];
    const client = await this.connect();

    try {
      const { tools } = await client.listTools();
      const tool = pickTool(tools, "image");
      if (!tool) {
        warnings.push("This Figma MCP server exposes no screenshot tool.");
        return { url: "", warnings };
      }

      const result = await client.callTool({
        name: tool.name,
        arguments: shapeArgs(tool, {
          fileKey,
          nodeId,
          node_id: nodeId,
          maxDimension,
          clientName: CLIENT_INFO.name,
          clientLanguages: "typescript",
          clientFrameworks: "react",
        }),
      });

      const alt = `Figma node ${nodeId}`;
      const inline = imageBlocksOf(result);
      if (inline.length > 0) {
        const url = await storeDesignImage(
          projectId,
          inline[0].data,
          inline[0].mimeType,
          alt,
          warnings,
        );
        return url ? { url, warnings } : { url: "", warnings };
      }

      const link = imageLinkIn(textOf(result));
      if (!link) {
        warnings.push(`${tool.name} returned no image for ${alt}.`);
        return { url: "", warnings };
      }
      const url = link.startsWith("data:")
        ? await storeDesignImage(projectId, decodeDataUri(link), mimeOfDataUri(link), alt, warnings)
        : await persistDesignImage(projectId, link, alt, warnings);
      return { url, warnings };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Asks Figma for its own markup for a node.
   *
   * The languages and frameworks reported here are deliberately `html,css`
   * rather than the React default: what the studio does with this is author a
   * `custom-html` replica, and reference code in the shape of the thing being
   * written is worth more than reference code that has to be translated first.
   */
  async referenceNode(fileKey: string, nodeId: string): Promise<DesignNodeReference | null> {
    const warnings: string[] = [];
    const client = await this.connect();

    try {
      const { tools } = await client.listTools();
      // Deliberately not the metadata intent: that one prefers get_metadata,
      // which returns the layer dump this method exists to complement.
      const tool = tools.find((candidate) => candidate.name.toLowerCase().includes("design_context"));
      if (!tool) return null;

      const result = await client.callTool({
        name: tool.name,
        arguments: shapeArgs(tool, {
          fileKey,
          nodeId,
          node_id: nodeId,
          clientName: CLIENT_INFO.name,
          clientLanguages: "html,css",
          clientFrameworks: "none",
          // The studio renders nodes separately and on demand; a screenshot
          // returned here would be a second copy of the same picture.
          excludeScreenshot: true,
        }),
      });

      const code = textOf(result).trim();
      if (!code) {
        warnings.push(`${tool.name} returned no reference code for node ${nodeId}.`);
        return { code: "", warnings };
      }
      return { code, warnings };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Lifts the design's real files out of Figma and into the asset store.
   *
   * This is what makes an imported site look like the design instead of like a
   * stock-photo catalogue. The asset tool answers with, per frame, a render of
   * the frame (`export`), the original uploaded photographs found as fills
   * anywhere beneath it (`rawImages`), and its vector layers as SVG
   * (`svgAssets`) — the icons and logos.
   *
   * Every URL it returns is short-lived and, in Figma's own words, should be
   * treated like a secret, so nothing is stored as a link: the bytes are
   * downloaded here and re-served from the project's asset store. That also
   * means a design re-imported twice costs one copy of each file, because the
   * store is content-addressed.
   *
   * Failure is always partial. No tool, a frame that yields nothing, a file too
   * large for the store — each costs one picture and a warning, never the
   * import.
   */
  private async collectAssets(
    client: Client,
    tool: Tool | undefined,
    frames: DesignFrame[],
    projectId: string | undefined,
    candidates: Record<string, unknown>,
    warnings: string[],
  ): Promise<{ assets: DesignAsset[]; images: Record<string, string> }> {
    const empty = { assets: [], images: {} };
    if (!tool || frames.length === 0) return empty;
    if (!projectId) {
      warnings.push(
        "The design's own images were skipped: this import had no project to store them against.",
      );
      return empty;
    }

    const targets = frames.slice(0, MAX_ASSET_FRAMES);
    if (frames.length > targets.length) {
      warnings.push(
        `Images were taken from the first ${MAX_ASSET_FRAMES} frames only; ${frames.length - targets.length} more were skipped to keep the import responsive.`,
      );
    }

    const assets: DesignAsset[] = [];
    const images: Record<string, string> = {};
    // The same fill answers on the same URL, and a logo repeats across bands.
    // Mapping source URL to the stored copy means a repeat costs a second
    // DesignAsset row — which is wanted, since the band differs — but not a
    // second download or a second file on disk.
    const stored = new Map<string, string>();
    let calls = 0;

    /** Downloads one file once, and records it against the band it was found in. */
    const take = async (
      source: AssetSource,
      kind: DesignAsset["kind"],
      frame: DesignFrame,
      nodeId: string,
      bandName: string,
    ): Promise<void> => {
      if (assets.length >= MAX_ASSETS || !source.url) return;

      let url = stored.get(source.url);
      if (url === undefined) {
        const label =
          kind === "export"
            ? `Figma frame “${frame.name}”`
            : `${kind === "svg" ? "Icon" : "Image"} from “${bandName}” in the Figma design`;
        url = await persistDesignImage(projectId, source.url, label, warnings);
        stored.set(source.url, url);
      }
      if (!url) return;

      // A frame's own render is the fidelity review's reference image.
      if (kind === "export") images[nodeId] = url;
      assets.push({
        url,
        kind,
        frameId: frame.id,
        frameName: frame.name,
        format: source.format ?? "",
        nodeId,
      });
    };

    /** One asset-tool call. Returns null when it could not be read. */
    const fetchAssets = async (nodeId: string, label: string): Promise<AssetPayload | null> => {
      calls += 1;
      try {
        const result = await client.callTool({
          name: tool.name,
          arguments: shapeArgs(tool, { ...candidates, nodeId, node_id: nodeId }),
        });
        const payload = parseAssetPayload(textOf(result));
        if (!payload) warnings.push(`${tool.name} returned no readable asset list for ${label}.`);
        return payload;
      } catch (error) {
        warnings.push(
          `Could not read images for ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    };

    for (const frame of targets) {
      if (assets.length >= MAX_ASSETS || calls >= MAX_ASSET_CALLS) break;

      // The frame first, for its render. Its raw images are every image on the
      // page at once, which is why they are not taken here: attributing them
      // to the whole frame would be exactly the loss of precision the
      // per-band pass below exists to avoid.
      const framePayload = await fetchAssets(frame.id, `frame “${frame.name}”`);
      if (framePayload?.export) {
        await take(framePayload.export, "export", frame, framePayload.export.nodeId ?? frame.id, frame.name);
      }

      // Then each band. The asset tool takes any node, so asking about a band
      // returns the images inside that band — which is what makes an image
      // attributable to the section the band becomes.
      const bands = frame.children;
      if (bands.length === 0 && framePayload) {
        for (const raw of framePayload.rawImages) await take(raw, "raw", frame, frame.id, frame.name);
        for (const svg of framePayload.svgAssets) await take(svg, "svg", frame, frame.id, frame.name);
        continue;
      }

      let skippedBands = 0;
      for (const band of bands) {
        if (assets.length >= MAX_ASSETS || calls >= MAX_ASSET_CALLS) {
          skippedBands += 1;
          continue;
        }
        const payload = await fetchAssets(band.id, `“${band.name}”`);
        if (!payload) continue;

        // Photographs first, then vectors: a band that holds both is usually a
        // picture with iconography around it, and the picture is the content.
        // Interleaving the two would let a footer's icon set crowd out the one
        // image the band actually shows.
        const before = assets.length;
        for (const raw of payload.rawImages) {
          if (assets.length - before >= MAX_ASSETS_PER_BAND) break;
          await take(raw, "raw", frame, band.id, band.name);
        }
        for (const svg of payload.svgAssets) {
          if (assets.length - before >= MAX_ASSETS_PER_BAND) break;
          await take(svg, "svg", frame, band.id, band.name);
        }
        const held = payload.rawImages.length + payload.svgAssets.length;
        if (held > MAX_ASSETS_PER_BAND) {
          warnings.push(
            `“${band.name}” holds ${held} images; the first ${MAX_ASSETS_PER_BAND} were imported so the other bands keep their share.`,
          );
        }

        if (payload.rawImagesTruncated || payload.svgAssetsTruncated) {
          warnings.push(
            `“${band.name}” holds more images than Figma's asset tool returns at once; the rest were not imported.`,
          );
        }
      }
      if (skippedBands > 0) {
        warnings.push(
          `${skippedBands} band(s) of “${frame.name}” were not searched for images, to keep the import responsive.`,
        );
      }
    }

    if (assets.length >= MAX_ASSETS) {
      warnings.push(
        `The design's image import stopped at ${MAX_ASSETS} files. Anything beyond that has to be uploaded by hand.`,
      );
    }
    return { assets, images };
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

interface AssetSource {
  url: string;
  format?: string;
  nodeId?: string;
}

interface AssetPayload {
  export?: AssetSource;
  rawImages: AssetSource[];
  svgAssets: AssetSource[];
  rawImagesTruncated: boolean;
  svgAssetsTruncated: boolean;
}

/**
 * Reads the asset tool's answer.
 *
 * That answer is a JSON object followed by prose telling a human how to `curl`
 * the files, so it cannot simply be parsed — `JSON.parse` chokes on the
 * trailing text. Only the leading object is taken, and every field is treated
 * as optional: an older release that omits `svgAssets` should cost the SVGs,
 * not the photographs beside them.
 */
function parseAssetPayload(text: string): AssetPayload | null {
  const json = firstJsonObject(text);
  if (!json) return null;

  const sources = (value: unknown): AssetSource[] =>
    Array.isArray(value)
      ? value
          .map((entry) => {
            const item = entry as Record<string, unknown> | null;
            const url = typeof item?.url === "string" ? item.url : "";
            if (!url) return null;
            return {
              url,
              ...(typeof item?.format === "string" ? { format: item.format } : {}),
              ...(typeof item?.nodeId === "string" ? { nodeId: item.nodeId } : {}),
            };
          })
          .filter((entry): entry is AssetSource => entry !== null)
      : [];

  const exported = sources([json.export]);
  return {
    ...(exported[0] ? { export: exported[0] } : {}),
    rawImages: sources(json.rawImages),
    svgAssets: sources(json.svgAssets),
    rawImagesTruncated: json.rawImagesTruncated === true,
    svgAssetsTruncated: json.svgAssetsTruncated === true,
  };
}

/**
 * The first complete JSON object in a string, ignoring whatever follows it.
 *
 * Brace counting has to respect strings and escapes, because a URL or a layer
 * name is perfectly entitled to contain a brace.
 */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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
 *
 * Two details of the real dump are load-bearing. Text layers come back
 * self-closing, with the copy in the `name` attribute rather than as element
 * content — so a `<text>` node's name *is* its text, and reading only the
 * element body would import a design with no words in it. And layers hidden on
 * the canvas are still listed, marked `hidden="true"`; a hidden cookie banner
 * imported as a band would become a section of the built site that nobody can
 * see in the design, so the whole subtree is skipped.
 */
function parseXmlish(text: string): DesignNode[] {
  const tag =
    /<(\w+)\s+([^>]*?)(\/?)>(?:([^<]*)<\/\1>)?/g;
  const roots: DesignNode[] = [];
  const stack: DesignNode[] = [];
  // Indentation of a hidden node, while its subtree is being discarded.
  let skipBelow: number | null = null;

  // Track nesting by indentation, which the dump preserves and self-closing
  // tags do not otherwise reveal.
  for (const line of text.split("\n")) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (skipBelow !== null) {
      if (indent > skipBelow) continue;
      // The hidden node's own closing tag closes a node that was never pushed,
      // so letting it reach the pop below would discard the real parent and
      // promote every later sibling to a top-level frame.
      const closesHidden = indent === skipBelow && /^\s*<\/\w+>/.test(line);
      skipBelow = null;
      if (closesHidden) continue;
    }

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

    if (attrs.hidden === "true" || attrs.visible === "false") {
      skipBelow = indent;
      continue;
    }

    // A text layer's copy is its name; anything else's name is just a label.
    const copy = inner?.trim() || (type.toLowerCase() === "text" ? attrs.name : "");

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
      ...(copy ? { text: copy } : {}),
      ...(attrs.fill ? { fills: [attrs.fill] } : {}),
      ...(attrs.fontSize ? { fontSize: Number(attrs.fontSize) } : {}),
      ...(attrs.fontFamily ? { fontFamily: attrs.fontFamily } : {}),
    };

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
