import {
  hasCachedCredential,
  invalidateMcpBearer,
  resolveMcpBearer,
  type McpServer,
} from "@/lib/providers/mcp-oauth";

/**
 * Bearer credentials for GitHub's hosted MCP server.
 *
 * GitHub's server at https://api.githubcopilot.com/mcp/ answers an
 * unauthenticated request with
 *
 *     WWW-Authenticate: Bearer error="invalid_request",
 *       resource_metadata=".../.well-known/oauth-protected-resource/mcp/"
 *
 * and that metadata names `https://github.com/login/oauth` as the authorization
 * server, with `repo` among its supported scopes. There are therefore two ways
 * to hold a credential for it, and this module supports both:
 *
 * A PERSONAL ACCESS TOKEN in GITHUB_MCP_TOKEN (or GITHUB_TOKEN). Simple, and
 * the same token the REST backend uses.
 *
 * THE OAUTH TOKEN CLAUDE CODE ALREADY HAS. `claude mcp add --transport http
 * github https://api.githubcopilot.com/mcp/` followed by /mcp completes the
 * flow interactively once; the studio then borrows the cached token and
 * refreshes it when it expires. This is the path to prefer when an
 * administrator would rather not mint and store a long-lived PAT — the token is
 * short-lived, scoped by the consent screen, and revocable from GitHub's
 * settings without touching this application's configuration.
 *
 * The order is deliberate: an explicitly configured token wins, because
 * somebody set it on purpose; otherwise the cached OAuth credential; otherwise
 * GITHUB_TOKEN, which is what a deployment that never thought about MCP already
 * has.
 */

/** Where GitHub's authorization server issues tokens, if discovery fails. */
const FALLBACK_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

/**
 * GitHub's hosted MCP server.
 *
 * Lives here rather than beside either backend because both of them need it and
 * this module imports nothing else from the directory — anywhere else it would
 * close an import cycle.
 */
export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/**
 * The name to register the server under.
 *
 * It matters: the credential store is searched by host first and by this name
 * second, so a server added under a different name still resolves by host, and
 * one recorded without a URL only resolves if the names agree.
 */
export const GITHUB_MCP_SERVER_NAME = "github";

function server(serverUrl: string): McpServer {
  return {
    serverName: GITHUB_MCP_SERVER_NAME,
    serverUrl,
    fallbackTokenEndpoint: FALLBACK_TOKEN_ENDPOINT,
    label: "GitHub",
  };
}

/** An explicitly configured token, if there is one. */
function override(): string {
  return (process.env.GITHUB_MCP_TOKEN ?? "").trim();
}

export interface GitHubMcpAuth {
  token: string;
  /**
   * Which of the three credentials answered. Reported because the remedy for a
   * rejected token depends entirely on where it came from.
   */
  source: "env" | "claude-code" | "github-token";
}

/**
 * Resolves a bearer token for the GitHub MCP server.
 *
 * Returns null only when nothing is configured anywhere, which callers turn
 * into a message naming the two ways to fix it rather than a bare 401.
 */
export async function resolveGitHubMcpAuth(serverUrl: string): Promise<GitHubMcpAuth | null> {
  const configured = override();
  if (configured) return { token: configured, source: "env" };

  const cached = await resolveMcpBearer(server(serverUrl));
  if (cached) return cached;

  const fallback = (process.env.GITHUB_TOKEN ?? "").trim();
  return fallback ? { token: fallback, source: "github-token" } : null;
}

/** Drops the cached token so the next call re-reads and, if needed, refreshes. */
export function invalidateGitHubMcpAuth(): void {
  invalidateMcpBearer(GITHUB_MCP_SERVER_NAME);
}

export interface GitHubMcpCredentialState {
  /** Whether a token can be produced at all. */
  available: boolean;
  source: "env" | "claude-code" | "github-token" | "none";
  detail: string;
}

/**
 * What credential the MCP backend would use, decided without spending a
 * request.
 *
 * Synchronous because capability reporting runs on every studio page load. It
 * can only report which credential *would* be tried — whether GitHub accepts it
 * is not knowable without asking GitHub.
 */
export function gitHubMcpCredentialState(serverUrl: string): GitHubMcpCredentialState {
  if (override()) {
    return {
      available: true,
      source: "env",
      detail: "Using the token in GITHUB_MCP_TOKEN.",
    };
  }

  if (hasCachedCredential({ serverName: GITHUB_MCP_SERVER_NAME, serverUrl })) {
    return {
      available: true,
      source: "claude-code",
      detail:
        "Using the OAuth token Claude Code cached for the github MCP server, refreshed as needed.",
    };
  }

  if ((process.env.GITHUB_TOKEN ?? "").trim()) {
    return {
      available: true,
      source: "github-token",
      detail:
        "Authenticating with GITHUB_TOKEN, since GITHUB_MCP_TOKEN is not set. If the server refuses it, the token needs access to the repository — or set GITHUB_MCP_TOKEN to one that has it.",
    };
  }

  return {
    available: false,
    source: "none",
    detail:
      "No credential for the GitHub MCP server. Either authorise it once (`claude mcp add --transport http github https://api.githubcopilot.com/mcp/`, then /mcp in an interactive session), or set GITHUB_MCP_TOKEN.",
  };
}
