import { runDeployAgent, type DeployRequest } from "@/lib/agent/deploy-agent";
import { store } from "@/lib/store/store";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { generateSite, recommendedTarget } from "@/lib/agent/deploy-tools";
import { DeployTargetKind } from "@/lib/blueprint/schema";
import { deployTargetStatus, getDeployTargetProvider } from "@/lib/providers/github/deploy-target";
import { vercelStatus } from "@/lib/providers/vercel";

// Generating, pushing and waiting for a Vercel build is minutes, not seconds.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * What a publish would do, and what previous ones did.
 *
 * The publish panel opens on this: the destination already stored, the files
 * that would be written, and — the part that matters — the warnings, so an
 * administrator decides whether to publish while looking at the fact that the
 * job search will not work rather than discovering it afterwards.
 *
 * Generating to answer a GET is deliberate. It is pure computation over the
 * blueprint, and a preview that was assembled from a different code path than
 * the publish would eventually disagree with it.
 */
/**
 * Whether a destination is publishable, before anything is generated.
 *
 * Its own request because the panel asks as soon as the repository is typed:
 * a token that cannot write is by far the most common reason a publish fails,
 * and GitHub reports it only when something tries to write — a repository's
 * `permissions` field describes the *user's* role, not the token's grants.
 */
async function checkDestination(repo: string) {
  const provider = getDeployTargetProvider();

  try {
    const state = await provider.describe(repo);
    if (!state.exists) {
      return {
        repo: state.repo,
        exists: false,
        canWrite: null as boolean | null,
        detail: "Does not exist yet — the publish will create it.",
      };
    }

    const write = await provider.checkWriteAccess(repo);
    return {
      repo: state.repo,
      exists: true,
      empty: state.empty,
      generatedByStudio: state.generatedByStudio,
      rootEntries: state.rootEntries.slice(0, 8),
      canWrite: write.ok,
      detail: write.ok
        ? state.empty
          ? "Ready — empty, and the token can write to it."
          : state.generatedByStudio
            ? "Ready — holds a previous publish of this site."
            : `Holds files the studio did not generate (${state.rootEntries.slice(0, 5).join(", ")}). Tick the overwrite box to publish over them.`
        : write.detail,
    };
  } catch (error) {
    return {
      repo,
      exists: false,
      canWrite: false as boolean | null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const url = new URL(request.url);
  const requested = DeployTargetKind.safeParse(url.searchParams.get("target"));

  const check = url.searchParams.get("check");
  if (check) return Response.json({ destination: await checkDestination(check) });

  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  const [blueprint, target, deployments] = await Promise.all([
    store.getCurrentBlueprint(projectId),
    store.getDeployTarget(projectId),
    store.listDeployments(projectId),
  ]);

  const providers = { github: deployTargetStatus(), vercel: vercelStatus() };

  if (!blueprint) {
    return Response.json({ target, deployments, providers, preview: null, issues: [] });
  }

  const issues = validateBlueprint(blueprint);

  /*
    Which target to preview: what was asked for, else what this project last
    published as, else what the blueprint needs. Generating here is deliberate —
    it is pure computation over the blueprint, and a preview assembled from a
    different code path than the publish would eventually disagree with it.
  */
  const recommended = recommendedTarget(blueprint);
  const kind = requested.success ? requested.data : target?.target ?? recommended;

  /*
    Generated even when the blueprint does not validate. A publish is allowed
    to proceed on the administrator's instruction, so the preview has to show
    what it would produce — and the issues travel alongside it rather than
    replacing it.
  */
  let site: Awaited<ReturnType<typeof generateSite>> | null = null;
  let generateError = "";
  try {
    site = await generateSite(blueprint, kind, projectId);
  } catch (error) {
    generateError = error instanceof Error ? error.message : String(error);
  }

  if (!site) {
    return Response.json({
      target,
      deployments,
      providers,
      preview: null,
      generateError,
      issues: issues.filter((issue) => issue.level === "error"),
    });
  }

  return Response.json({
    target,
    deployments,
    providers,
    buildable: isBuildable(issues),
    issues: isBuildable(issues)
      ? issues.filter((issue) => issue.level === "warning")
      : issues.filter((issue) => issue.level === "error"),
    preview: {
      version: blueprint.version,
      kind,
      recommended,
      files: site.files.map((file) => ({ path: file.path, bytes: file.content.length })),
      pages: site.pages,
      warnings: site.warnings,
      notes: site.notes,
      pendingComponents: site.pendingComponents,
      libraryComponents: site.libraryComponents,
      suggestedRepoName: `${blueprint.company.name}`,
    },
  });
}

/**
 * Publishes, streamed to the browser as newline-delimited JSON.
 *
 * The same shape the agent route uses, and for the same reason: this is a POST
 * with a body that takes minutes, and the administrator should watch it happen
 * rather than stare at a spinner.
 *
 * The destination arrives in the body because it is the administrator's
 * decision, made here, and it is stored so the next publish inherits it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as Partial<DeployRequest>;

  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  // A stored target is the fallback, so a republish needs no arguments at all.
  const stored = await store.getDeployTarget(projectId);
  const repo = (body.repo ?? stored?.repo ?? "").trim();
  if (!repo) {
    return Response.json(
      { error: "Give the GitHub repository the site should be published to, as owner/name or a github.com URL." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        for await (const event of runDeployAgent({
          projectId,
          repo,
          branch: body.branch ?? stored?.branch,
          target: body.target ?? stored?.target,
          vercelProject: body.vercelProject ?? stored?.vercelProject,
          private: body.private ?? stored?.private,
          // Consent is per publish: a repository the administrator agreed to
          // overwrite last month is not consent to overwrite it today, unless
          // the stored target still says so and they did not change the repo.
          allowNonEmpty:
            body.allowNonEmpty ?? (stored?.repo === repo ? stored?.allowNonEmpty : false),
          publishRequestId: body.publishRequestId,
          notes: body.notes,
        })) {
          send(event);
        }
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
