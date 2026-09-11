import { store } from "@/lib/store/store";
import { defaultCareerSite, DEFAULT_SITE_SUMMARY } from "@/lib/blueprint/default-site";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ projects: await store.listProjects() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    entryPoint?: "figma" | "base";
    sourceRef?: string;
  };

  if (!body.name?.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (body.entryPoint !== "figma" && body.entryPoint !== "base") {
    return Response.json({ error: "entryPoint must be 'figma' or 'base'" }, { status: 400 });
  }

  const project = await store.createProject({
    name: body.name.trim(),
    entryPoint: body.entryPoint,
    sourceRef: body.sourceRef,
  });

  /*
    A base project starts as a complete site rather than as an empty one.

    It used to wait for the agent's first turn to invent a layout, which made
    the first preview both slow and different every time. Writing the standard
    site here means the studio opens on something real — routable, with the
    approved job components already placed — and the conversation starts at
    "change this" instead of "build me something".

    A Figma project gets nothing, on purpose: its structure comes from the
    design, and seeding a layout first would only be something to delete.
  */
  if (body.entryPoint === "base") {
    await store.saveVersion(project.id, {
      blueprint: defaultCareerSite({ projectId: project.id, companyName: project.name }),
      summary: DEFAULT_SITE_SUMMARY,
      operations: [{ op: "default_site" }],
    });
    return Response.json({ project: await store.getProject(project.id) }, { status: 201 });
  }

  return Response.json({ project }, { status: 201 });
}
