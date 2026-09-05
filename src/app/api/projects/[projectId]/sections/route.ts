import { applyOperations, BlueprintOperation } from "@/lib/blueprint/operations";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { store } from "@/lib/store/store";
import { getComponent, getStaticSection } from "@/lib/registry";
import type { Blueprint, Section } from "@/lib/blueprint/schema";

export const runtime = "nodejs";

/**
 * Every section on the site, containers and their children alike.
 *
 * A page's sections stopped being a flat list when layout containers arrived,
 * so both callers below have to recurse: ids are unique site-wide including
 * nested ones, and a section the admin tidied into a row is still deletable.
 */
function allSections(blueprint: Blueprint): Section[] {
  const out: Section[] = [];
  const walk = (sections: Section[]) => {
    for (const section of sections) {
      out.push(section);
      if (section.children?.length) walk(section.children);
    }
  };
  for (const page of blueprint.pages) walk(page.sections);
  return out;
}

/**
 * Adds a section from the catalog, without going through the assistant.
 *
 * 08-admin-ui.md asks for structured controls alongside the conversation, for
 * actions where the outcome is already unambiguous. "Add a job search to this
 * page" is one of those: there is nothing to interpret, so making someone type
 * it and wait for a model round-trip is worse than a button.
 *
 * It still routes through the same operations and validation as an agent edit —
 * the UI is a different way in, not a way around the rules.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "This project has no site yet" }, { status: 400 });

  const body = (await request.json()) as {
    pageId?: string;
    type?: string;
    source?: "zm-careers-lib" | "custom";
    index?: number;
  };

  if (!body.pageId || !body.type || !body.source) {
    return Response.json({ error: "pageId, type and source are required" }, { status: 400 });
  }

  const component = body.source === "zm-careers-lib" ? getComponent(body.type) : undefined;
  const staticDef = body.source === "custom" ? getStaticSection(body.type) : undefined;
  if (body.source === "zm-careers-lib" && (!component || component.status !== "approved")) {
    return Response.json({ error: `"${body.type}" is not an approved component` }, { status: 400 });
  }
  if (body.source === "custom" && !staticDef) {
    return Response.json({ error: `"${body.type}" is not a known section` }, { status: 400 });
  }

  // Section ids are unique site-wide, so derive one from the type and suffix it
  // until it is free — the same shape of id the agent produces.
  const taken = new Set(allSections(blueprint).map((section) => section.id));
  let id = body.type;
  for (let n = 2; taken.has(id); n += 1) id = `${body.type}-${n}`;

  const operation = BlueprintOperation.parse({
    op: "add_section",
    pageId: body.pageId,
    id,
    type: body.type,
    source: body.source,
    label: component?.name ?? staticDef?.name ?? body.type,
    props: {},
    content: {},
    ...(body.index !== undefined ? { index: body.index } : {}),
  });

  const result = applyOperations(blueprint, [operation]);
  if (result.rejected.length > 0) {
    return Response.json({ error: result.rejected[0].reason }, { status: 400 });
  }

  const issues = validateBlueprint(result.blueprint);
  if (!isBuildable(issues)) {
    return Response.json(
      { error: "That would make the site invalid", issues: issues.filter((i) => i.level === "error") },
      { status: 422 },
    );
  }

  const label = component?.name ?? staticDef?.name ?? body.type;
  const page = blueprint.pages.find((candidate) => candidate.id === body.pageId);
  const version = await store.saveVersion(projectId, {
    blueprint: result.blueprint,
    summary: `Added "${label}" to ${page?.name ?? body.pageId}`,
    operations: [operation as unknown as Record<string, unknown>],
  });

  return Response.json({ sectionId: id, version: version.version, blueprint: result.blueprint }, { status: 201 });
}

/** Removes a section. The catalog panel's counterpart to adding one. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "This project has no site yet" }, { status: 400 });

  const sectionId = new URL(request.url).searchParams.get("sectionId");
  if (!sectionId) return Response.json({ error: "sectionId is required" }, { status: 400 });

  const existing = allSections(blueprint).find((section) => section.id === sectionId);
  if (!existing) return Response.json({ error: `No section "${sectionId}"` }, { status: 404 });

  const result = applyOperations(blueprint, [{ op: "remove_section", sectionId }]);
  const issues = validateBlueprint(result.blueprint);
  if (!isBuildable(issues)) {
    return Response.json(
      { error: "That would make the site invalid", issues: issues.filter((i) => i.level === "error") },
      { status: 422 },
    );
  }

  const version = await store.saveVersion(projectId, {
    blueprint: result.blueprint,
    summary: `Removed "${existing.label}"`,
    operations: [{ op: "remove_section", sectionId }],
  });

  return Response.json({ version: version.version, blueprint: result.blueprint });
}
