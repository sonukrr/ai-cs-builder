import { store } from "@/lib/store/store";
import { planToBlueprint } from "@/lib/agent/analyze";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const pending = await store.getPlan(projectId);
  if (!pending) return Response.json({ error: "No pending plan" }, { status: 404 });
  return Response.json(pending);
}

/**
 * Approve the plan and build the first blueprint.
 *
 * 06-figma-import.md gates the build behind approval for major imports, so this
 * is the only path from a plan to a site — the analysis alone never commits
 * anything.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  const pending = await store.getPlan(projectId);
  if (!pending) return Response.json({ error: "No pending plan to approve" }, { status: 404 });

  const blueprint = planToBlueprint(pending.plan, projectId);
  const issues = validateBlueprint(blueprint);
  if (!isBuildable(issues)) {
    return Response.json(
      { error: "The plan does not validate", issues: issues.filter((i) => i.level === "error") },
      { status: 422 },
    );
  }

  const version = await store.saveVersion(projectId, {
    blueprint,
    summary: "Created the site from the imported design",
    operations: [{ op: "approve_plan" }],
  });
  await store.updateProject(projectId, { status: "ready" });

  return Response.json({ version: version.version, blueprint, warnings: issues });
}
