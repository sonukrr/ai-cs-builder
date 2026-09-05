import { store } from "@/lib/store/store";
import { emitAngularSite, usedComponents } from "@/lib/emit/angular";
import { registry } from "@/lib/registry";

export const runtime = "nodejs";

/**
 * The Angular the blueprint would produce.
 *
 * Exposed so the studio can show an administrator that a real site is being
 * described, and so a reviewer can read the output before approving a publish
 * request. Read-only — generating is not committing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "No blueprint yet" }, { status: 404 });

  return Response.json({
    library: `${registry.package.name}@${registry.package.version}`,
    ngModule: registry.package.ngModule,
    componentsUsed: usedComponents(blueprint),
    files: emitAngularSite(blueprint),
  });
}
