import { PlanScreen } from "./PlanScreen";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ figma?: string }>;
}) {
  const { projectId } = await params;
  const { figma } = await searchParams;

  // "demo" is the sentinel the start screen sends when no URL was supplied —
  // the mock backend ignores the key, and any other backend will reject it
  // with a message the admin can act on.
  return <PlanScreen projectId={projectId} figmaUrl={figma === "demo" ? "" : (figma ?? "")} />;
}
