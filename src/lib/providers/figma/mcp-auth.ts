import {
  credentialsPath,
  invalidateMcpBearer,
  needsAuth,
  resolveMcpBearer,
  type McpBearer,
  type McpServer,
} from "@/lib/providers/mcp-oauth";

/**
 * Bearer credentials for Figma's *hosted* MCP server.
 *
 * There are two Figma MCP servers and only one of them is anonymous. The Dev
 * Mode server inside the desktop app serves 127.0.0.1 with no auth at all; the
 * hosted server at https://mcp.figma.com/mcp requires an OAuth 2.1 access
 * token and rejects everything else — including a perfectly valid `figd_`
 * personal access token, which it answers with:
 *
 *     figd_ tokens must be passed via X-Figma-Token header, not Authorization
 *
 * and then 401s that header too. Figma advertises dynamic client registration
 * at /v1/oauth/mcp/register but returns 403 to the public, so this application
 * cannot register an OAuth client of its own and cannot mint its own token.
 *
 * What it can do is borrow the token the machine already has, out of the store
 * Claude Code cached it in. That mechanism is shared with the GitHub MCP
 * backend and lives in `@/lib/providers/mcp-oauth`; what is Figma-specific is
 * only the server identity below, the FIGMA_MCP_TOKEN override, and the token
 * endpoint to fall back to when discovery fails.
 */

/** Used only if the cached discovery state has no authorization server. */
const FALLBACK_TOKEN_ENDPOINT = "https://api.figma.com/v1/oauth/token";

const SERVER: Omit<McpServer, "serverUrl"> = {
  serverName: "figma",
  fallbackTokenEndpoint: FALLBACK_TOKEN_ENDPOINT,
  label: "Figma",
};

export type FigmaMcpAuth = McpBearer;

export { credentialsPath, needsAuth };

/**
 * Resolves a bearer token for `serverUrl`, refreshing it if it has expired.
 *
 * Returns null when the server does not need one (the desktop app) or when no
 * credential can be found — callers turn that into an actionable error rather
 * than a bare 401.
 */
export async function resolveFigmaMcpAuth(serverUrl: string): Promise<FigmaMcpAuth | null> {
  return resolveMcpBearer({ ...SERVER, serverUrl }, process.env.FIGMA_MCP_TOKEN);
}

/** Drops the cached token so the next call re-reads and, if needed, refreshes. */
export function invalidateFigmaMcpAuth(): void {
  invalidateMcpBearer(SERVER.serverName);
}
