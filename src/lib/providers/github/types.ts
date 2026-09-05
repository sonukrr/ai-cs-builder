/**
 * The approved base career site, read through GitHub.
 *
 * 07-base-site-flow.md draws a hard line: the agent may read the repository,
 * discover pages and components, read configuration, create a company branch
 * and commit *controlled* changes. It may never touch the protected main branch
 * or rewrite core architecture. That line is enforced here, in the provider,
 * rather than left to the model's discretion — `commitFiles` refuses a
 * protected branch and refuses paths outside the allowed configuration surface.
 */

export interface BaseSiteFile {
  path: string;
  content: string;
}

export interface BaseSiteContext {
  repo: string;
  defaultBranch: string;
  /** How the repo is built. Discovery differs sharply between these. */
  framework: "angular" | "next" | "unknown";
  readme: string;
  /** Every file path in the repo, for structure discovery. */
  tree: string[];
  /** Contents of the config files the agent is allowed to change. */
  config: BaseSiteFile[];
  /**
   * Read-only files that explain how the app is wired — the routing module, the
   * app module, the environment. The agent needs these to reason about the base
   * site, and must never write to them.
   */
  keyFiles: BaseSiteFile[];
  /** Reusable presentation components discovered in the repo. */
  components: { name: string; path: string }[];
  /** Routes discovered in the repo. */
  pages: { name: string; path: string }[];
  warnings: string[];
}

export interface BaseSiteProvider {
  readonly backend: "rest" | "mcp" | "mock";
  readonly configured: boolean;
  readContext(repo: string): Promise<BaseSiteContext>;
  createBranch(repo: string, branch: string, fromBranch?: string): Promise<{ branch: string; url: string }>;
  commitFiles(
    repo: string,
    branch: string,
    files: BaseSiteFile[],
    message: string,
  ): Promise<{ commitUrl: string; files: string[] }>;
}

/** Branches the agent must never write to, whatever it is asked. */
export const PROTECTED_BRANCHES = ["main", "master", "production", "release"];

/**
 * Paths the agent may commit to.
 *
 * 07-base-site-flow.md asks for configuration to be the customization target
 * before arbitrary React source. Anything outside this list is refused, so a
 * conversational request cannot escalate into rewriting the app.
 */
export const WRITABLE_PATTERNS = [
  /^config\/[\w-]+\.json$/,
  /^site\.config\.json$/,
  /^theme\.json$/,
  /^content\.json$/,
  /^public\/brand\/[\w.-]+$/,
  /^blueprint\.json$/,
];

export function isWritable(filePath: string): boolean {
  const normalized = filePath.replace(/^\.?\//, "");
  if (normalized.includes("..")) return false;
  return WRITABLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Accepts an owner/name pair or any GitHub URL pointing at a repo. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const direct = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (direct) return { owner: direct[1], name: direct[2] };

  try {
    const url = new URL(trimmed);
    if (!/(^|\.)github\.com$/.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], name: parts[1].replace(/\.git$/, "") };
  } catch {
    return null;
  }
}
