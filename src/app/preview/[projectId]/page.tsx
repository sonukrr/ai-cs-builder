import { PreviewClient } from "./PreviewClient";

export const dynamic = "force-dynamic";

/**
 * Dev-mode standalone preview.
 *
 * Unlike the studio's embedded PreviewFrame — pinned to a device width and
 * scaled down to fit a ~500px side panel — this route has the whole viewport
 * to itself, so the frame renders at true size. A floating "Customize" button
 * opens a color panel that patches the blueprint directly (theme route, no
 * assistant call), for trying out colors without spending an agent turn.
 */
export default async function StandalonePreviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PreviewClient projectId={projectId} />;
}
