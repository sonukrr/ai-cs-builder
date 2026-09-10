import {
  GitHubRestDeployProvider,
  refusedDestination,
  staleGeneratedFiles,
  type DeployFile,
  type DeployTargetProvider,
  type PushResult,
  type RepoState,
  type WriteAccess,
} from "./deploy";
import { parseRepo } from "./types";
import { GitHubMcpSession } from "./mcp-session";
import { DEFAULT_GITHUB_MCP_URL } from "./mcp-auth";

/**
 * The GitHub MCP backend for pushing a generated site.
 *
 * This exists because an administrator's mental model of "my GitHub access" is
 * increasingly the MCP server they have already connected, not a personal
 * access token pasted into a `.env` file. Where that server is configured, the
 * push goes through it, and the audit trail on GitHub's side shows the MCP app.
 *
 * It is a hybrid, and the seams are reported rather than hidden. GitHub's
 * hosted server covers most of a publish — `push_files` writes the whole site
 * in one commit, and `create_repository`, `create_branch` and `delete_file` do
 * the rest — but two things it genuinely cannot do:
 *
 *  - images. Its file tools document `content` as "Do not base64-encode it;
 *    this server does that before calling the REST API", so there is no way to
 *    hand one a binary file. Those go through the git data API instead.
 *  - listing a tree. Working out which generated files a republish should
 *    remove needs a recursive listing, which no MCP tool provides.
 *
 * Both fall back to `GitHubRestDeployProvider`, which is why this backend still
 * wants a personal access token even when its MCP bearer is an OAuth
 * credential. When there is none, each is reported as skipped rather than
 * silently dropped.
 */

/** Tool-name fragments, best first, for each thing a push needs. */
const TOOL_INTENTS = {
  push: ["push_files", "create_or_update_files", "commit_files"],
  createRepo: ["create_repository", "create_repo"],
  createBranch: ["create_branch"],
  deleteFile: ["delete_file", "delete_files"],
  whoami: ["get_me", "get_authenticated_user"],
} as const;

type Intent = keyof typeof TOOL_INTENTS;

/** Re-exported so existing callers keep one import site for it. */
export { DEFAULT_GITHUB_MCP_URL };

/**
 * Deletions one publish may make through MCP.
 *
 * `delete_file` takes one path and makes one commit, so removing a restructured
 * site's worth of stale files would write dozens of commits. Past this the
 * publish says so and leaves the rest, rather than filling the history.
 */
const MAX_MCP_DELETIONS = 20;

export class GitHubMcpDeployProvider implements DeployTargetProvider {
  readonly backend = "mcp" as const;
  readonly configured: boolean;

  private readonly url: string;
  private readonly rest: GitHubRestDeployProvider;
  private readonly session: GitHubMcpSession;

  constructor(input: { url: string; token: string }) {
    this.url = input.url;
    this.configured = Boolean(input.url);
    this.session = new GitHubMcpSession(input.url);
    // The REST half is for what MCP has no tool for, and it needs a real
    // personal access token: the OAuth credential is minted for the MCP
    // resource and may carry nothing the git data API accepts.
    this.rest = new GitHubRestDeployProvider(input.token);
  }

  private call(intent: Intent, args: Record<string, unknown>): Promise<string> {
    return this.session.call(intent, TOOL_INTENTS[intent], args);
  }

  /** Reading state is REST's job — see the note at the top of the file. */
  async describe(repo: string): Promise<RepoState> {
    return this.rest.describe(repo);
  }

  /**
   * The write probe, also REST's.
   *
   * Both halves of this backend write with the same personal access token — MCP
   * carries its own bearer, but every push through it is a GitHub API call made
   * on the server's side with the credential it was given, and the images and
   * deletions go through REST directly. A token that cannot create a blob
   * cannot publish either way, so probing the API answers for both.
   */
  async checkWriteAccess(repo: string): Promise<WriteAccess> {
    if (!this.rest.configured) {
      return {
        ok: false,
        detail:
          "No personal access token is set, so nothing can be pushed: the MCP file tools cannot write images, and the write probe has no credential. Set GITHUB_TOKEN.",
      };
    }
    return this.rest.checkWriteAccess(repo);
  }

  /**
   * The login the MCP credential belongs to, or "" if the server will not say.
   *
   * Needed because `create_repository` documents `organization` as "omit to
   * create in your personal account" — passing your own username there is not
   * a no-op, it asks GitHub for an organization that does not exist.
   */
  private async login(): Promise<string> {
    try {
      const reply = await this.call("whoami", {});
      return reply.match(/"login"\s*:\s*"([\w.-]+)"/)?.[1] ?? "";
    } catch {
      return "";
    }
  }

  async create(repo: string, options: { private: boolean; description: string }): Promise<RepoState> {
    const refused = refusedDestination(repo);
    if (refused) throw new Error(refused);
    const { owner, name } = parseRepo(repo)!;

    const me = await this.login();
    const personal = me !== "" && me.toLowerCase() === owner.toLowerCase();

    await this.call("createRepo", {
      name,
      // Omitted for a personal account; sent when the owner is an organization.
      ...(personal ? {} : { organization: owner }),
      description: options.description.slice(0, 300),
      private: options.private,
      autoInit: false,
    });

    return this.rest.describe(`${owner}/${name}`);
  }

  async push(input: {
    repo: string;
    branch: string;
    files: DeployFile[];
    message: string;
    allowNonEmpty?: boolean;
  }): Promise<PushResult> {
    const refused = refusedDestination(input.repo);
    if (refused) throw new Error(refused);
    const { owner, name } = parseRepo(input.repo)!;

    const state = await this.rest.describe(`${owner}/${name}`);
    if (!state.exists) throw new Error(`${owner}/${name} does not exist.`);
    if (!state.empty && !state.generatedByStudio && !input.allowNonEmpty) {
      throw new Error(
        `${owner}/${name} already contains files the studio did not generate (${state.rootEntries
          .slice(0, 8)
          .join(", ")}). Publishing would overwrite them. Confirm with the administrator that this repository is meant to hold the generated site.`,
      );
    }

    const branch = input.branch || state.defaultBranch || "main";
    const warnings: string[] = [];

    const text = input.files.filter((file) => file.encoding === "utf-8");
    const binary = input.files.filter((file) => file.encoding !== "utf-8");

    // A branch that does not exist yet has to be created before push_files can
    // write to it; on a repository with no commits at all there is nothing to
    // branch from, so the whole push goes through REST instead.
    if (state.empty) {
      const result = await this.rest.push({ ...input, branch });
      return {
        ...result,
        warnings: [
          ...result.warnings,
          `${owner}/${name} has no commits yet, so the first publish went through the GitHub API rather than the MCP server. Later publishes use MCP.`,
        ],
      };
    }

    if (branch !== state.defaultBranch) {
      try {
        await this.call("createBranch", {
          owner,
          repo: name,
          branch,
          from_branch: state.defaultBranch,
          fromBranch: state.defaultBranch,
        });
      } catch (error) {
        // Already existing is the normal case on a republish.
        const message = error instanceof Error ? error.message : String(error);
        if (!/exists|422/i.test(message)) throw error;
      }
    }

    const reply = await this.call("push", {
      owner,
      repo: name,
      branch,
      message: input.message,
      files: text.map((file) => ({ path: file.path, content: file.content })),
    });

    // The server answers with the commit as JSON in a text block; take the sha
    // if it is there and do not depend on it if it is not.
    const sha = reply.match(/"sha"\s*:\s*"([0-9a-f]{7,40})"/)?.[1] ?? "";

    let written = text.length;

    /*
      Stale generated files. `delete_file` takes one path and writes one commit,
      so this is a call per removal rather than part of the push — worth it,
      because a page deleted in the studio that stays live means the studio is
      lying about what the site is. Working out *which* files are stale needs a
      recursive tree, which MCP has no tool for, so that read goes through REST.
    */
    const removed: string[] = [];
    if (this.rest.configured) {
      try {
        const existing = await this.rest.branchPaths(`${owner}/${name}`, branch);
        if (existing.truncated) {
          warnings.push(
            "The repository's file list came back truncated, so a stale generated file may have been left behind.",
          );
        }

        const stale = staleGeneratedFiles(
          existing.paths,
          input.files.map((file) => file.path),
        );

        for (const path of stale.slice(0, MAX_MCP_DELETIONS)) {
          await this.call("deleteFile", {
            owner,
            repo: name,
            path,
            branch,
            message: `Remove ${path} — no longer part of the generated site`,
          });
          removed.push(path);
        }

        if (stale.length > removed.length) {
          warnings.push(
            `${stale.length - removed.length} stale generated file(s) were left in place: removing them through MCP is one commit each, and this publish stopped at ${MAX_MCP_DELETIONS}. Publishing with GITHUB_DEPLOY_PROVIDER=rest removes them all in the same commit as the push.`,
          );
        } else if (removed.length > 0) {
          warnings.push(
            `${removed.length} file(s) the site no longer has were removed, one commit each — MCP has no tool that deletes as part of a push.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Could not work out which generated files are now stale, so a removed page may still be live: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      warnings.push(
        "GITHUB_TOKEN is not set, so the publish could not read the repository's file list — a page removed in the studio may still be live.",
      );
    }

    if (binary.length > 0) {
      if (this.rest.configured) {
        const followUp = await this.rest.push({
          repo: `${owner}/${name}`,
          branch,
          files: binary,
          message: `${input.message} (images)`,
          allowNonEmpty: true,
        });
        written += followUp.written;
        warnings.push(
          `${binary.length} image${binary.length === 1 ? "" : "s"} went through the GitHub API in a second commit: the MCP server's file tools take text and base64-encode it themselves, so there is no way to hand them a binary file.`,
        );
      } else {
        warnings.push(
          `${binary.length} image${binary.length === 1 ? "" : "s"} could not be pushed: MCP cannot write binary files and GITHUB_TOKEN is not set, so the deployed site will show gaps where they belong.`,
        );
      }
    }

    return {
      branch,
      commitSha: sha,
      commitUrl: sha ? `https://github.com/${owner}/${name}/commit/${sha}` : "",
      treeUrl: `https://github.com/${owner}/${name}/tree/${branch}`,
      written,
      removed,
      warnings,
    };
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
