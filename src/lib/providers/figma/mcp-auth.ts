import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * What it can do is borrow the token the machine already has. Claude Code
 * completed the interactive OAuth flow against the same account and cached the
 * result — access token, refresh token, and the client credentials it
 * registered with — in ~/.claude/.credentials.json. Reading that store is what
 * lets a headless studio import talk to the hosted server without a browser
 * and without the desktop app.
 *
 * Refreshes are written back to the same file so the studio and Claude Code
 * keep sharing one credential rather than invalidating each other's copy: the
 * refresh token rotates on use, and a rotation we kept to ourselves would log
 * Claude Code out of Figma.
 */

/** Refresh this far ahead of expiry so a slow import cannot straddle it. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

/** Used only if the cached discovery state has no authorization server. */
const FALLBACK_TOKEN_ENDPOINT = "https://api.figma.com/v1/oauth/token";

export interface FigmaMcpAuth {
  token: string;
  /** Where the token came from, for status reporting and error messages. */
  source: "env" | "claude-code";
}

/** One entry of the `mcpOAuth` map in Claude Code's credential store. */
interface StoredOAuth {
  serverName?: string;
  serverUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: number;
  discoveryState?: { authorizationServerUrl?: string };
}

let cached: FigmaMcpAuth | null = null;
/** Serializes refreshes so two concurrent imports cannot both rotate the token. */
let inFlight: Promise<FigmaMcpAuth | null> | null = null;

export function credentialsPath(): string {
  return process.env.CLAUDE_CREDENTIALS_PATH ?? join(homedir(), ".claude", ".credentials.json");
}

/** The desktop Dev Mode server is unauthenticated; only the hosted one needs a token. */
export function needsAuth(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves a bearer token for `serverUrl`, refreshing it if it has expired.
 *
 * Returns null when the server does not need one (the desktop app) or when no
 * credential can be found — callers turn that into an actionable error rather
 * than a bare 401.
 */
export async function resolveFigmaMcpAuth(serverUrl: string): Promise<FigmaMcpAuth | null> {
  const override = process.env.FIGMA_MCP_TOKEN?.trim();
  if (override) return { token: override, source: "env" };

  if (!needsAuth(serverUrl)) return null;
  if (cached) return cached;

  // Collapse concurrent callers onto a single refresh.
  inFlight ??= load(serverUrl).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Drops the cached token so the next call re-reads and, if needed, refreshes. */
export function invalidateFigmaMcpAuth(): void {
  cached = null;
}

async function load(serverUrl: string): Promise<FigmaMcpAuth | null> {
  const path = credentialsPath();
  const store = await readStore(path);
  if (!store) return null;

  const key = pickEntry(store, serverUrl);
  if (!key) return null;

  const entry = store.mcpOAuth[key];
  const fresh = entry.expiresAt !== undefined && entry.expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (fresh && entry.accessToken) {
    cached = { token: entry.accessToken, source: "claude-code" };
    return cached;
  }

  if (!entry.refreshToken || !entry.clientId) {
    // An expired token with nothing to renew it is worse than useless: report
    // it as absent so the caller tells the admin to re-authenticate.
    if (!entry.accessToken) return null;
    cached = { token: entry.accessToken, source: "claude-code" };
    return cached;
  }

  const renewed = await refresh(entry);
  await persist(path, key, renewed);
  cached = { token: renewed.accessToken, source: "claude-code" };
  return cached;
}

async function readStore(path: string): Promise<{ mcpOAuth: Record<string, StoredOAuth> } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpOAuth?: Record<string, StoredOAuth>;
    };
    if (!parsed.mcpOAuth || typeof parsed.mcpOAuth !== "object") return null;
    return { mcpOAuth: parsed.mcpOAuth };
  } catch {
    // No store, no permission, or corrupt JSON — all mean "no credential here".
    return null;
  }
}

/**
 * Finds the entry for this server.
 *
 * Matching on host rather than the exact URL keeps a trailing slash or a /sse
 * suffix from missing the credential; the server name is the fallback because
 * older stores recorded it without a URL.
 */
function pickEntry(
  store: { mcpOAuth: Record<string, StoredOAuth> },
  serverUrl: string,
): string | null {
  let host: string | null = null;
  try {
    host = new URL(serverUrl).host;
  } catch {
    host = null;
  }

  const entries = Object.entries(store.mcpOAuth);
  const byHost = entries.find(([, v]) => {
    if (!v.accessToken || !v.serverUrl || !host) return false;
    try {
      return new URL(v.serverUrl).host === host;
    } catch {
      return false;
    }
  });
  if (byHost) return byHost[0];

  const byName = entries.find(([, v]) => Boolean(v.accessToken) && v.serverName === "figma");
  return byName ? byName[0] : null;
}

interface Renewed {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function refresh(entry: StoredOAuth): Promise<Renewed> {
  const endpoint = await tokenEndpoint(entry.discoveryState?.authorizationServerUrl);

  // Figma advertises client_secret_post, so the credentials go in the body.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.refreshToken as string,
    client_id: entry.clientId as string,
  });
  if (entry.clientSecret) body.set("client_secret", entry.clientSecret);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Refreshing the Figma MCP token failed (HTTP ${response.status}). ` +
        `Re-authenticate by running \`claude\` and using /mcp to reconnect the figma server. ` +
        `(${(await response.text().catch(() => "")).slice(0, 200)})`,
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("The Figma token endpoint returned no access_token.");
  }

  return {
    accessToken: json.access_token,
    // Figma may or may not rotate the refresh token; keeping the old one when
    // none comes back is what the OAuth spec requires.
    refreshToken: json.refresh_token ?? (entry.refreshToken as string),
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Discovers the token endpoint, falling back to Figma's published one. */
async function tokenEndpoint(authorizationServerUrl: string | undefined): Promise<string> {
  if (!authorizationServerUrl) return FALLBACK_TOKEN_ENDPOINT;
  try {
    const metadataUrl = new URL(
      "/.well-known/oauth-authorization-server",
      authorizationServerUrl,
    );
    const response = await fetch(metadataUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) return FALLBACK_TOKEN_ENDPOINT;
    const metadata = (await response.json()) as { token_endpoint?: string };
    return metadata.token_endpoint ?? FALLBACK_TOKEN_ENDPOINT;
  } catch {
    return FALLBACK_TOKEN_ENDPOINT;
  }
}

/**
 * Writes the rotated tokens back into Claude Code's store.
 *
 * The file is re-read immediately before the write and replaced by rename, so
 * a concurrent refresh by Claude Code itself loses at most its own entry
 * rather than the whole file. A failure here is deliberately swallowed: the
 * token in hand is already valid, and an import should not fail because a
 * cache could not be updated.
 */
async function persist(path: string, key: string, renewed: Renewed): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      mcpOAuth?: Record<string, StoredOAuth>;
    };
    if (!raw.mcpOAuth?.[key]) return;

    raw.mcpOAuth[key] = {
      ...raw.mcpOAuth[key],
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken,
      expiresAt: renewed.expiresAt,
    };

    const temp = join(dirname(path), `.credentials.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    await rename(temp, path);
  } catch {
    // Nothing actionable: the caller already has a working token.
  }
}
