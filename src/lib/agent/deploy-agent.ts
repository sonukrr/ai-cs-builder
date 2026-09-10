import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, describeApiError, MODEL } from "./client";
import { buildDeployTools, deploymentFacts, type DeployWorkspace } from "./deploy-tools";
import { store } from "@/lib/store/store";
import type { Deployment, DeployTarget, DeployTargetKind } from "@/lib/blueprint/schema";
import { recommendedTarget } from "./deploy-tools";
import { parseRepo } from "@/lib/providers/github/types";
import { refusedDestination } from "@/lib/providers/github/deploy";
import { deployTargetStatus } from "@/lib/providers/github/deploy-target";
import { vercelStatus } from "@/lib/providers/vercel";

/**
 * The deploy agent.
 *
 * A second agent, not a second skill of the first one. The studio agent's whole
 * world is the blueprint: it changes a site by describing it, and every guard
 * rail it has is about not claiming capability the component library does not
 * have. Publishing is a different job with different failure modes — a
 * repository that already holds something, a Vercel project that is not linked
 * to GitHub, a build that fails on one file — and a different definition of
 * done. Giving those to the studio agent would mean one agent with two
 * unrelated tool sets, where the tools that can overwrite a repository are in
 * scope for every "make the hero bigger" turn.
 *
 * So the handoff is explicit: the studio agent (or the studio's publish panel)
 * names a project version and a destination, and this agent takes it from
 * there. What it is handed is the blueprint — the same thing the preview
 * renders — because that is what "the current project" actually is.
 */

const ROLE = `You are the deploy agent for Career Site Studio. You are handed a career
site that a company administrator has already built and approved in the studio,
and a GitHub destination they supplied. Your job is to get that site into their
repository and live on Vercel, and to be exact about what happened.

WHAT YOU ARE PUBLISHING.
The site is a Site Blueprint. generate_react_site turns it into a Next.js
application — the same sections the administrator saw in the preview, ported to
React. You do not write the site. You do not improve it, rename anything, or
change its copy: a difference between what they approved and what goes live is a
defect even when it is an improvement.

THE ORDER OF WORK.
1. read_site, so you know what version you are publishing and whether it
   validates.
2. generate_react_site. Read its warnings — they are what the administrator
   needs to hear.
3. inspect_repository. If it does not exist, create_repository. If it exists and
   holds files the studio did not generate, and the administrator has not agreed
   it may be overwritten, stop and say so: name what is in there and ask them to
   confirm. Do not look for another way around it.
   If it reports that the token cannot write, stop there and relay the remedy
   verbatim. That is a credential problem: generating, retrying and patching all
   fail the same way, and doing them anyway wastes minutes to reach the same
   sentence.
4. push_site.
5. configure_vercel_project, then start_deployment, then check_deployment until
   it settles. A build takes a minute or two; check_deployment waits for you, so
   call it again rather than assuming.
6. If the build fails: read_deployment_log, find the actual cause, and fix it
   only if it is a genuine defect in a generated file — patch_generated_file,
   then push_site and start_deployment again. Two attempts at most. If it is not
   a generated-file problem — a missing environment variable, a Vercel account
   limit, a permissions error — say what the log says and stop.

WHAT YOU MAY NOT DO.
- You have no way to choose the destination. It is on the project, an
  administrator put it there, and every tool uses it. If it is wrong, say so.
- Never claim the site is live without a READY deployment and a URL. If Vercel
  is not configured, the truthful report is that the code is pushed and what
  they have to do at vercel.com — not that it is deployed.
- Never present the functional gaps as done. The approved careers components are
  Angular, so job search, listings, filters and the application flow render as
  labelled placeholders in this React build. Say which ones, and that candidates
  cannot search or apply on the deployed site until they are integrated.
- Do not fix content, copy or layout problems by patching generated files. Those
  belong in the studio, where they become a version. A patch is for a build
  error and nothing else.

HOW TO REPORT.
End with a short report, in this order: whether it is live and the URL; the
repository and commit; what is not working and why; what the administrator has
to do next, if anything. Plain sentences, no headings, no preamble, no offers to
help further. If something failed, the first sentence says so.`;

export type DeployEvent =
  | { type: "text"; text: string }
  | { type: "activity"; tool: string; summary: string }
  | { type: "deployment"; deployment: Deployment }
  | { type: "done"; deployment: Deployment }
  | { type: "error"; message: string };

export interface DeployRequest {
  projectId: string;
  /** The destination. Supplied by an administrator, never inferred. */
  repo: string;
  branch?: string;
  /**
   * Which application to generate. Omitted means the one the blueprint needs:
   * Angular whenever it uses an approved careers component, because that is the
   * only target those can run in.
   */
  target?: DeployTargetKind;
  vercelProject?: string;
  private?: boolean;
  /**
   * The administrator has been shown that the repository holds files the studio
   * did not generate, and has said to publish over them.
   */
  allowNonEmpty?: boolean;
  publishRequestId?: string;
  requestedBy?: string;
  /** Anything the administrator wants the agent to know. */
  notes?: string;
}

/**
 * Normalises and vets a destination before anything else happens.
 *
 * Deliberately outside the agent: a bad destination is not something to reason
 * about, and the one destination that must always be refused — the approved
 * base repository — must be refused whether the request came from the publish
 * panel, from the studio agent, or from a direct API call.
 */
export function resolveTarget(request: DeployRequest, kind: DeployTargetKind): DeployTarget {
  const refused = refusedDestination(request.repo);
  if (refused) throw new Error(refused);

  const parsed = parseRepo(request.repo)!;
  const branch = (request.branch ?? "main").trim() || "main";
  if (!/^[\w.\-/]{1,80}$/.test(branch) || branch.includes("..")) {
    throw new Error(`"${branch}" is not a usable branch name.`);
  }

  return {
    repo: `${parsed.owner}/${parsed.name}`,
    branch,
    target: kind,
    vercelProject: (request.vercelProject ?? "").trim(),
    private: request.private ?? true,
    allowNonEmpty: request.allowNonEmpty ?? false,
    savedAt: new Date().toISOString(),
    savedBy: request.requestedBy ?? "company-admin",
  };
}

/**
 * Runs one publish, yielding events as they happen.
 *
 * The deployment record is written before the model is called and updated from
 * the workspace when it returns, so what the record says happened does not
 * depend on the model reporting it. The model's contribution to the record is
 * its summary — prose, clearly labelled as prose.
 */
export async function* runDeployAgent(request: DeployRequest): AsyncGenerator<DeployEvent> {
  const project = await store.getProject(request.projectId);
  if (!project) {
    yield { type: "error", message: "No such project." };
    return;
  }

  const blueprint = await store.getCurrentBlueprint(request.projectId);
  if (!blueprint) {
    yield { type: "error", message: "This project has no site to publish yet." };
    return;
  }

  // The blueprint decides this unless the administrator overrode it: a site
  // with careers components in it cannot work as a React build.
  const target = resolveTarget(request, request.target ?? recommendedTarget(blueprint));

  // The destination is remembered, so a second publish does not ask again and
  // so the record of where this project publishes to outlives the run.
  await store.saveDeployTarget(request.projectId, target);

  let record = await store.createDeployment({
    projectId: request.projectId,
    version: blueprint.version,
    publishRequestId: request.publishRequestId,
    requestedBy: request.requestedBy,
    repo: target.repo,
    branch: target.branch,
    target: target.target,
    vercelProject: target.vercelProject,
  });
  yield { type: "deployment", deployment: record };

  const workspace: DeployWorkspace = {
    projectId: request.projectId,
    deploymentId: record.id,
    blueprint,
    target,
    site: null,
    files: new Map(),
    repo: null,
    push: null,
    vercelProject: null,
    vercelDeployment: null,
    warnings: [],
  };

  const pending: DeployEvent[] = [];
  const onActivity = (tool: string, summary: string) => {
    pending.push({ type: "activity", tool, summary });
  };

  const tools = buildDeployTools({ workspace, onActivity });

  const github = deployTargetStatus();
  const vercel = vercelStatus();

  const brief = [
    `Publish ${blueprint.company.name}, blueprint version ${blueprint.version}, to ${target.repo} on branch ${target.branch}.`,
    target.target === "angular"
      ? "Generate the Angular application: it installs the approved careers library, so job search, listings, filters and the application flow are the real components."
      : "Generate the React (Next.js) application. The approved careers components cannot run in it and will emit as labelled gaps.",
    request.notes?.trim() ? `The administrator says: ${request.notes.trim()}` : "",
    target.allowNonEmpty
      ? "The administrator has confirmed the repository may be published over, even if it already holds files."
      : "",
    `This deployment's GitHub access: ${github.backend} — ${github.detail}`,
    `This deployment's Vercel access: ${vercel.ready ? "configured" : "not configured"} — ${vercel.detail}`,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: brief }];

  let summary = "";
  let failure = "";

  try {
    const runner = anthropic().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: ROLE }],
      tools,
      messages,
      stream: true,
      // A publish is a dozen steps, and a failed build plus a fix plus a
      // re-deploy is a dozen more.
      max_iterations: 28,
    });

    for await (const stream of runner) {
      const deltas: string[] = [];
      stream.on("text", (delta) => deltas.push(delta));

      const finalMessage = await stream.finalMessage();

      for (const delta of deltas) {
        summary += delta;
        yield { type: "text", text: delta };
      }

      while (pending.length > 0) yield pending.shift()!;

      if (finalMessage.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: finalMessage.content });
      }
      if (finalMessage.stop_reason === "refusal") {
        failure = "The model declined to complete this publish.";
        break;
      }
    }
  } catch (error) {
    failure = describeApiError(error);
    yield { type: "error", message: failure };
  }

  while (pending.length > 0) yield pending.shift()!;

  const facts = deploymentFacts(workspace);
  record = await store.updateDeployment(request.projectId, record.id, {
    ...facts,
    // A run that died mid-flight has not succeeded, whatever the facts imply.
    status: failure ? "failed" : facts.status,
    summary: summary.trim() || failure,
  });

  // The project's status follows the deployment rather than the request, so the
  // studio can say "live" only when something is.
  if (record.status === "succeeded" && record.url) {
    await store.updateProject(request.projectId, { status: "deployed" });
  }

  yield { type: "done", deployment: record };
}
