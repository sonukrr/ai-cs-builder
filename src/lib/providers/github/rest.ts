import {
  type BaseSiteContext,
  type BaseSiteFile,
  type BaseSiteProvider,
  PROTECTED_BRANCHES,
  isWritable,
  parseRepo,
} from "./types";

/**
 * GitHub REST backend for the approved base career site.
 *
 * A token with `contents: read/write` on the base repo is all this needs. The
 * guard rails from types.ts are applied here rather than trusted to the caller:
 * every write checks the branch and every path.
 */

const API = "https://api.github.com";

/**
 * The writable configuration surface, if the repo has one.
 *
 * A base site that predates this studio will have none of these — see
 * `readContext`, which says so rather than pretending otherwise. They are then
 * files the agent *creates* on the company branch, which is why the same names
 * appear in WRITABLE_PATTERNS.
 */
export const CONFIG_CANDIDATES = [
  "site.config.json",
  "theme.json",
  "content.json",
  "config/site.json",
  "config/theme.json",
  "config/content.json",
  "blueprint.json",
];

/**
 * Read-only files that explain how the app is wired.
 *
 * Ordered most-explanatory first, and capped when read, because these are pure
 * context for the model rather than anything it may change.
 */
export const KEY_FILE_CANDIDATES = [
  "src/app/app-routing.module.ts",
  "src/app/app.module.ts",
  "src/app/app.component.html",
  "src/environments/environment.ts",
  "app/routes.ts",
  "src/app/routes.ts",
];

export class GitHubRestProvider implements BaseSiteProvider {
  readonly backend = "rest" as const;
  readonly configured: boolean;

  private readonly token: string;

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
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub ${response.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async readContext(repo: string): Promise<BaseSiteContext> {
    const parsed = parseRepo(repo);
    if (!parsed) throw new Error(`"${repo}" is not a GitHub repository reference`);
    const { owner, name } = parsed;
    const warnings: string[] = [];

    const meta = await this.api<{ default_branch: string }>(`/repos/${owner}/${name}`);
    const defaultBranch = meta.default_branch;

    const listing = await this.listTree(`${owner}/${name}`, defaultBranch);
    if (listing.truncated) {
      warnings.push("The repository tree was truncated by GitHub; discovery may be incomplete.");
    }
    const tree = listing.tree;

    const readme = await this.readFile(owner, name, "README.md", defaultBranch).catch(() => "");
    const framework = detectFramework(tree);

    const readAll = async (candidates: string[], cap: number) => {
      const files: BaseSiteFile[] = [];
      for (const candidate of candidates) {
        if (!tree.includes(candidate)) continue;
        try {
          const content = await this.readFile(owner, name, candidate, defaultBranch);
          files.push({ path: candidate, content: content.slice(0, cap) });
        } catch (error) {
          warnings.push(`Could not read ${candidate}: ${error instanceof Error ? error.message : error}`);
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

    const routingModule = keyFiles.find((f) => f.path.endsWith("app-routing.module.ts"));
    const pages =
      framework === "angular"
        ? discoverAngularRoutes(routingModule?.content ?? "")
        : discoverPages(tree);

    if (framework === "angular" && pages.length === 0 && routingModule) {
      warnings.push("Could not parse routes from app-routing.module.ts; its contents are in keyFiles.");
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

  /**
   * Every file path on a ref, in one call.
   *
   * Public because the MCP backend needs it: MCP lists a single directory at a
   * time and structure discovery needs the whole tree, so this is the one read
   * that backend delegates here. Build output and dependencies are dropped —
   * they are noise for discovery and most of the bytes.
   */
  async listTree(repo: string, ref: string): Promise<{ tree: string[]; truncated: boolean }> {
    const parsed = parseRepo(repo);
    if (!parsed) throw new Error(`"${repo}" is not a GitHub repository reference`);
    const { owner, name } = parsed;

    const response = await this.api<{
      tree: { path: string; type: string }[];
      truncated: boolean;
    }>(`/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);

    return {
      tree: response.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path)
        .filter((path) => !/^(node_modules|dist|build|\.next|\.git)\//.test(path)),
      truncated: response.truncated,
    };
  }

  private async readFile(
    owner: string,
    name: string,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const data = await this.api<{ content?: string; encoding?: string }>(
      `/repos/${owner}/${name}/contents/${encodeURI(filePath)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!data.content) throw new Error(`${filePath} has no content`);
    return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8");
  }

  async createBranch(repo: string, branch: string, fromBranch?: string) {
    const parsed = parseRepo(repo);
    if (!parsed) throw new Error(`"${repo}" is not a GitHub repository reference`);
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(`Refusing to create over the protected branch "${branch}"`);
    }
    const { owner, name } = parsed;

    const base = fromBranch ?? (await this.api<{ default_branch: string }>(`/repos/${owner}/${name}`)).default_branch;
    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(base)}`,
    );

    try {
      await this.api(`/repos/${owner}/${name}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
      });
    } catch (error) {
      // A branch that already exists is the normal case on a second edit.
      if (!(error instanceof Error && error.message.includes("422"))) throw error;
    }

    return { branch, url: `https://github.com/${owner}/${name}/tree/${branch}` };
  }

  async commitFiles(repo: string, branch: string, files: BaseSiteFile[], message: string) {
    const parsed = parseRepo(repo);
    if (!parsed) throw new Error(`"${repo}" is not a GitHub repository reference`);
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(
        `Refusing to commit to the protected branch "${branch}". Changes go to a company branch and reach production through a publish request.`,
      );
    }

    const blocked = files.filter((f) => !isWritable(f.path));
    if (blocked.length > 0) {
      throw new Error(
        `Refusing to write outside the approved configuration surface: ${blocked.map((f) => f.path).join(", ")}`,
      );
    }

    const { owner, name } = parsed;
    const written: string[] = [];
    let commitUrl = "";

    // One PUT per file. Batching through the trees API would be fewer calls,
    // but the config surface is a handful of files and this keeps each write
    // independently recoverable.
    for (const file of files) {
      let sha: string | undefined;
      try {
        const existing = await this.api<{ sha: string }>(
          `/repos/${owner}/${name}/contents/${encodeURI(file.path)}?ref=${encodeURIComponent(branch)}`,
        );
        sha = existing.sha;
      } catch {
        // New file; no sha to supply.
      }

      const result = await this.api<{ commit: { html_url: string } }>(
        `/repos/${owner}/${name}/contents/${encodeURI(file.path)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message,
            branch,
            content: Buffer.from(file.content, "utf8").toString("base64"),
            ...(sha ? { sha } : {}),
          }),
        },
      );
      written.push(file.path);
      commitUrl = result.commit.html_url;
    }

    return { commitUrl, files: written };
  }
}

export function detectFramework(tree: string[]): "angular" | "next" | "unknown" {
  if (tree.some((p) => /\.module\.ts$|angular\.json$/.test(p))) return "angular";
  if (tree.some((p) => /^(src\/)?(app|pages)\/.*\.(tsx|jsx)$|^next\.config\./.test(p))) return "next";
  return "unknown";
}

export function discoverComponents(tree: string[]): { name: string; path: string }[] {
  const angular = tree
    .filter((p) => /\.component\.ts$/.test(p) && !/\.spec\.ts$/.test(p) && !/app\.component\.ts$/.test(p))
    .map((p) => {
      const file = p.split("/").pop() ?? p;
      const slug = file.replace(/\.component\.ts$/, "");
      return { name: slug.charAt(0).toUpperCase() + slug.slice(1), path: p };
    });

  const next = tree
    .filter((p) => /^(src\/)?components\/.+\.(tsx|jsx|vue|svelte)$/.test(p))
    .map((p) => ({ name: (p.split("/").pop() ?? p).replace(/\.\w+$/, ""), path: p }));

  return [...angular, ...next].slice(0, 120);
}

/**
 * Pulls routes out of an Angular routing module.
 *
 * A regex rather than a parse: the routes array is a literal in every Angular
 * CLI project, and a full TS parse would be a lot of machinery for one array.
 * When it does not match, `readContext` says so and hands the file to the model
 * rather than reporting no pages.
 */
export function discoverAngularRoutes(source: string): { name: string; path: string }[] {
  const routes: { name: string; path: string }[] = [];

  for (const match of source.matchAll(/\{\s*path\s*:\s*['"`]([^'"`]*)['"`]([^}]*)\}/g)) {
    const [, routePath, rest] = match;
    if (routePath === "**") continue;

    // Redirects are navigation plumbing, not pages.
    if (/redirectTo\s*:/.test(rest)) continue;

    const component = rest.match(/component\s*:\s*(\w+)/)?.[1] ?? "";
    const name =
      routePath === ""
        ? "Home"
        : component
          ? component.replace(/Component$/, "")
          : routePath.replace(/^\//, "");

    routes.push({ name, path: routePath.startsWith("/") ? routePath : `/${routePath}` });
  }

  return routes.slice(0, 60);
}

export function discoverPages(tree: string[]): { name: string; path: string }[] {
  const routes = tree.filter((p) =>
    /^(src\/)?(app|pages)\/.*\/?(page|index)\.(tsx|jsx|ts|js)$/.test(p),
  );
  return routes
    .map((p) => {
      const route =
        "/" +
        p
          .replace(/^(src\/)?(app|pages)\//, "")
          .replace(/\/?(page|index)\.\w+$/, "")
          .replace(/\(.*?\)\//g, "");
      return { name: route === "/" ? "Home" : route.replace(/^\//, ""), path: route || "/" };
    })
    .slice(0, 60);
}
