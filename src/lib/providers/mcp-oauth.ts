import { readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Bearer credentials for a hosted MCP server, borrowed from Claude Code.
 *
 * Two of this studio's providers talk to remote MCP servers that require OAuth
 * 2.1 and will not accept a personal access token: Figma's hosted server, and
 * GitHub's. Neither lets this application register an OAuth client of its own —
 * Figma returns 403 to public dynamic registration, and GitHub's authorization
 * server issues no client credentials to an unregistered app — so neither token
 * can be minted here.
 *
 * What can be done is to borrow the token the machine already has. Claude Code
 * completed the interactive flow against the same account and cached the result
 * — access token, refresh token, and the client credentials it registered with
 * — in ~/.claude/.credentials.json. Reading that store is what lets a headless
 * studio talk to a hosted MCP server with no browser and no second login.
 *
 * Refreshes are written back to the same file so the studio and Claude Code
 * keep sharing one credential rather than invalidating each other's copy: the
 * refresh token rotates on use, and a rotation we kept to ourselves would log
 * Claude Code out.
 *
 * This module is the mechanism only. Everything server-specific — which
 * environment variable overrides it, which token endpoint to fall back to, what
 * to tell an administrator when it is missing — is supplied by the caller; see
 * `figma/mcp-auth.ts` and `github/mcp-auth.ts`.
 */

/** Refresh this far ahead of expiry so a slow operation cannot straddle it. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

export interface McpServer {
  /** The name Claude Code registered the server under, for the name fallback. */
  serverName: string;
  serverUrl: string;
  /** Used when discovery yields no token endpoint. */
  fallbackTokenEndpoint: string;
  /** Admin-facing server name, for error messages. */
  label: string;
}

export interface McpBearer {
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

/** Per-server, because one process may hold tokens for several. */
const cached = new Map<string, McpBearer>();
/** Serializes refreshes so two concurrent callers cannot both rotate a token. */
const inFlight = new Map<string, Promise<McpBearer | null>>();

export function credentialsPath(): string {
  return process.env.CLAUDE_CREDENTIALS_PATH ?? join(homedir(), ".claude", ".credentials.json");
}

/**
 * Whether this server needs a token at all.
 *
 * A server on the loopback interface is one the machine is already running —
 * Figma's Dev Mode server is the example — and those are unauthenticated.
 */
export function needsAuth(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves a bearer token for `server`, refreshing it if it has expired.
 *
 * Returns null when the server needs no token, or when no credential can be
 * found — callers turn that into an actionable error rather than a bare 401.
 */
export async function resolveMcpBearer(
  server: McpServer,
  override?: string,
): Promise<McpBearer | null> {
  const supplied = override?.trim();
  if (supplied) return { token: supplied, source: "env" };

  if (!needsAuth(server.serverUrl)) return null;

  const key = server.serverName;
  const hit = cached.get(key);
  if (hit) return hit;

  // Collapse concurrent callers onto a single refresh.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = load(server).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

/** Drops the cached token so the next call re-reads and, if needed, refreshes. */
export function invalidateMcpBearer(serverName: string): void {
  cached.delete(serverName);
}

/**
 * Whether a credential for this server is cached, without reading it.
 *
 * Synchronous on purpose: capability reporting runs on every studio page load
 * and has to say whether a server is usable *before* anything tries to use it.
 * It answers the weaker question — is there an entry with an access token —
 * because whether that token still works cannot be known without spending a
 * round trip.
 */
export function hasCachedCredential(server: Pick<McpServer, "serverName" | "serverUrl">): boolean {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as {
      mcpOAuth?: Record<string, StoredOAuth>;
    };
    return pickEntry(raw.mcpOAuth ?? {}, server) !== null;
  } catch {
    return false;
  }
}

async function load(server: McpServer): Promise<McpBearer | null> {
  const path = credentialsPath();
  const store = await readStore(path);
  if (!store) return null;

  const key = pickEntry(store, server);
  if (!key) return null;

  const entry = store[key];
  const fresh = entry.expiresAt !== undefined && entry.expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (fresh && entry.accessToken) return remember(server, entry.accessToken);

  if (!entry.refreshToken || !entry.clientId) {
    // An expired token with nothing to renew it is worse than useless: report
    // it as absent so the caller tells the admin to re-authenticate.
    if (!entry.accessToken) return null;
    return remember(server, entry.accessToken);
  }

  const renewed = await refresh(entry, server);
  await persist(path, key, renewed);
  return remember(server, renewed.accessToken);
}

function remember(server: McpServer, token: string): McpBearer {
  const bearer: McpBearer = { token, source: "claude-code" };
  cached.set(server.serverName, bearer);
  return bearer;
}

async function readStore(path: string): Promise<Record<string, StoredOAuth> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpOAuth?: Record<string, StoredOAuth>;
    };
    if (!parsed.mcpOAuth || typeof parsed.mcpOAuth !== "object") return null;
    return parsed.mcpOAuth;
  } catch {
    // No store, no permission, or corrupt JSON — all mean "no credential here".
    return null;
  }
}

/**
 * Finds the entry for this server.
 *
 * Matching on host rather than the exact URL keeps a trailing slash or an /sse
 * suffix from missing the credential; the server name is the fallback because
 * older stores recorded it without a URL.
 */
function pickEntry(
  store: Record<string, StoredOAuth>,
  server: Pick<McpServer, "serverName" | "serverUrl">,
): string | null {
  let host: string | null = null;
  try {
    host = new URL(server.serverUrl).host;
  } catch {
    host = null;
  }

  const entries = Object.entries(store);
  const byHost = entries.find(([, value]) => {
    if (!value.accessToken || !value.serverUrl || !host) return false;
    try {
      return new URL(value.serverUrl).host === host;
    } catch {
      return false;
    }
  });
  if (byHost) return byHost[0];

  const byName = entries.find(
    ([, value]) => Boolean(value.accessToken) && value.serverName === server.serverName,
  );
  return byName ? byName[0] : null;
}

interface Renewed {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function refresh(entry: StoredOAuth, server: McpServer): Promise<Renewed> {
  const endpoint = await tokenEndpoint(entry.discoveryState?.authorizationServerUrl, server);

  // Both servers advertise client_secret_post, so credentials go in the body.
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
      `Refreshing the ${server.label} MCP token failed (HTTP ${response.status}). ` +
        `Re-authenticate by running \`claude\` and using /mcp to reconnect the ${server.serverName} server. ` +
        `(${(await response.text().catch(() => "")).slice(0, 200)})`,
    );
  }

  /*
    GitHub's token endpoint answers form-encoded unless asked for JSON, and
    answers 200 with an `error` field rather than an error status when a grant
    is rejected — so neither the content type nor the status can be trusted on
    its own.
  */
  const json = parseTokenResponse(await response.text());

  if (json.error || !json.access_token) {
    throw new Error(
      `The ${server.label} token endpoint refused the refresh${json.error ? ` (${json.error})` : ""}. ` +
        `Re-authenticate by running \`claude\` and using /mcp to reconnect the ${server.serverName} server.`,
    );
  }

  return {
    accessToken: json.access_token,
    // A server may or may not rotate the refresh token; keeping the old one
    // when none comes back is what the OAuth spec requires.
    refreshToken: json.refresh_token ?? (entry.refreshToken as string),
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

function parseTokenResponse(text: string): TokenResponse {
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    const params = new URLSearchParams(text);
    const expires = Number.parseInt(params.get("expires_in") ?? "", 10);
    return {
      access_token: params.get("access_token") ?? undefined,
      refresh_token: params.get("refresh_token") ?? undefined,
      expires_in: Number.isFinite(expires) ? expires : undefined,
      error: params.get("error") ?? undefined,
    };
  }
}

/**
 * Discovers the token endpoint, falling back to the caller's published one.
 *
 * Both RFC 8414 forms are tried, because the two servers this studio talks to
 * disagree about which they serve. Figma's authorization server is an origin,
 * so its metadata sits at the root. GitHub's is `https://github.com/login/oauth`
 * — a path — and the spec inserts the well-known segment *before* that path, so
 * the document lives at `github.com/.well-known/oauth-authorization-server/
 * login/oauth` and the root form returns HTML. Trying the path-inserted form
 * first costs one request on a refresh and is the only form that works for a
 * path-based issuer.
 */
async function tokenEndpoint(
  authorizationServerUrl: string | undefined,
  server: McpServer,
): Promise<string> {
  if (!authorizationServerUrl) return server.fallbackTokenEndpoint;

  let base: URL;
  try {
    base = new URL(authorizationServerUrl);
  } catch {
    return server.fallbackTokenEndpoint;
  }

  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, base),
    new URL("/.well-known/oauth-authorization-server", base),
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const metadata = (await response.json()) as { token_endpoint?: string };
      if (metadata.token_endpoint) return metadata.token_endpoint;
    } catch {
      // Try the next form, then the caller's fallback.
    }
  }

  return server.fallbackTokenEndpoint;
}

/**
 * Writes the rotated tokens back into Claude Code's store.
 *
 * The file is re-read immediately before the write and replaced by rename, so a
 * concurrent refresh by Claude Code itself loses at most its own entry rather
 * than the whole file. A failure here is deliberately swallowed: the token in
 * hand is already valid, and an operation should not fail because a cache could
 * not be updated.
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
