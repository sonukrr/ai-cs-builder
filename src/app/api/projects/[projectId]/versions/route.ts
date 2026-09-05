import { store } from "@/lib/store/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const versions = await store.listVersions(projectId);
  return Response.json({
    versions: versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      summary: v.summary,
      operationCount: v.operations.length,
    })),
  });
}

/** Undo. Restores an earlier version by writing it forward as a new one. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = (await request.json()) as { version?: number };

  if (typeof body.version !== "number") {
    return Response.json({ error: "version is required" }, { status: 400 });
  }

  try {
    const record = await store.revertTo(projectId, body.version);
    return Response.json({ version: record.version, blueprint: record.blueprint });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
