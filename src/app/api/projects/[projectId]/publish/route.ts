import { store } from "@/lib/store/store";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { emitAngularSite, usedComponents } from "@/lib/emit/angular";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  return Response.json({ requests: await store.listPublishRequests(projectId) });
}

/**
 * Files a publish request.
 *
 * This is where the governance line sits: a company administrator can get a
 * site all the way to reviewable, and no further. Nothing here deploys, and the
 * blueprint has to validate before a request can even be filed.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const body = (await request.json().catch(() => ({}))) as { notes?: string };

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "Nothing to publish yet" }, { status: 400 });

  const issues = validateBlueprint(blueprint);
  if (!isBuildable(issues)) {
    return Response.json(
      { error: "The site does not validate", issues: issues.filter((i) => i.level === "error") },
      { status: 422 },
    );
  }

  const versions = await store.listVersions(projectId);
  const changeSummary = versions
    .slice(0, 10)
    .map((v) => `v${v.version}: ${v.summary}`)
    .join("\n");

  const publishRequest = await store.createPublishRequest({
    projectId,
    version: blueprint.version,
    requestedBy: "company-admin",
    changeSummary,
    notes: body.notes ?? "",
  });

  // The reviewer sees exactly what would be built, so approval is a judgement
  // about a concrete artefact rather than about a description of one.
  const files = emitAngularSite(blueprint);

  return Response.json({
    request: publishRequest,
    warnings: issues.filter((i) => i.level === "warning"),
    build: {
      files: files.map((f) => f.path),
      libraryComponents: usedComponents(blueprint),
    },
  });
}
