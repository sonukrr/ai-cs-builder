import { Studio } from "./Studio";

export const dynamic = "force-dynamic";

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const { projectId } = await params;
  const { start } = await searchParams;
  return <Studio projectId={projectId} startFromBase={start === "base"} />;
}
