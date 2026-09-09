import { store } from "@/lib/store/store";
import { getFigmaProvider, parseFigmaUrl } from "@/lib/providers/figma";
import { summarizeDesign } from "@/lib/providers/figma/summarize";
import { analyzeDesign } from "@/lib/agent/analyze";
import { describeApiError } from "@/lib/agent/client";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Runs the Figma import directly, outside a chat turn.
 *
 * The same flow is available to the agent as a tool, but the import screen
 * calls this so the first thing an administrator does is a button, not a
 * sentence they have to compose.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const project = await store.getProject(projectId);
  if (!project) return Response.json({ error: "No such project" }, { status: 404 });

  const body = (await request.json()) as { figmaUrl?: string; nodeId?: string };
  const parsed = parseFigmaUrl(body.figmaUrl ?? "");

  // The mock backend needs no real key, so an empty field is allowed there and
  // an error everywhere else.
  const provider = getFigmaProvider();
  if (!parsed && provider.backend !== "mock") {
    return Response.json(
      { error: "Enter a Figma file URL, e.g. https://www.figma.com/design/<key>/<name>" },
      { status: 400 },
    );
  }

  try {
    // Passing the project id is what makes the rendered frame PNGs persist:
    // the backends put them through the asset store instead of leaving
    // Figma's signed URLs, which expire long before anyone reviews them.
    const design = await provider.fetchDesign(
      parsed?.fileKey ?? "",
      body.nodeId ?? parsed?.nodeId,
      projectId,
    );
    const { plan, dropped, notes } = await analyzeDesign(design);

    await store.savePlan(projectId, plan, {
      backend: design.backend,
      fileName: design.fileName,
      frameCount: design.frames.length,
      dropped,
      // The importer's own notes belong beside the backend's: from the
      // admin's side both are "things to know about this import".
      warnings: [...design.warnings, ...notes],
      // The fidelity review compares the built site back against the design,
      // so the design has to survive past this request. Band heights and the
      // rendered frame images live only on the DesignDocument, which is not
      // persisted anywhere else — without them the review can still check
      // coverage and tokens, but it has no reference image to show.
      designSummary: summarizeDesign(design),
      designStyles: design.styles,
      designImages: design.images,
    });
    // The summary above deliberately has no geometry, so it cannot drive a
    // replica. describe_design_node reads the document itself for that.
    await store.saveDesign(projectId, design);
    await store.updateProject(projectId, {
      entryPoint: "figma",
      sourceRef: parsed?.fileKey ?? design.fileKey,
      name: project.name === "Untitled site" ? design.fileName : project.name,
    });

    return Response.json({
      plan,
      dropped,
      backend: design.backend,
      fileName: design.fileName,
      warnings: [...design.warnings, ...notes],
    });
  } catch (error) {
    return Response.json({ error: describeApiError(error) }, { status: 502 });
  }
}
