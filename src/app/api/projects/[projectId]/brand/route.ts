import { Blueprint, DesignTokens } from "@/lib/blueprint/schema";
import { store } from "@/lib/store/store";

export const runtime = "nodejs";

/**
 * Live style editing — colors and company copy, saved outside the
 * conversational agent path.
 *
 * This still lands through `store.saveVersion`, the same append-only history
 * every other edit goes through, so a style change shows up in "History" and
 * can be reverted like any other. It only ever merges the fields it was sent;
 * everything else in the blueprint is carried through untouched.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) return Response.json({ error: "This project has no site yet" }, { status: 400 });

  const body = (await request.json()) as {
    companyName?: string;
    tagline?: string;
    colors?: Partial<DesignTokens["colors"]>;
  };

  const nextBlueprint: Blueprint = {
    ...blueprint,
    company: {
      ...blueprint.company,
      name: body.companyName?.trim() || blueprint.company.name,
      tagline: body.tagline ?? blueprint.company.tagline,
      brand: {
        ...blueprint.company.brand,
        tokens: {
          ...blueprint.company.brand.tokens,
          colors: {
            ...blueprint.company.brand.tokens.colors,
            ...body.colors,
          },
        },
      },
    },
  };

  const parsed = Blueprint.safeParse(nextBlueprint);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid style values" }, { status: 400 });
  }

  const version = await store.saveVersion(projectId, {
    blueprint: parsed.data,
    summary: "Updated brand styling",
    operations: [{ op: "update_brand", ...body }],
  });

  return Response.json({ version: version.version, blueprint: parsed.data });
}
