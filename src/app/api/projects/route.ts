import { store } from "@/lib/store/store";

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

  return Response.json({ project }, { status: 201 });
}
