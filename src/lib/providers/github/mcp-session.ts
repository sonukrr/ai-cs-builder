import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { invalidateGitHubMcpAuth, resolveGitHubMcpAuth } from "./mcp-auth";

/**
 * One connection to a GitHub MCP server, shared by both backends that use it.
 *
 * The base-site reader and the deploy target want different tools but the same
 * plumbing: connect with a bearer resolved at call time, discover what the
 * server offers, and call a tool by *intent* rather than by name. Written once
 * here because the alternative was two copies of an OAuth-aware connect and two
 * copies of the argument shaping — which is exactly how the two would drift.
 *
 * Defensive in three specific ways, all learned from the servers themselves.
 *
 * TOOLS ARE MATCHED BY INTENT. GitHub has renamed MCP tools across releases and
 * its hosted server advertises 44 of them, so callers ask for "the one that
 * pushes files" with an ordered list of name fragments and get whichever the
 * server actually has.
 *
 * ARGUMENTS ARE SHAPED FROM EACH TOOL'S OWN SCHEMA. Sending a superset works
 * only until a server declares `additionalProperties: false`, and these tools
 * disagree with each other — `create_repository` takes `organization`, the file
 * tools take `owner`.
 *
 * A REJECTED TOKEN IS NAMED, NOT SWALLOWED. The remedy depends entirely on
 * where the credential came from, so the failure says which one was tried.
 */

const CLIENT_INFO = { name: "career-site-studio", version: "0.1.0" };

export class GitHubMcpSession {
  readonly url: string;

  private client: Client | null = null;
  private tools: Tool[] = [];

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Connects, resolving the bearer now rather than at construction.
   *
   * A cached OAuth token expires while the studio is running, and resolving it
   * here is what lets a refresh be picked up without a restart.
   */
  private async connect(): Promise<Client> {
    if (this.client) return this.client;

    const auth = await resolveGitHubMcpAuth(this.url);
    if (!auth) {
      throw new Error(
        `No credential for the GitHub MCP server at ${this.url}. Set GITHUB_MCP_TOKEN (or GITHUB_TOKEN), or authorise the server with an OAuth app — GitHub's authorization server refuses dynamic registration, so /mcp alone cannot complete that flow.`,
      );
    }

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
    });

    try {
      await client.connect(transport);
    } catch (error) {
      invalidateGitHubMcpAuth();
      const detail = error instanceof Error ? error.message : String(error);
      const remedy =
        auth.source === "github-token"
          ? "GITHUB_TOKEN was rejected. GitHub's MCP server does not accept every personal access token — set GITHUB_MCP_TOKEN to one that has access to the repository."
          : auth.source === "env"
            ? "GITHUB_MCP_TOKEN was rejected. Check it has not expired or been revoked, and that it grants access to the repository."
            : "The cached OAuth token was rejected. Reconnect the github server with /mcp.";
      throw new Error(`Could not connect to the GitHub MCP server: ${detail}. ${remedy}`);
    }

    this.tools = (await client.listTools()).tools;
    this.client = client;
    return client;
  }

  /** The best tool for an intent: an exact name first, then a substring. */
  private find(fragments: readonly string[]): Tool | null {
    for (const fragment of fragments) {
      const exact = this.tools.find((tool) => tool.name === fragment);
      if (exact) return exact;
    }
    for (const fragment of fragments) {
      const partial = this.tools.find((tool) => tool.name.includes(fragment));
      if (partial) return partial;
    }
    return null;
  }

  /**
   * Calls the tool matching `fragments`, passing only the arguments it declares.
   *
   * Returns the reply's payload as text — see `textOf` for which block that
   * comes from. Callers parse out what they need and, deliberately, do not
   * depend on fields that may not be there.
   */
  async call(
    intent: string,
    fragments: readonly string[],
    args: Record<string, unknown>,
  ): Promise<string> {
    const client = await this.connect();
    const tool = this.find(fragments);
    if (!tool) {
      throw new Error(
        `The GitHub MCP server at ${this.url} offers no ${intent} tool (it has: ${this.tools
          .map((candidate) => candidate.name)
          .slice(0, 12)
          .join(", ")}${this.tools.length > 12 ? ", …" : ""}).`,
      );
    }

    const result = await client.callTool({ name: tool.name, arguments: shape(tool, args) });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`GitHub MCP ${tool.name} failed: ${textOf(result).slice(0, 400)}`);
    }
    return textOf(result);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.tools = [];
  }
}

/** Shapes arguments for one tool from its own advertised schema. */
function shape(tool: Tool, candidates: Record<string, unknown>): Record<string, unknown> {
  const declared = tool.inputSchema?.properties as Record<string, unknown> | undefined;
  if (!declared) return candidates;

  const shaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidates)) {
    // An absent value is not the same as an empty one: both are omitted, since
    // every string argument these tools take is required to be non-empty.
    if (value === undefined || value === "") continue;
    if (key in declared) shaped[key] = value;
  }
  return shaped;
}

interface ResultBlock {
  type?: string;
  text?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/**
 * The payload of a tool result.
 *
 * Resource blocks win over text blocks, which is not a detail: GitHub's
 * `get_file_contents` answers a file with *two* blocks — a text block reading
 * "successfully downloaded text file (SHA: …)" and a resource block holding the
 * file itself. Joining them would prefix every file this studio reads with that
 * sentence, which quietly breaks anything that parses what it reads: a
 * `config/site.json` with a status line in front of it is not JSON.
 *
 * A directory listing, by contrast, arrives as a single text block of JSON. So
 * the rule is: if the server attached a resource, the resource is the answer
 * and the text is commentary; otherwise the text is the answer.
 */
export function textOf(result: unknown): string {
  const content = ((result as { content?: ResultBlock[] }).content ?? []).filter(Boolean);

  const resources = content
    .filter((part) => part.type === "resource" && part.resource)
    .map((part) => part.resource!)
    .map((resource) => {
      if (typeof resource.text === "string") return resource.text;
      // A textual file may arrive base64-encoded as a blob instead; a genuinely
      // binary one is not something any caller here reads as text.
      if (typeof resource.blob === "string" && (resource.mimeType ?? "").startsWith("text/")) {
        return Buffer.from(resource.blob, "base64").toString("utf8");
      }
      return "";
    })
    .filter((text) => text !== "");

  if (resources.length > 0) return resources.join("\n");

  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
