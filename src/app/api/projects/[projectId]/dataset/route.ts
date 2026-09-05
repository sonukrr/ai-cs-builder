import { dataset } from "@/lib/store/dataset";
import { store } from "@/lib/store/store";

export const runtime = "nodejs";

/** The preview host reads this from its own origin. */
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

/**
 * The project's researched job data, if it has any.
 *
 * Read by the preview when its data source is "custom". Returns `null` rather
 * than a 404 when there is none, so the preview can fall back to the built-in
 * fixtures without treating the absence as an error.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  return Response.json({ dataset: await dataset.get(projectId) }, { headers: corsHeaders() });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await store.getProject(projectId))) {
    return Response.json({ error: "No such project" }, { status: 404 });
  }
  await dataset.clear(projectId);
  return Response.json({ ok: true });
}
