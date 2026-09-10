import { baseSiteRepo } from "./index";
import { parseRepo } from "./types";

/**
 * The destination repository — where a generated career site is pushed.
 *
 * Deliberately a different thing from the base site provider next door, with
 * different rules, because the two repositories mean opposite things.
 *
 * The *base* repository is somebody else's approved application. 07-base-site-
 * flow.md is emphatic that the agent may read it, branch it, and write a narrow
 * allow-list of configuration files, and nothing more — so `types.ts` refuses
 * protected branches and refuses paths outside that surface.
 *
 * A *destination* repository is generated output that the studio owns
 * end-to-end: it exists to hold `emitReactSite`'s files and to be built by
 * Vercel. Restricting writes to `config/*.json` there would make it impossible
 * to write a site at all. So the allow-list does not apply, and the guard rails
 * are different ones instead:
 *
 *  - the destination is never inferred. An administrator supplies it, per
 *    project, and it is stored on the project;
 *  - it may not be the base repository, whatever anyone types. Pushing a
 *    generated site over the approved base would destroy the thing every other
 *    project starts from;
 *  - a repository that already holds something the studio did not generate is
 *    refused unless the caller says explicitly that overwriting is intended;
 *  - a push is one commit that makes the tree match the generated site, with
 *    files outside the generated directories left alone — so a LICENSE or a
 *    workflow somebody added survives, and a page deleted in the studio does
 *    not linger on the live site.
 */

export interface DeployFile {
  path: string;
  /** UTF-8 text, or base64 when `encoding` says so. */
  content: string;
  encoding: "utf-8" | "base64";
}

export interface RepoState {
  repo: string;
  owner: string;
  name: string;
  exists: boolean;
  /** "" for a repository that exists but has no commits yet. */
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  /** No commits at all — the first push does not need a parent. */
  empty: boolean;
  /**
   * Whether the repository looks like a previous publish of a studio site.
   * A `blueprint.json` at the root is the marker, because that is the one file
   * `emitReactSite` always writes and nothing else has a reason to.
   */
  generatedByStudio: boolean;
  /** Paths at the repository root, for a human to recognise what is there. */
  rootEntries: string[];
}

export interface PushResult {
  branch: string;
  commitSha: string;
  commitUrl: string;
  treeUrl: string;
  /** Files written in this commit. */
  written: number;
  /** Generated files removed because the site no longer has them. */
  removed: string[];
  warnings: string[];
}

/** Whether this credential may actually write to a repository. */
export interface WriteAccess {
  ok: boolean;
  /** What to do about it, when it is not ok. */
  detail: string;
}

export interface DeployTargetProvider {
  readonly backend: "rest" | "mcp" | "mock";
  readonly configured: boolean;
  describe(repo: string): Promise<RepoState>;
  /** Checked before anything is generated; see `checkWriteAccess`. */
  checkWriteAccess(repo: string): Promise<WriteAccess>;
  create(repo: string, options: { private: boolean; description: string }): Promise<RepoState>;
  push(input: {
    repo: string;
    branch: string;
    files: DeployFile[];
    message: string;
    /** Required when the repository holds content the studio did not generate. */
    allowNonEmpty?: boolean;
  }): Promise<PushResult>;
}

/**
 * Directories the generated site owns.
 *
 * A push clears anything under these that the site no longer emits, and leaves
 * everything else in the repository alone. The distinction matters: `app/` is
 * generated output and a stale route there is a page that was deleted in the
 * studio but is still live, whereas a `.github/workflows/deploy.yml` somebody
 * wrote by hand is theirs and must survive a republish.
 */
const GENERATED_PREFIXES = ["app/", "components/", "lib/", "public/images/"];

/** Files at the root that `emitReactSite` writes and therefore may replace. */
const GENERATED_ROOT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.mjs",
  "next-env.d.ts",
  ".gitignore",
  "blueprint.json",
  "README.md",
]);

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix)) || GENERATED_ROOT_FILES.has(path);
}

/**
 * Files a republish should remove: in the repository, generated output, and no
 * longer emitted.
 *
 * A page deleted in the studio has to stop being live, or the studio is lying
 * about what the site is. Anything outside the generated directories is
 * somebody's own work and is never touched.
 */
export function staleGeneratedFiles(existing: string[], emitted: string[]): string[] {
  const kept = new Set(emitted);
  return existing.filter((path) => !kept.has(path) && isGeneratedPath(path));
}

/**
 * The destination a project may not have.
 *
 * Compared by owner/name rather than by string, so neither a URL nor a `.git`
 * suffix nor a change of case gets a generated site pushed over the approved
 * base repository.
 */
export function refusedDestination(repo: string): string | null {
  const parsed = parseRepo(repo);
  if (!parsed) {
    return `"${repo}" is not a GitHub repository. Give it as owner/name or as a github.com URL.`;
  }

  const base = parseRepo(baseSiteRepo());
  if (
    base &&
    base.owner.toLowerCase() === parsed.owner.toLowerCase() &&
    base.name.toLowerCase() === parsed.name.toLowerCase()
  ) {
    return `Refusing ${parsed.owner}/${parsed.name}: that is the approved base career site every project starts from, not a destination for generated output.`;
  }

  return null;
}

const API = "https://api.github.com";

/** Blobs this large are uncommon in a career site and slow to push. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
}

export class GitHubRestDeployProvider implements DeployTargetProvider {
  readonly backend = "rest" as const;
  readonly configured: boolean;

  private readonly token: string;
  private user: string | null = null;

  constructor(token: string) {
    this.token = token;
    this.configured = Boolean(token);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub ${response.status} on ${path}: ${body.slice(0, 300)}`);
    }
    // 204 on some ref operations.
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private target(repo: string): { owner: string; name: string } {
    const refused = refusedDestination(repo);
    if (refused) throw new Error(refused);
    return parseRepo(repo)!;
  }

  private async whoami(): Promise<string> {
    if (this.user === null) {
      this.user = (await this.api<{ login: string }>("/user")).login;
    }
    return this.user;
  }

  async describe(repo: string): Promise<RepoState> {
    const { owner, name } = this.target(repo);
    const absent: RepoState = {
      repo: `${owner}/${name}`,
      owner,
      name,
      exists: false,
      defaultBranch: "",
      private: true,
      htmlUrl: `https://github.com/${owner}/${name}`,
      empty: true,
      generatedByStudio: false,
      rootEntries: [],
    };

    let meta: { default_branch: string; private: boolean; html_url: string };
    try {
      meta = await this.api(`/repos/${owner}/${name}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("GitHub 404")) return absent;
      throw error;
    }

    // A repository created without auto_init has a default branch name but no
    // commit behind it, and every read of its contents 404s. That is a
    // different state from "does not exist" and the first push differs.
    let rootEntries: string[] = [];
    let empty = false;
    try {
      const contents = await this.api<{ name: string; path: string }[]>(
        `/repos/${owner}/${name}/contents/?ref=${encodeURIComponent(meta.default_branch)}`,
      );
      rootEntries = contents.map((entry) => entry.path).sort();
    } catch (error) {
      if (error instanceof Error && error.message.includes("GitHub 404")) empty = true;
      else throw error;
    }

    return {
      repo: `${owner}/${name}`,
      owner,
      name,
      exists: true,
      defaultBranch: meta.default_branch,
      private: meta.private,
      htmlUrl: meta.html_url,
      empty,
      generatedByStudio: rootEntries.includes("blueprint.json"),
      rootEntries,
    };
  }

  /**
   * Creates the destination repository.
   *
   * Deliberately without `auto_init`: an initial commit GitHub wrote would be a
   * README this project did not generate, which is exactly the "content the
   * studio did not create" case that `push` then refuses.
   */
  async create(repo: string, options: { private: boolean; description: string }): Promise<RepoState> {
    const { owner, name } = this.target(repo);
    const me = await this.whoami();
    const path = owner.toLowerCase() === me.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`;

    try {
      await this.api(path, {
        method: "POST",
        body: JSON.stringify({
          name,
          private: options.private,
          description: options.description.slice(0, 300),
          auto_init: false,
          has_issues: false,
          has_projects: false,
          has_wiki: false,
        }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // GitHub answers 404 for a private repository the token cannot see, so
      // "does not exist" and "exists and is invisible to this token" arrive
      // identically — and only creation tells them apart. Naming the real
      // problem here saves an administrator from hunting for a repository they
      // are looking at in another tab.
      if (/already exists/i.test(detail)) {
        throw new Error(
          `${owner}/${name} already exists but this GitHub token cannot see it. Grant the token access to the repository, or use one that has it.`,
        );
      }
      throw new Error(`Could not create ${owner}/${name}: ${detail}`);
    }

    return this.describe(`${owner}/${name}`);
  }

  /** Every blob path in a tree. */
  private async treeAt(
    owner: string,
    name: string,
    treeSha: string,
  ): Promise<{ paths: string[]; truncated: boolean }> {
    const response = await this.api<{
      tree: { path: string; type: string }[];
      truncated: boolean;
    }>(`/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`);

    return {
      paths: response.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
      truncated: response.truncated,
    };
  }

  /**
   * Every blob path on a branch.
   *
   * Public because the MCP backend needs it too: MCP can delete a file but has
   * no tool that lists a tree recursively, and walking it directory by
   * directory would be a call per folder to answer a question one call answers
   * here.
   */
  async branchPaths(repo: string, branch: string): Promise<{ paths: string[]; truncated: boolean }> {
    const { owner, name } = this.target(repo);
    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const commit = await this.api<{ tree: { sha: string } }>(
      `/repos/${owner}/${name}/git/commits/${ref.object.sha}`,
    );
    return this.treeAt(owner, name, commit.tree.sha);
  }

  /**
   * Whether this token can write to the repository, established by trying.
   *
   * Asking is not an option. A repository's `permissions` field reports the
   * *user's* role, so a fine-grained token whose owner is an admin reports
   * `push: true` and then fails every write with "Resource not accessible by
   * personal access token" — which is exactly how a publish came to generate
   * an entire site and fall over on the first blob.
   *
   * So this creates a blob and throws the result away. A blob no tree
   * references is unreachable and pruned by GitHub, so a successful probe
   * leaves nothing behind, and a failed one comes back with GitHub's own
   * `x-accepted-github-permissions` header naming the permission to grant.
   */
  async checkWriteAccess(repo: string): Promise<WriteAccess> {
    const { owner, name } = this.target(repo);

    const response = await fetch(`${API}/repos/${owner}/${name}/git/blobs`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "studio-preflight", encoding: "utf-8" }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) return { ok: true, detail: "" };

    const needed = response.headers.get("x-accepted-github-permissions") ?? "";
    const body = await response.text().catch(() => "");

    if (response.status === 403 || response.status === 401) {
      return {
        ok: false,
        detail:
          `The GitHub token cannot write to ${owner}/${name} (${response.status}: ${
            body.includes("not accessible") ? "resource not accessible by personal access token" : body.slice(0, 120)
          })` +
          `${needed ? `. GitHub says it needs ${needed}` : ""}` +
          `. For a fine-grained token: github.com/settings/personal-access-tokens, edit the token, add Repository permissions -> Contents: Read and write, and make sure ${owner}/${name} is in its selected repositories. A classic token needs the \`repo\` scope.`,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        detail: `${owner}/${name} is not visible to this token — it either does not exist or is not in the token's selected repositories.`,
      };
    }

    return { ok: false, detail: `GitHub ${response.status} on a write probe: ${body.slice(0, 160)}` };
  }

  async push(input: {
    repo: string;
    branch: string;
    files: DeployFile[];
    message: string;
    allowNonEmpty?: boolean;
  }): Promise<PushResult> {
    const { owner, name } = this.target(input.repo);
    const warnings: string[] = [];

    const oversized = input.files.filter((file) => file.content.length > MAX_FILE_BYTES);
    if (oversized.length > 0) {
      throw new Error(`Refusing to push oversized files: ${oversized.map((f) => f.path).join(", ")}`);
    }

    const state = await this.describe(`${owner}/${name}`);
    if (!state.exists) {
      throw new Error(
        `${owner}/${name} does not exist. Create it first, or ask the administrator to create it and grant the token access.`,
      );
    }
    if (!state.empty && !state.generatedByStudio && !input.allowNonEmpty) {
      throw new Error(
        `${owner}/${name} already contains files the studio did not generate (${state.rootEntries
          .slice(0, 8)
          .join(", ")}). Publishing would overwrite them. Confirm with the administrator that this repository is meant to hold the generated site.`,
      );
    }

    const branch = input.branch || state.defaultBranch || "main";

    /* The parent commit, if the branch has one. */
    let parentSha = "";
    let baseTreeSha = "";
    if (!state.empty) {
      try {
        const ref = await this.api<{ object: { sha: string } }>(
          `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
        );
        parentSha = ref.object.sha;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("GitHub 404"))) throw error;
        // A new branch on an existing repository starts from the default one,
        // so an unrelated history is never created by accident.
        const base = await this.api<{ object: { sha: string } }>(
          `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(state.defaultBranch)}`,
        );
        parentSha = base.object.sha;
      }

      const commit = await this.api<{ tree: { sha: string } }>(
        `/repos/${owner}/${name}/git/commits/${parentSha}`,
      );
      baseTreeSha = commit.tree.sha;
    }

    /* Stale generated files: in the repository, ours to own, not emitted now. */
    const removed: string[] = [];
    if (baseTreeSha) {
      const existing = await this.treeAt(owner, name, baseTreeSha);
      if (existing.truncated) {
        warnings.push(
          "The repository's file list came back truncated, so a stale generated file may have been left behind.",
        );
      }
      removed.push(...staleGeneratedFiles(existing.paths, input.files.map((file) => file.path)));
    }

    /* Blobs, then one tree, then one commit. */
    const entries: TreeEntry[] = [];
    for (const file of input.files) {
      const blob = await this.api<{ sha: string }>(`/repos/${owner}/${name}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: file.content,
          encoding: file.encoding === "base64" ? "base64" : "utf-8",
        }),
      });
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const path of removed) {
      // A null sha in a tree built on a base tree is how the git API expresses
      // a deletion.
      entries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    const tree = await this.api<{ sha: string }>(`/repos/${owner}/${name}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: entries }),
    });

    const commit = await this.api<{ sha: string; html_url: string }>(
      `/repos/${owner}/${name}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: input.message,
          tree: tree.sha,
          parents: parentSha ? [parentSha] : [],
        }),
      },
    );

    /* Move the branch. Created rather than updated the first time. */
    try {
      await this.api(`/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } catch (error) {
      const missing = error instanceof Error && /GitHub 4(0|2)[24]/.test(error.message);
      if (!missing) throw error;
      await this.api(`/repos/${owner}/${name}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    }

    return {
      branch,
      commitSha: commit.sha,
      commitUrl: commit.html_url,
      treeUrl: `https://github.com/${owner}/${name}/tree/${branch}`,
      written: input.files.length,
      removed,
      warnings,
    };
  }
}

/**
 * The stand-in, for a deployment with no credentials.
 *
 * It reports what would happen and pushes nothing, so the whole flow —
 * generate, review the file list, record the deployment — can be exercised and
 * demonstrated without a token. It never claims a URL that does not exist.
 */
export class MockDeployProvider implements DeployTargetProvider {
  readonly backend = "mock" as const;
  readonly configured = true;

  async describe(repo: string): Promise<RepoState> {
    const refused = refusedDestination(repo);
    if (refused) throw new Error(refused);
    const { owner, name } = parseRepo(repo)!;
    return {
      repo: `${owner}/${name}`,
      owner,
      name,
      exists: true,
      defaultBranch: "main",
      private: true,
      htmlUrl: `https://github.com/${owner}/${name}`,
      empty: true,
      generatedByStudio: false,
      rootEntries: [],
    };
  }

  async create(repo: string): Promise<RepoState> {
    return this.describe(repo);
  }

  async checkWriteAccess(): Promise<WriteAccess> {
    return { ok: true, detail: "" };
  }

  async push(input: { repo: string; branch: string; files: DeployFile[] }): Promise<PushResult> {
    const { owner, name } = parseRepo(input.repo)!;
    return {
      branch: input.branch || "main",
      commitSha: "",
      commitUrl: "",
      treeUrl: `https://github.com/${owner}/${name}/tree/${input.branch || "main"}`,
      written: input.files.length,
      removed: [],
      warnings: [
        "GITHUB_TOKEN is not set, so nothing was pushed. The site was generated and checked; set a token to publish it for real.",
      ],
    };
  }
}
