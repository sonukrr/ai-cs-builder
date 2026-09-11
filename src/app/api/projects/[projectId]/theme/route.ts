import { applyOperations, BlueprintOperation } from "@/lib/blueprint/operations";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { store } from "@/lib/store/store";

export const runtime = "nodejs";

/**
 * Patches design tokens directly, without going through the assistant.
 *
 * Same rationale as sections/route.ts: the dev-mode customize panel changes a
 * color and expects it applied immediately, with no model round-trip (and no
 * token spend) for an outcome that isn't ambiguous. It still routes through
 * the same operation and validation as an agent edit — the UI is a different
 * way in, not a way around the rules.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "This project has no site yet" }, { status: 400 });

  const body = (await request.json()) as { tokens?: unknown };
  if (!body.tokens || typeof body.tokens !== "object") {
    return Response.json({ error: "tokens is required" }, { status: 400 });
  }

  const parsed = BlueprintOperation.safeParse({ op: "update_theme", tokens: body.tokens });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid tokens" }, { status: 400 });
  }

  const result = applyOperations(blueprint, [parsed.data]);
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

  const version = await store.saveVersion(projectId, {
    blueprint: result.blueprint,
    summary: "Customized theme colors",
    operations: [parsed.data as unknown as Record<string, unknown>],
  });

  return Response.json({ version: version.version, blueprint: result.blueprint }, { status: 200 });
}
