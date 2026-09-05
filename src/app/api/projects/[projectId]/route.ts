import { store } from "@/lib/store/store";
import { validateBlueprint } from "@/lib/blueprint/validate";

export const runtime = "nodejs";

/**
 * The Angular preview host runs on its own origin (localhost:4200 in
 * development) and fetches the blueprint from here, so this one route is
 * cross-origin readable. Scoped to the configured preview origin rather than
 * `*`, and only on GET — nothing that mutates a project is exposed this way.
 */
const PREVIEW_ORIGIN = process.env.PREVIEW_ORIGIN ?? "http://localhost:4200";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": PREVIEW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Everything the studio needs for one project, in one round trip. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const project = await store.getProject(projectId);
  if (!project) {
    return Response.json({ error: "No such project" }, { status: 404, headers: corsHeaders() });
  }

  const blueprint = await store.getCurrentBlueprint(projectId);
  const [versions, conversation, plan, publishRequests] = await Promise.all([
    store.listVersions(projectId),
    store.getConversation(projectId),
    store.getPlan(projectId),
    store.listPublishRequests(projectId),
  ]);

  return Response.json(
    {
      project,
      blueprint,
      issues: blueprint ? validateBlueprint(blueprint) : [],
      // Blueprints are the bulky part; history only needs its metadata here.
      versions: versions.map((v) => ({
        version: v.version,
        createdAt: v.createdAt,
        summary: v.summary,
      })),
      conversation,
      pendingPlan: plan,
      publishRequests,
    },
    { headers: corsHeaders() },
  );
}
