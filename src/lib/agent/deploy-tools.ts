import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  Blueprint,
  DeployTarget,
  DeployTargetKind,
  Deployment,
  Section,
} from "@/lib/blueprint/schema";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { store } from "@/lib/store/store";
import { assets } from "@/lib/store/assets";
import { placeholderSvg } from "@/lib/providers/images/placeholder";
import { emitReactSite } from "@/lib/emit/react";
import { emitAngularApp } from "@/lib/emit/angular-app";
import {
  ANGULAR_ASSETS,
  collectStudioAssets,
  NEXT_ASSETS,
  type StudioAsset,
} from "@/lib/emit/assets";
import { registry } from "@/lib/registry";
import { getDeployTargetProvider } from "@/lib/providers/github/deploy-target";
import { isGeneratedPath, type PushResult, type RepoState } from "@/lib/providers/github/deploy";
import { getVercelClient, type VercelDeployment, type VercelProject } from "@/lib/providers/vercel";

/**
 * The deploy agent's tools.
 *
 * Publishing is not a pipeline pretending to be a conversation. It is a
 * sequence of steps that each fail in ways only judgement recovers from: the
 * repository does not exist yet, or exists and holds somebody's work; the
 * Vercel project is not linked to GitHub; the build fails on one generated file
 * for a reason the log states plainly and a fix-up patch settles. That is why
 * this is an agent and not a function — and why the tools are small, each
 * reporting exactly what happened.
 *
 * Two rules are enforced here rather than left to the prompt, because a model
 * that gets them wrong destroys somebody's repository:
 *
 *  - the destination is whatever the administrator supplied on the project. No
 *    tool takes a repository argument, so there is no way for the agent to
 *    publish somewhere else, however it is asked;
 *  - the whole-repository overwrite of a repository the studio did not generate
 *    happens only when the stored target records that the administrator agreed
 *    to it. The agent can read that flag and cannot set it.
 *
 * Facts are recorded by the orchestrator from this workspace, not by a tool the
 * model chooses to call, so the deployment record cannot say "succeeded"
 * because the model believed it had.
 */

/** What either emitter produces, reduced to what the deploy flow needs. */
export interface GeneratedSite {
  files: { path: string; content: string; encoding: "utf-8" | "base64" }[];
  warnings: string[];
  notes: string[];
  pages: { id: string; route: string; file: string }[];
  /**
   * On the React target, the approved components it could not render. On the
   * Angular target this is empty, because it renders all of them.
   */
  pendingComponents: string[];
  /** On the Angular target, the approved components the site actually runs. */
  libraryComponents: string[];
  assets: StudioAsset[];
}

/**
 * Which application this blueprint needs.
 *
 * A site with any approved careers component in it can only work as Angular —
 * the library is Angular 15 — so that is the default, and React is right only
 * for a site that is presentation from top to bottom.
 */
export function recommendedTarget(blueprint: Blueprint): DeployTargetKind {
  const usesLibrary = (sections: Section[]): boolean =>
    sections.some(
      (section) =>
        section.source === "zm-careers-lib" || usesLibrary(section.children ?? []),
    );

  return blueprint.pages.some((page) => usesLibrary(page.sections)) ? "angular" : "react";
}

export interface DeployWorkspace {
  projectId: string;
  deploymentId: string;
  blueprint: Blueprint;
  target: DeployTarget;
  /** The generated site, once `generate_site` has run. */
  site: GeneratedSite | null;
  /** The files as they will be pushed, including any fix-ups the agent made. */
  files: Map<string, GeneratedSite["files"][number]>;
  repo: RepoState | null;
  push: PushResult | null;
  vercelProject: VercelProject | null;
  vercelDeployment: VercelDeployment | null;
  /** Everything the administrator has to be told, gathered as it happens. */
  warnings: string[];
}

export interface DeployToolContext {
  workspace: DeployWorkspace;
  onActivity: (tool: string, summary: string) => void;
}

/** Generated sources the agent may rewrite when a build fails. */
const PATCHABLE = /\.(tsx?|css|mjs|json|md)$/;

/** A build log line budget, and the ceiling on one file read. */
const MAX_FILE_CHARS = 12_000;

/**
 * How long one `check_deployment` call waits before answering.
 *
 * A Next.js build on Vercel takes a minute or two, so answering immediately
 * would have the agent poll a dozen times and spend its iteration budget on
 * "still building". Waiting inside the tool spends wall-clock instead, which is
 * the cheaper of the two.
 */
const POLL_TOTAL_MS = 90_000;
const POLL_EVERY_MS = 6_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The bytes for every studio-hosted image the site references.
 *
 * Uploads come off disk. Placeholders are drawn from their own query string,
 * which is what makes them reproducible without the studio being reachable.
 */
export async function readSiteImages(
  projectId: string,
  wanted: StudioAsset[],
): Promise<Map<string, { base64: string }>> {
  const images = new Map<string, { base64: string }>();

  for (const asset of wanted) {
    const upload = asset.url.match(/\/assets\/([\w.-]+)$/);
    if (upload) {
      const stored = await assets.read(projectId, upload[1]);
      if (stored) images.set(asset.url, { base64: stored.data.toString("base64") });
      continue;
    }

    const query = asset.url.split("?")[1] ?? "";
    const svg = placeholderSvg(new URLSearchParams(query));
    images.set(asset.url, { base64: Buffer.from(svg, "utf8").toString("base64") });
  }

  return images;
}

/**
 * Generates one target, with the studio's images resolved into it.
 *
 * Exported because the publish panel previews exactly this before anything is
 * pushed, and a preview assembled from a different code path than the publish
 * would eventually disagree with it.
 */
export async function generateSite(
  blueprint: Blueprint,
  target: DeployTargetKind,
  projectId: string,
): Promise<GeneratedSite> {
  if (target === "angular") {
    const images = await readSiteImages(
      projectId,
      collectStudioAssets(blueprint, ANGULAR_ASSETS),
    );
    const site = emitAngularApp(blueprint, { images, studioProjectId: projectId });
    return { ...site, pendingComponents: [] };
  }

  const images = await readSiteImages(projectId, collectStudioAssets(blueprint, NEXT_ASSETS));
  const site = emitReactSite(blueprint, { images, studioProjectId: projectId });
  return { ...site, libraryComponents: [] };
}

function fileList(files: GeneratedSite["files"]): string {
  const grouped = new Map<string, number>();
  for (const file of files) {
    const top = file.path.includes("/") ? `${file.path.split("/")[0]}/` : file.path;
    grouped.set(top, (grouped.get(top) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([group, count]) => `${group} (${count})`).join(", ");
}

export function buildDeployTools({ workspace, onActivity }: DeployToolContext) {
  const github = getDeployTargetProvider();
  const vercel = getVercelClient();

  const requireSite = (): GeneratedSite => {
    if (!workspace.site) {
      throw new Error("Nothing has been generated yet — call generate_site first.");
    }
    return workspace.site;
  };

  const readSite = betaZodTool({
    name: "read_site",
    description:
      "Read what is being published: the company, the version, its pages, whether it validates, and the destination the administrator supplied.",
    inputSchema: z.object({}),
    run: async () => {
      const { blueprint, target } = workspace;
      const issues = validateBlueprint(blueprint);
      const errors = issues.filter((issue) => issue.level === "error");

      onActivity("read_site", `Read ${blueprint.company.name} v${blueprint.version}`);

      return [
        `${blueprint.company.name} — blueprint version ${blueprint.version}.`,
        `Pages: ${blueprint.pages.map((page) => `${page.name} (${page.path}, ${page.sections.length} sections)`).join("; ")}`,
        `Validation: ${errors.length === 0 ? "clean" : `${errors.length} blocking issue(s): ${errors.map((issue) => issue.message).join("; ")}`}`,
        `Destination: ${target.repo} on branch ${target.branch}${
          target.allowNonEmpty ? " — the administrator has agreed it may be overwritten" : ""
        }`,
        `Target: ${
          target.target === "angular"
            ? `Angular, which installs ${registry.package.name} and renders the approved careers components for real`
            : "React (Next.js), which cannot render the approved careers components"
        }`,
        `Vercel project: ${target.vercelProject || "(derived from the company name)"}`,
        `GitHub backend: ${github.backend}. Vercel: ${vercel.configured ? "configured" : "not configured"}.`,
      ].join("\n");
    },
  });

  const generate = betaZodTool({
    name: "generate_site",
    description:
      "Generate the application from the current blueprint, ready to push — Angular when the site uses approved careers components, React when it is presentation only. Reports the files, the images copied out of the studio, and anything the build cannot honestly carry.",
    inputSchema: z.object({}),
    run: async () => {
      const blueprint = workspace.blueprint;
      const issues = validateBlueprint(blueprint);
      const errors = issues.filter((issue) => issue.level === "error");

      /*
        A blueprint that does not validate is generated anyway, and the issues
        are carried forward as warnings. The reasoning: what the administrator
        sees in the preview is what they asked to publish, and refusing here
        left them with a dead button and no way to ship a site that renders
        perfectly well. Generation can still fail on genuinely broken input —
        that is reported as itself rather than as a validation verdict.
      */
      let site: GeneratedSite;
      try {
        site = await generateSite(blueprint, workspace.target.target, workspace.projectId);
      } catch (error) {
        return `Generating the site failed: ${
          error instanceof Error ? error.message : String(error)
        }${
          errors.length > 0
            ? `\nThe blueprint also does not validate, which is the likely cause:\n${errors
                .map((issue) => `  ${issue.path}: ${issue.message}`)
                .join("\n")}`
            : ""
        }`;
      }

      if (errors.length > 0) {
        const summary = `The blueprint does not validate (${errors.length} blocking issue${
          errors.length === 1 ? "" : "s"
        }), and it was published anyway on the administrator's instruction: ${errors
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`;
        site = { ...site, warnings: [...site.warnings, summary] };
        workspace.warnings.push(summary);
      }

      workspace.site = site;
      workspace.files = new Map(site.files.map((file) => [file.path, file]));

      onActivity(
        "generate_site",
        `Generated ${site.files.length} files of ${workspace.target.target === "angular" ? "Angular" : "React"}`,
      );

      return [
        `Generated a ${workspace.target.target === "angular" ? "Angular" : "Next.js"} application: ${site.files.length} files (${fileList(site.files)})`,
        `Routes: ${site.pages.map((page) => page.route).join(", ") || "none"}`,
        site.libraryComponents.length > 0
          ? `Approved components this site runs for real: ${site.libraryComponents.join(", ")}`
          : "",
        site.warnings.length > 0 ? `Warnings:\n${site.warnings.map((w) => `  - ${w}`).join("\n")}` : "No warnings.",
        site.notes.length > 0 ? `Notes:\n${site.notes.map((n) => `  - ${n}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const listFiles = betaZodTool({
    name: "list_generated_files",
    description: "List the paths of the generated files, with their sizes.",
    inputSchema: z.object({
      prefix: z.string().optional().describe("only paths starting with this"),
    }),
    run: async ({ prefix }) => {
      const site = requireSite();
      const files = [...workspace.files.values()]
        .filter((file) => !prefix || file.path.startsWith(prefix))
        .map((file) => `${file.path} — ${file.encoding === "base64" ? "image, " : ""}${file.content.length} chars`);

      onActivity("list_generated_files", `Listed ${files.length} generated files`);
      return files.length > 0 ? files.join("\n") : `No generated files match "${prefix}". ${site.files.length} in total.`;
    },
  });

  const readFile = betaZodTool({
    name: "read_generated_file",
    description:
      "Read one generated file. Use this when a build fails and the log names a file, before changing anything.",
    inputSchema: z.object({ path: z.string() }),
    run: async ({ path }) => {
      requireSite();
      const file = workspace.files.get(path);
      if (!file) return `No generated file at "${path}". Call list_generated_files.`;
      if (file.encoding === "base64") return `"${path}" is an image (${file.content.length} base64 chars).`;

      onActivity("read_generated_file", `Read ${path}`);
      return file.content.length > MAX_FILE_CHARS
        ? `${file.content.slice(0, MAX_FILE_CHARS)}\n… truncated at ${MAX_FILE_CHARS} characters.`
        : file.content;
    },
  });

  /**
   * The escape hatch, and deliberately a narrow one.
   *
   * A generated file that will not compile has to be fixable without a round
   * trip through the studio, or a publish is stuck. But a patch here is a
   * divergence between the repository and the blueprint that generated it, and
   * the blueprint is supposed to be the site — so every patch is recorded as a
   * warning on the deployment, and the next publish overwrites it.
   */
  const writeFile = betaZodTool({
    name: "patch_generated_file",
    description:
      "Replace the contents of one generated file, to get a failing build to compile. Only for build fixes — content and design changes belong in the studio, and the next publish regenerates this file.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
      reason: z.string().describe("the build error this fixes, quoted from the log"),
    }),
    run: async ({ path, content, reason }) => {
      requireSite();
      const existing = workspace.files.get(path);
      if (!existing) return `No generated file at "${path}" — patching only applies to files this build produced.`;
      if (existing.encoding === "base64") return `"${path}" is an image and cannot be patched as text.`;
      if (!PATCHABLE.test(path) || !isGeneratedPath(path)) {
        return `Refusing to patch "${path}": it is outside the generated source this build owns.`;
      }

      workspace.files.set(path, { path, content, encoding: "utf-8" });
      workspace.warnings.push(
        `${path} was patched during the publish to fix a build error (${reason}). The next publish regenerates it from the blueprint.`,
      );

      onActivity("patch_generated_file", `Patched ${path} to fix the build`);
      return `Rewrote ${path} (${content.length} chars). Push again to build it.`;
    },
  });

  const inspectRepo = betaZodTool({
    name: "inspect_repository",
    description:
      "Look at the destination repository: whether it exists, whether it has commits, whether a previous publish generated it, and what is at its root.",
    inputSchema: z.object({}),
    run: async () => {
      const state = await github.describe(workspace.target.repo);
      workspace.repo = state;

      onActivity("inspect_repository", `Inspected ${state.repo}`);

      if (!state.exists) {
        return `${state.repo} does not exist. create_repository will make it (private: ${workspace.target.private}).`;
      }

      /*
        Whether the credential can actually write, established before anything
        is generated. A repository reports the *user's* role, not the token's
        grants, so this is the only way to know — and finding out at the push
        instead means generating an entire site first.
      */
      const write = await github.checkWriteAccess(workspace.target.repo);
      if (!write.ok) {
        return [
          `${state.repo} exists, but this publish cannot write to it, so there is no point generating anything.`,
          write.detail,
          "Tell the administrator exactly this and stop. It is a credential problem: nothing about the site or the generated code will change it.",
        ].join("\n");
      }

      return [
        `${state.repo} exists — default branch ${state.defaultBranch || "(none yet)"}, ${
          state.private ? "private" : "public"
        }.`,
        state.empty ? "It has no commits yet, so this publish writes the first one." : "",
        "The token can write to it.",
        state.generatedByStudio
          ? "It holds a previous publish of a studio site (blueprint.json at the root), so republishing is the normal case."
          : state.empty
            ? ""
            : `It holds files the studio did not generate: ${state.rootEntries.slice(0, 10).join(", ")}. ${
                workspace.target.allowNonEmpty
                  ? "The administrator has agreed the site may be published over them."
                  : "push_site will refuse until the administrator agrees to that."
              }`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const createRepo = betaZodTool({
    name: "create_repository",
    description:
      "Create the destination repository, when it does not exist. Uses the visibility the administrator chose.",
    inputSchema: z.object({}),
    run: async () => {
      const state = workspace.repo ?? (await github.describe(workspace.target.repo));
      if (state.exists) {
        workspace.repo = state;
        return `${state.repo} already exists — nothing to create.`;
      }

      const created = await github.create(workspace.target.repo, {
        private: workspace.target.private,
        description: `Career site for ${workspace.blueprint.company.name}, generated by Career Site Studio.`,
      });
      workspace.repo = created;

      onActivity("create_repository", `Created ${created.repo}`);
      return `Created ${created.repo} (${created.private ? "private" : "public"}). It has no commits yet.`;
    },
  });

  const pushSite = betaZodTool({
    name: "push_site",
    description:
      "Push the generated site to the destination repository as one commit. Removes generated files the site no longer has, and leaves anything else in the repository alone.",
    inputSchema: z.object({
      message: z.string().optional().describe("the commit message; one line, says what changed"),
    }),
    run: async ({ message }) => {
      requireSite();
      const files = [...workspace.files.values()];
      const { blueprint, target } = workspace;

      // Cheap, and it turns an opaque mid-push 403 into one sentence.
      const write = await github.checkWriteAccess(target.repo);
      if (!write.ok) return `Cannot push to ${target.repo}. ${write.detail}`;

      const result = await github.push({
        repo: target.repo,
        branch: target.branch,
        files,
        message:
          message?.trim() ||
          `${blueprint.company.name} career site — blueprint v${blueprint.version}`,
        allowNonEmpty: target.allowNonEmpty,
      });

      workspace.push = result;
      workspace.warnings.push(...result.warnings);

      onActivity("push_site", `Pushed ${result.written} files to ${target.repo}`);

      return [
        `Pushed ${result.written} files to ${target.repo} on ${result.branch}.`,
        result.commitUrl ? `Commit: ${result.commitUrl}` : "",
        result.removed.length > 0
          ? `Removed ${result.removed.length} generated file(s) the site no longer has: ${result.removed
              .slice(0, 8)
              .join(", ")}`
          : "",
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const configureVercel = betaZodTool({
    name: "configure_vercel_project",
    description:
      "Find or create the Vercel project for this site, linked to the destination repository where Vercel allows it.",
    inputSchema: z.object({}),
    run: async () => {
      if (!vercel.configured) {
        return "VERCEL_TOKEN is not set, so the studio cannot talk to Vercel. The code is pushed; tell the administrator to import the repository once at https://vercel.com/new and Vercel will build every push from then on.";
      }

      const name = workspace.target.vercelProject || workspace.blueprint.company.name;
      const { project, created, linkWarning } = await vercel.ensureProject({
        name,
        repo: workspace.target.repo,
        framework: workspace.target.target === "angular" ? "angular" : "nextjs",
      });

      workspace.vercelProject = project;
      if (linkWarning) workspace.warnings.push(linkWarning);

      onActivity("configure_vercel_project", `${created ? "Created" : "Found"} Vercel project ${project.name}`);

      return [
        `${created ? "Created" : "Found"} Vercel project ${project.name} (${project.id}).`,
        project.linkedRepo
          ? `Linked to ${project.linkedRepo}, so future pushes deploy themselves.`
          : "Not linked to a repository, so this publish deploys the generated files directly and later pushes will not deploy on their own.",
        linkWarning,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const startDeployment = betaZodTool({
    name: "start_deployment",
    description:
      "Start the Vercel production deployment — from the pushed commit when the project is linked to the repository, and from the generated files when it is not.",
    inputSchema: z.object({}),
    run: async () => {
      if (!vercel.configured) {
        return "VERCEL_TOKEN is not set, so there is no deployment to start. Say so plainly rather than implying the site is live.";
      }
      const project = workspace.vercelProject;
      if (!project) return "No Vercel project yet — call configure_vercel_project first.";

      const site = requireSite();
      void site;

      let deployment: VercelDeployment;
      if (project.linkedRepo && workspace.push) {
        deployment = await vercel.deployFromGit({
          project,
          repo: workspace.target.repo,
          ref: workspace.push.branch,
          production: true,
        });
      } else {
        deployment = await vercel.deployFiles({
          project,
          // Vercel builds what it is given, so it gets exactly what was pushed.
          files: [...workspace.files.values()],
          production: true,
          framework: workspace.target.target === "angular" ? "angular" : "nextjs",
        });
      }

      workspace.vercelDeployment = deployment;
      onActivity("start_deployment", `Started a Vercel deployment of ${project.name}`);

      return [
        `Deployment ${deployment.id} started (${deployment.state}).`,
        deployment.url ? `URL when ready: https://${deployment.url}` : "",
        deployment.inspectorUrl ? `Build log: ${deployment.inspectorUrl}` : "",
        project.linkedRepo && workspace.push
          ? `Building commit ${workspace.push.commitSha.slice(0, 7)} from ${workspace.target.repo}.`
          : "Building the generated files directly.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const checkDeployment = betaZodTool({
    name: "check_deployment",
    description:
      "Wait for the deployment to change state and report where it got to. Call it again while it is still building.",
    inputSchema: z.object({}),
    run: async () => {
      const started = workspace.vercelDeployment;
      if (!started) return "No deployment has been started.";

      const deadline = Date.now() + POLL_TOTAL_MS;
      let current = started;
      while (Date.now() < deadline) {
        current = await vercel.getDeployment(started.id);
        workspace.vercelDeployment = current;
        if (current.state === "READY" || current.state === "ERROR" || current.state === "CANCELED") break;
        await sleep(POLL_EVERY_MS);
      }

      onActivity("check_deployment", `Deployment is ${current.state.toLowerCase()}`);

      if (current.state === "READY") {
        const live = current.aliases[0] ?? current.url;
        return `Ready. The site is live at https://${live}.`;
      }
      if (current.state === "ERROR") {
        return "The deployment failed. Call read_deployment_log, find the cause, and fix it if it is in a generated file.";
      }
      if (current.state === "CANCELED") return "The deployment was cancelled.";
      return `Still ${current.state.toLowerCase()} after ${Math.round(POLL_TOTAL_MS / 1000)}s. Call check_deployment again.`;
    },
  });

  const readLog = betaZodTool({
    name: "read_deployment_log",
    description: "Read the tail of the Vercel build log. Use it when a deployment fails.",
    inputSchema: z.object({
      lines: z.number().int().min(10).max(200).optional(),
    }),
    run: async ({ lines }) => {
      const deployment = workspace.vercelDeployment;
      if (!deployment) return "No deployment has been started.";

      const log = await vercel.buildLog(deployment.id, lines ?? 60);
      onActivity("read_deployment_log", "Read the Vercel build log");
      return log || "The build produced no log output.";
    },
  });

  return [
    readSite,
    generate,
    listFiles,
    readFile,
    writeFile,
    inspectRepo,
    createRepo,
    pushSite,
    configureVercel,
    startDeployment,
    checkDeployment,
    readLog,
  ];
}

/** What the orchestrator writes onto the deployment record when the run ends. */
export function deploymentFacts(workspace: DeployWorkspace): Partial<Deployment> {
  const { push, vercelDeployment, vercelProject, site } = workspace;
  const live = vercelDeployment?.aliases[0] ?? vercelDeployment?.url ?? "";

  const succeeded =
    vercelDeployment?.state === "READY" ||
    // No Vercel credentials: a completed push is as far as a publish can get,
    // and calling that a failure would be wrong. The warnings say what is left.
    (!getVercelClient().configured && Boolean(push?.commitSha));

  return {
    status: succeeded ? "succeeded" : "failed",
    finishedAt: new Date().toISOString(),
    commitSha: push?.commitSha ?? "",
    commitUrl: push?.commitUrl ?? "",
    filesPushed: push?.written ?? 0,
    vercelProject: vercelProject?.name ?? "",
    vercelDeploymentId: vercelDeployment?.id ?? "",
    url: live ? `https://${live}` : "",
    inspectorUrl: vercelDeployment?.inspectorUrl ?? "",
    pendingComponents: site?.pendingComponents ?? [],
    warnings: [...new Set([...(site?.warnings ?? []), ...workspace.warnings])],
  };
}
