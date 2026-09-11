import { store } from "@/lib/store/store";
import { Studio } from "./Studio";

export const dynamic = "force-dynamic";

/**
 * What the studio says first, if anything.
 *
 * An administrator who has just chosen a starting point should land in a
 * conversation that has already begun, not in an empty box next to a site they
 * did not ask for yet. The message is composed here, on the server, because it
 * depends on the project — a URL project has to name the page it is rebuilding.
 */
async function openingMessage(projectId: string, start: string | undefined): Promise<string> {
  if (start === "base") {
    return "I want to start from the approved base career site. Look at what is already here, then ask me what you need to know about my company to customise it.";
  }

  if (start === "url") {
    const project = await store.getProject(projectId);
    const url = project?.sourceRef?.trim();
    if (!url) return "";
    return (
      `This is our careers page: ${url}\n\n` +
      "This project is empty on purpose — everything comes from that page. Rebuild it to match: its structure, " +
      "layout, copy, imagery, styling and animations. Import it first, apply its design tokens, then build it band " +
      "by band in the order it reads, using the approved components for anything functional. Add whatever pages it " +
      "needs. Tell me what you could not reproduce and why."
    );
  }

  return "";
}

export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const { projectId } = await params;
  const { start } = await searchParams;
  return <Studio projectId={projectId} opening={await openingMessage(projectId, start)} />;
}
