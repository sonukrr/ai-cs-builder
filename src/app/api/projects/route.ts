import { store } from "@/lib/store/store";
import {
  defaultCareerSite,
  DEFAULT_SITE_SUMMARY,
  emptyCareerSite,
  EMPTY_SITE_SUMMARY,
} from "@/lib/blueprint/default-site";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ projects: await store.listProjects() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    entryPoint?: "figma" | "base" | "url";
    sourceRef?: string;
  };

  if (!body.name?.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (body.entryPoint !== "figma" && body.entryPoint !== "base" && body.entryPoint !== "url") {
    return Response.json({ error: "entryPoint must be 'figma', 'base' or 'url'" }, { status: 400 });
  }

  if (body.entryPoint === "url") {
    // The page to rebuild is the whole point of this entry, so it is required
    // here rather than discovered later in the conversation.
    let target: URL;
    try {
      target = new URL((body.sourceRef ?? "").trim());
    } catch {
      return Response.json(
        { error: "Give the address of the page to rebuild, including https://" },
        { status: 400 },
      );
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return Response.json({ error: "Only http and https pages can be read." }, { status: 400 });
    }
  }

  const project = await store.createProject({
    name: body.name.trim(),
    entryPoint: body.entryPoint,
    sourceRef: body.sourceRef,
  });

  /*
    A URL project starts empty.

    Everything on it is going to come from the page being scraped, so a seeded
    layout would be a site nobody asked for — shown in the preview as though it
    were theirs, and deleted section by section before the real one could be
    built. What is written is a blueprint with an empty home page, because
    `apply_operations` validates against an existing site and a project with no
    blueprint at all would need a second way in.
  */
  if (body.entryPoint === "url") {
    await store.saveVersion(project.id, {
      blueprint: emptyCareerSite({ projectId: project.id, companyName: project.name }),
      summary: EMPTY_SITE_SUMMARY,
      operations: [{ op: "empty_site" }],
    });
    return Response.json({ project: await store.getProject(project.id) }, { status: 201 });
  }

  /*
    A base project starts as a complete site rather than as an empty one.

    It used to wait for the agent's first turn to invent a layout, which made
    the first preview both slow and different every time. Writing the standard
    site here means the studio opens on something real — routable, with the
    approved job components already placed — and the conversation starts at
    "change this" instead of "build me something".
  */
  if (body.entryPoint === "base") {
    await store.saveVersion(project.id, {
      blueprint: defaultCareerSite({ projectId: project.id, companyName: project.name }),
      summary: DEFAULT_SITE_SUMMARY,
      operations: [{ op: "default_site" }],
    });
    return Response.json({ project: await store.getProject(project.id) }, { status: 201 });
  }

  // A Figma project gets nothing, on purpose: its structure comes from the
  // design, and seeding a layout first would only be something to delete.
  return Response.json({ project }, { status: 201 });
}
