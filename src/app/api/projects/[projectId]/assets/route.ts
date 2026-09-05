import { assets, MAX_UPLOAD_BYTES } from "@/lib/store/assets";
import { store } from "@/lib/store/store";

export const runtime = "nodejs";

/** Uploads are bounded by MAX_UPLOAD_BYTES; give the body a little headroom. */
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await store.getProject(projectId))) {
    return Response.json({ error: "No such project" }, { status: 404 });
  }

  return Response.json({
    assets: await assets.list(projectId),
    totalBytes: await assets.totalBytes(projectId),
    allowedTypes: assets.allowedTypes(),
    maxBytes: MAX_UPLOAD_BYTES,
  });
}

/**
 * Accepts an image the company owns.
 *
 * This is what lets a career site show the actual company rather than stock
 * photography of somebody else's office.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await store.getProject(projectId))) {
    return Response.json({ error: "No such project" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) {
    return Response.json({ error: "Attach an image as the `file` field" }, { status: 400 });
  }

  if (!assets.isAllowed(file.type)) {
    return Response.json(
      { error: `${file.type || "That file"} is not a supported image type`, allowed: assets.allowedTypes() },
      { status: 415 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "Image is larger than 8MB" }, { status: 413 });
  }

  try {
    const stored = await assets.save(projectId, {
      data: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
      alt: String(form.get("alt") ?? ""),
    });
    return Response.json({ asset: stored }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
