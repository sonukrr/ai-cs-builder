import { createHash } from "node:crypto";

/**
 * Vercel, as the studio needs it: link a repository, start a deployment, watch
 * it finish, and read the build log when it does not.
 *
 * Two ways to deploy, because the two have different prerequisites and an
 * administrator should not have to care which one applies.
 *
 * FROM GIT is the one people mean. It needs Vercel's GitHub App installed on
 * the destination repository, which is a click on vercel.com that no API can
 * make on someone's behalf. Its reward is that every later push deploys itself,
 * so the studio's second publish needs Vercel not at all.
 *
 * FROM FILES uploads the generated site directly. It needs nothing but a token,
 * which makes it the path that works on a fresh repository the moment a
 * publish happens, and it is what this provider falls back to when the project
 * has no git link. The trade-off is real and is reported: a file deployment is
 * a snapshot, so a commit pushed later does not deploy on its own.
 *
 * Everything degrades rather than failing: with no VERCEL_TOKEN the site is
 * still generated and pushed, and the deployment step says what to do at
 * vercel.com instead of pretending to have a URL.
 */

const API = "https://api.vercel.com";

export interface VercelProject {
  id: string;
  name: string;
  /** "owner/name" when Vercel is watching a repository, otherwise "". */
  linkedRepo: string;
  framework: string;
  /** Whether a push to the linked repository deploys on its own. */
  autoDeploy: boolean;
}

/** Vercel's preset names for the two targets this studio emits. */
export type VercelFramework = "nextjs" | "angular";

export type DeploymentState =
  | "QUEUED"
  | "INITIALIZING"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED"
  | "UNKNOWN";

export interface VercelDeployment {
  id: string;
  /** The deployment's own hostname, without a scheme. */
  url: string;
  /** Where a person watches the build. */
  inspectorUrl: string;
  state: DeploymentState;
  /** Production aliases once it is ready. */
  aliases: string[];
  target: string;
  /** Populated on failure, from the build log. */
  errorMessage: string;
}

export interface VercelFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

export class VercelClient {
  readonly configured: boolean;

  private readonly token: string;
  private readonly teamId: string;

  constructor(input: { token: string; teamId: string }) {
    this.token = input.token;
    this.teamId = input.teamId;
    this.configured = Boolean(input.token);
  }

  /** Every call is team-scoped when a team is configured; Vercel needs it on each. */
  private url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    return url.toString();
  }

  private async api<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const { query, ...rest } = init;
    const response = await fetch(this.url(path, query), {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(rest.body && !(rest.headers as Record<string, string>)?.["Content-Type"]
          ? { "Content-Type": "application/json" }
          : {}),
        ...(rest.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();
    if (!response.ok) {
      // Vercel's errors are JSON with a code worth keeping — "not_found" and
      // "repo_not_linked" are both normal states the caller reacts to.
      throw new Error(`Vercel ${response.status} on ${path}: ${text.slice(0, 400)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** A project name Vercel will accept: lowercase, no runs of separators. */
  static projectName(value: string): string {
    const name = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 90);
    return name || "career-site";
  }

  private toProject(raw: {
    id: string;
    name: string;
    framework?: string | null;
    link?: { type?: string; org?: string; repo?: string; deployHooks?: unknown[] };
  }): VercelProject {
    const link = raw.link;
    const linkedRepo = link?.org && link?.repo ? `${link.org}/${link.repo}` : "";
    return {
      id: raw.id,
      name: raw.name,
      linkedRepo,
      framework: raw.framework ?? "",
      autoDeploy: Boolean(linkedRepo),
    };
  }

  async findProject(name: string): Promise<VercelProject | null> {
    try {
      const raw = await this.api<Parameters<VercelClient["toProject"]>[0]>(
        `/v9/projects/${encodeURIComponent(name)}`,
      );
      return this.toProject(raw);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Vercel 404")) return null;
      throw error;
    }
  }

  /**
   * The project for this site, linked to its repository where Vercel is allowed
   * to link it.
   *
   * A failed link is not a failed publish. Vercel refuses to link a repository
   * its GitHub App cannot see, and the honest response to that is a project
   * that deploys by upload plus a sentence telling the administrator where to
   * click — not an aborted deployment.
   */
  async ensureProject(input: {
    name: string;
    repo: string;
    framework: VercelFramework;
  }): Promise<{ project: VercelProject; created: boolean; linkWarning: string }> {
    const name = VercelClient.projectName(input.name);
    const existing = await this.findProject(name);
    if (existing) return { project: existing, created: false, linkWarning: "" };

    const body = {
      name,
      framework: input.framework,
      gitRepository: { type: "github", repo: input.repo },
    };

    try {
      const raw = await this.api<Parameters<VercelClient["toProject"]>[0]>("/v11/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { project: this.toProject(raw), created: true, linkWarning: "" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const raw = await this.api<Parameters<VercelClient["toProject"]>[0]>("/v11/projects", {
        method: "POST",
        body: JSON.stringify({ name, framework: input.framework }),
      });
      return {
        project: this.toProject(raw),
        created: true,
        linkWarning: `Vercel would not link ${input.repo} to the project, so pushes will not deploy themselves — install the Vercel GitHub app on the repository at https://vercel.com/new and connect it once. This publish deployed the generated files directly instead. (${detail.slice(
          0,
          200,
        )})`,
      };
    }
  }

  /** Starts a deployment of a commit in the linked repository. */
  async deployFromGit(input: {
    project: VercelProject;
    repo: string;
    ref: string;
    production: boolean;
  }): Promise<VercelDeployment> {
    const [org, repo] = input.repo.split("/");
    const raw = await this.api<{
      id: string;
      url: string;
      inspectorUrl?: string;
      readyState?: string;
      target?: string;
      alias?: string[];
    }>("/v13/deployments", {
      method: "POST",
      query: { forceNew: "1" },
      body: JSON.stringify({
        name: input.project.name,
        project: input.project.id,
        target: input.production ? "production" : undefined,
        gitSource: { type: "github", org, repo, ref: input.ref },
      }),
    });

    return this.toDeployment(raw);
  }

  /**
   * Uploads the generated site and deploys it.
   *
   * Vercel's upload protocol is content-addressed: each file is PUT once under
   * its SHA-1, and the deployment then references the hashes. Re-publishing a
   * site whose images have not changed therefore re-uploads only the source
   * files that did.
   */
  async deployFiles(input: {
    project: VercelProject;
    files: VercelFile[];
    production: boolean;
    framework: VercelFramework;
  }): Promise<VercelDeployment> {
    const uploads = input.files.map((file) => {
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
      return {
        file: file.path,
        sha: createHash("sha1").update(bytes).digest("hex"),
        size: bytes.length,
        bytes,
      };
    });

    for (const upload of uploads) {
      await this.api("/v2/files", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": upload.sha,
        },
        body: new Uint8Array(upload.bytes),
      });
    }

    const raw = await this.api<{
      id: string;
      url: string;
      inspectorUrl?: string;
      readyState?: string;
      target?: string;
      alias?: string[];
    }>("/v13/deployments", {
      method: "POST",
      query: { forceNew: "1", skipAutoDetectionConfirmation: "1" },
      body: JSON.stringify({
        name: input.project.name,
        project: input.project.id,
        target: input.production ? "production" : undefined,
        files: uploads.map((upload) => ({ file: upload.file, sha: upload.sha, size: upload.size })),
        // An Angular build needs its output directory named: the CLI writes to
        // `dist`, while Vercel's preset expects `dist/<project>`.
        projectSettings:
          input.framework === "angular"
            ? { framework: "angular", outputDirectory: "dist", buildCommand: "ng build" }
            : { framework: "nextjs" },
      }),
    });

    return this.toDeployment(raw);
  }

  private toDeployment(raw: {
    id: string;
    url: string;
    inspectorUrl?: string;
    readyState?: string;
    status?: string;
    target?: string | null;
    alias?: string[];
    aliasAssigned?: unknown;
  }): VercelDeployment {
    const state = (raw.readyState ?? raw.status ?? "UNKNOWN").toUpperCase();
    return {
      id: raw.id,
      url: raw.url ?? "",
      inspectorUrl: raw.inspectorUrl ?? "",
      state: (["QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED"].includes(state)
        ? state
        : "UNKNOWN") as DeploymentState,
      aliases: raw.alias ?? [],
      target: raw.target ?? "",
      errorMessage: "",
    };
  }

  async getDeployment(id: string): Promise<VercelDeployment> {
    const raw = await this.api<Parameters<VercelClient["toDeployment"]>[0]>(
      `/v13/deployments/${encodeURIComponent(id)}`,
    );
    return this.toDeployment(raw);
  }

  /**
   * The build log.
   *
   * Only read when a deployment fails, and only the tail: the interesting part
   * of a failed Next.js build is the last few dozen lines, and the whole log of
   * an npm install is thousands.
   */
  async buildLog(id: string, lines = 60): Promise<string> {
    // The one call whose own failure must not become the story: it is only ever
    // made because something else already failed, and "could not read the log"
    // is more useful to whoever is reading than a second stack trace.
    let events: { type?: string; payload?: { text?: string } }[];
    try {
      events = await this.api(`/v3/deployments/${encodeURIComponent(id)}/events`, {
        query: { builds: "1", limit: "1000" },
      });
    } catch (error) {
      return `The build log could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }

    const text = (Array.isArray(events) ? events : [])
      .map((event) => event.payload?.text ?? "")
      .filter((line) => line.trim() !== "");

    return text.slice(-lines).join("\n");
  }
}

export interface VercelStatus {
  ready: boolean;
  detail: string;
  requires: string[];
  team: string;
}

export function getVercelClient(): VercelClient {
  return new VercelClient({
    token: (process.env.VERCEL_TOKEN ?? "").trim(),
    teamId: (process.env.VERCEL_TEAM_ID ?? "").trim(),
  });
}

export function vercelStatus(): VercelStatus {
  const client = getVercelClient();
  const team = (process.env.VERCEL_TEAM_ID ?? "").trim();

  return client.configured
    ? {
        ready: true,
        detail: team
          ? `Deploying through the Vercel API into team ${team}.`
          : "Deploying through the Vercel API into the token's personal scope. Set VERCEL_TEAM_ID to deploy into a team.",
        requires: ["VERCEL_TOKEN"],
        team,
      }
    : {
        ready: false,
        detail:
          "VERCEL_TOKEN is not set, so a publish pushes the code and stops there. Import the repository once at https://vercel.com/new and Vercel will build every push, or set a token to have the studio deploy it.",
        requires: ["VERCEL_TOKEN", "VERCEL_TEAM_ID (only for a team account)"],
        team: "",
      };
}
