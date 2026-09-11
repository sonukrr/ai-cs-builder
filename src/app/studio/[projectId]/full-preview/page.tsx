import { FullPreview } from "./FullPreview";

export default async function FullPreviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <FullPreview projectId={projectId} />;
}
