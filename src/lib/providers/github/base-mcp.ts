import {
  type BaseSiteContext,
  type BaseSiteFile,
  type BaseSiteProvider,
  PROTECTED_BRANCHES,
  isWritable,
  parseRepo,
} from "./types";
import {
  CONFIG_CANDIDATES,
  detectFramework,
  discoverAngularRoutes,
  discoverComponents,
  discoverPages,
  GitHubRestProvider,
  KEY_FILE_CANDIDATES,
} from "./rest";
import { GitHubMcpSession } from "./mcp-session";

/**
 * The approved base career site, read and written through GitHub's MCP server.
 *
 * The same capability as `GitHubRestProvider` and, importantly, the same guard
 * rails: 07-base-site-flow.md draws a hard line — read the repository, create a
 * company branch, commit *controlled* changes, never touch a protected branch,
 * never write outside the approved configuration surface. Those are enforced
 * here as well as there, because a guard rail that only one backend applies is
 * not a guard rail.
 *
 * MCP does the reading and the writing. One thing it cannot do is list a
 * repository recursively: `get_file_contents` lists a single directory, and
 * structure discovery needs every path. So the tree comes from the git data API
 * when a personal access token is available, and otherwise from a bounded walk
 * through MCP — which is enough to find the configuration and the components,
 * and says so when it had to stop early.
 */

/**
 * Ceilings on the MCP walk.
 *
 * A career site's structure lives in its first few levels; `node_modules` is
 * what lives below. Deep enough for `src/app/components/hero/hero.component.ts`,
 * shallow enough that a walk of somebody's monorepo cannot run for minutes.
 */
const WALK_MAX_DEPTH = 5;
const WALK_MAX_DIRECTORIES = 60;

/** Directories that are build output or dependencies, never structure. */
const SKIP = /^(node_modules|dist|build|out|coverage|\.next|\.git|\.angular|\.vercel)$/;

const TOOL_INTENTS = {
  contents: ["get_file_contents", "get_contents", "get_file"],
  branches: ["list_branches"],
  createBranch: ["create_branch"],
  push: ["push_files", "create_or_update_files", "commit_files"],
} as const;

type Intent = keyof typeof TOOL_INTENTS;

interface DirectoryEntry {
  path?: string;
  name?: string;
  type?: string;
}

export class GitHubMcpBaseSiteProvider implements BaseSiteProvider {
  readonly backend = "mcp" as const;
  readonly configured: boolean;

  private readonly session: GitHubMcpSession;
  /** For the one read MCP has no tool for. Unconfigured without a token. */
  private readonly rest: GitHubRestProvider;

  constructor(input: { url: string; token: string }) {
    this.configured = Boolean(input.url);
    this.session = new GitHubMcpSession(input.url);
    this.rest = new GitHubRestProvider(input.token);
  }

  private call(intent: Intent, args: Record<string, unknown>): Promise<string> {
    return this.session.call(intent, TOOL_INTENTS[intent], args);
  }

  private target(repo: string): { owner: string; name: string } {
    const parsed = parseRepo(repo);
    if (!parsed) throw new Error(`"${repo}" is not a GitHub repository reference`);
    return parsed;
  }

  /**
   * One file's text.
   *
   * GitHub's server attaches the file as a resource block, which `textOf`
   * returns verbatim — so the reply is the source, not an envelope around it.
   * The one fallback is the REST contents-API shape (`content` + `encoding:
   * "base64"`), in case a server version wraps it that way; anything else is
   * returned as-is rather than guessed at, because guessing is how a
   * `config/site.json` ends up mangled.
   */
  private async readFile(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const reply = await this.call("contents", { owner, repo, path, ref });

    try {
      const parsed = JSON.parse(reply) as { content?: string; encoding?: string };
      if (
        parsed &&
        typeof parsed.content === "string" &&
        parsed.encoding === "base64" &&
        !Array.isArray(parsed)
      ) {
        return Buffer.from(parsed.content, "base64").toString("utf8");
      }
    } catch {
      // Not JSON, which is the normal case: it is the file.
    }

    return reply;
  }

  /** The default branch, from the branch list, since MCP exposes no repo metadata. */
  private async defaultBranch(owner: string, repo: string): Promise<string> {
    const reply = await this.call("branches", { owner, repo });
    const names = [...reply.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
    for (const preferred of ["main", "master", "develop"]) {
      if (names.includes(preferred)) return preferred;
    }
    return names[0] ?? "main";
  }

  /**
   * Every file path, by walking directories breadth-first.
   *
   * The fallback for when there is no token for the git data API. Bounded on
   * both depth and directory count, and it reports whether it stopped early —
   * an incomplete tree makes discovery incomplete, and an administrator
   * approving a customisation plan should know that.
   */
  private async walk(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ tree: string[]; complete: boolean }> {
    const files: string[] = [];
    const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];
    let visited = 0;

    while (queue.length > 0) {
      if (visited >= WALK_MAX_DIRECTORIES) return { tree: files, complete: false };
      const { path, depth } = queue.shift()!;
      visited += 1;

      let entries: DirectoryEntry[];
      try {
        const reply = await this.call("contents", {
          owner,
          repo,
          // The root is addressed as "/" rather than "": every string argument
          // these tools take is declared non-empty.
          path: path || "/",
          ref,
        });
        const parsed = JSON.parse(reply) as DirectoryEntry[] | DirectoryEntry;
        entries = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // A directory that will not list is one branch of the walk, not the end
        // of it.
        continue;
      }

      for (const entry of entries) {
        const name = entry.name ?? (entry.path ?? "").split("/").pop() ?? "";
        if (!name || SKIP.test(name)) continue;
        const full = entry.path ?? (path ? `${path}/${name}` : name);

        if (entry.type === "dir") {
          if (depth + 1 <= WALK_MAX_DEPTH) queue.push({ path: full, depth: depth + 1 });
          continue;
        }
        if (entry.type === "file" || entry.type === undefined) files.push(full);
      }
    }

    return { tree: files, complete: true };
  }

  async readContext(repo: string): Promise<BaseSiteContext> {
    const { owner, name } = this.target(repo);
    const warnings: string[] = [];

    const defaultBranch = await this.defaultBranch(owner, name);

    /*
      The tree. One recursive call through the git data API when a token allows
      it, because it is complete; a bounded MCP walk otherwise.
    */
    let tree: string[] = [];
    if (this.rest.configured) {
      try {
        const listing = await this.rest.listTree(`${owner}/${name}`, defaultBranch);
        tree = listing.tree;
        if (listing.truncated) {
          warnings.push("The repository tree was truncated by GitHub; discovery may be incomplete.");
        }
      } catch (error) {
        warnings.push(
          `Falling back to a bounded MCP walk for structure discovery: the git data API refused a recursive listing (${
            error instanceof Error ? error.message : String(error)
          }).`,
        );
      }
    }

    if (tree.length === 0) {
      const walked = await this.walk(owner, name, defaultBranch);
      tree = walked.tree;
      if (!walked.complete) {
        warnings.push(
          `Structure discovery walked ${WALK_MAX_DIRECTORIES} directories and stopped, so the file list is incomplete — MCP has no recursive listing, and GITHUB_TOKEN is not set for the one API call that does. A component or page may be missing from the plan.`,
        );
      }
    }

    const readme = await this.readFile(owner, name, "README.md", defaultBranch).catch(() => "");
    const framework = detectFramework(tree);

    const readAll = async (candidates: readonly string[], cap: number) => {
      const files: BaseSiteFile[] = [];
      for (const candidate of candidates) {
        if (!tree.includes(candidate)) continue;
        try {
          const content = await this.readFile(owner, name, candidate, defaultBranch);
          files.push({ path: candidate, content: content.slice(0, cap) });
        } catch (error) {
          warnings.push(
            `Could not read ${candidate}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      return files;
    };

    const config = await readAll(CONFIG_CANDIDATES, 8000);
    const keyFiles = await readAll(KEY_FILE_CANDIDATES, 4000);

    if (config.length === 0) {
      // Worth saying out loud: 07-base-site-flow.md prefers configuration over
      // source edits, and this repo has no configuration to edit yet. The agent
      // creates it on the company branch instead.
      warnings.push(
        "This base site has no configuration files yet, so there is nothing to customise in place. " +
          "Customisation will create config/site.json, config/theme.json and blueprint.json on the company branch.",
      );
    }

    const routingModule = keyFiles.find((file) => file.path.endsWith("app-routing.module.ts"));
    const pages =
      framework === "angular"
        ? discoverAngularRoutes(routingModule?.content ?? "")
        : discoverPages(tree);

    if (framework === "angular" && pages.length === 0 && routingModule) {
      warnings.push(
        "Could not parse routes from app-routing.module.ts; its contents are in keyFiles.",
      );
    }

    return {
      repo: `${owner}/${name}`,
      defaultBranch,
      framework,
      readme: readme.slice(0, 8000),
      tree,
      config,
      keyFiles,
      components: discoverComponents(tree),
      pages,
      warnings,
    };
  }

  async createBranch(repo: string, branch: string, fromBranch?: string) {
    const { owner, name } = this.target(repo);
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(`Refusing to create over the protected branch "${branch}"`);
    }

    const from = fromBranch ?? (await this.defaultBranch(owner, name));
    try {
      await this.call("createBranch", { owner, repo: name, branch, from_branch: from });
    } catch (error) {
      // A branch that already exists is the normal case on a second edit.
      const detail = error instanceof Error ? error.message : String(error);
      if (!/already exists|reference already exists|422/i.test(detail)) throw error;
    }

    return { branch, url: `https://github.com/${owner}/${name}/tree/${branch}` };
  }

  async commitFiles(repo: string, branch: string, files: BaseSiteFile[], message: string) {
    const { owner, name } = this.target(repo);

    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(
        `Refusing to commit to the protected branch "${branch}". Changes go to a company branch and reach production through a publish request.`,
      );
    }

    const blocked = files.filter((file) => !isWritable(file.path));
    if (blocked.length > 0) {
      throw new Error(
        `Refusing to write outside the approved configuration surface: ${blocked
          .map((file) => file.path)
          .join(", ")}`,
      );
    }

    const reply = await this.call("push", {
      owner,
      repo: name,
      branch,
      message,
      files: files.map((file) => ({ path: file.path, content: file.content })),
    });

    const sha = reply.match(/"sha"\s*:\s*"([0-9a-f]{7,40})"/)?.[1] ?? "";
    return {
      commitUrl: sha ? `https://github.com/${owner}/${name}/commit/${sha}` : "",
      files: files.map((file) => file.path),
    };
  }
}
