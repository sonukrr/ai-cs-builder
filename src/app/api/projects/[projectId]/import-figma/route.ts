import { store } from "@/lib/store/store";
import { getFigmaProvider, parseFigmaUrl } from "@/lib/providers/figma";
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
    const design = await provider.fetchDesign(parsed?.fileKey ?? "", body.nodeId ?? parsed?.nodeId);
    const { plan, dropped } = await analyzeDesign(design);

    await store.savePlan(projectId, plan, {
      backend: design.backend,
      fileName: design.fileName,
      frameCount: design.frames.length,
      dropped,
      warnings: design.warnings,
    });
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
      warnings: design.warnings,
    });
  } catch (error) {
    return Response.json({ error: describeApiError(error) }, { status: 502 });
  }
}
