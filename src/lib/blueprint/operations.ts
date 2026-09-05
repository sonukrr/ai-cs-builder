import { z } from "zod";
import { type Blueprint, DesignTokens, Section, Slug } from "./schema";
import { getComponent, getStaticSection } from "@/lib/registry";

/**
 * The complete set of edits that can be made to a blueprint.
 *
 * The agent never writes a blueprint wholesale — it emits operations, which are
 * applied here. That buys three things the plan asks for: a change summary that
 * describes what actually happened rather than what the model said it did, an
 * undo stack, and a hard ceiling on what an edit is able to do.
 */

export const AddPageOp = z.object({
  op: z.literal("add_page"),
  id: Slug,
  name: z.string().min(1),
  path: z.string().regex(/^\//),
  afterPageId: Slug.optional(),
});

export const RemovePageOp = z.object({
  op: z.literal("remove_page"),
  pageId: Slug,
});

export const AddSectionOp = z.object({
  op: z.literal("add_section"),
  pageId: Slug,
  id: Slug,
  type: z.string().min(1),
  source: z.enum(["zm-careers-lib", "base", "custom"]),
  label: z.string().default(""),
  props: z.record(z.string(), z.unknown()).default({}),
  content: z.record(z.string(), z.unknown()).default({}),
  /** Insert position. Omit to append. */
  index: z.number().int().nonnegative().optional(),
});

export const RemoveSectionOp = z.object({
  op: z.literal("remove_section"),
  sectionId: Slug,
});

export const MoveSectionOp = z.object({
  op: z.literal("move_section"),
  sectionId: Slug,
  /** Move within, or across to, this page. Defaults to the current page. */
  toPageId: Slug.optional(),
  /** Exactly one of these positioning hints. */
  beforeSectionId: Slug.optional(),
  afterSectionId: Slug.optional(),
  index: z.number().int().nonnegative().optional(),
});

export const UpdateSectionOp = z.object({
  op: z.literal("update_section"),
  sectionId: Slug,
  label: z.string().optional(),
  /** Shallow-merged into existing props. Pass null to clear one. */
  props: z.record(z.string(), z.unknown()).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  visible: z.boolean().optional(),
});

export const UpdateThemeOp = z.object({
  op: z.literal("update_theme"),
  tokens: DesignTokens.partial().and(
    z.object({ colors: DesignTokens.shape.colors.partial().optional() }).partial(),
  ),
});

export const UpdateCompanyOp = z.object({
  op: z.literal("update_company"),
  name: z.string().optional(),
  tagline: z.string().optional(),
  logo: z.string().optional(),
});

export const SetNavOp = z.object({
  op: z.literal("set_nav"),
  items: z.array(
    z.object({ label: z.string().min(1), pageId: Slug.optional(), href: z.string().optional() }),
  ),
});

export const RecordUnsupportedOp = z.object({
  op: z.literal("record_unsupported"),
  request: z.string().min(1),
  reason: z.string().min(1),
});

export const BlueprintOperation = z.discriminatedUnion("op", [
  AddPageOp,
  RemovePageOp,
  AddSectionOp,
  RemoveSectionOp,
  MoveSectionOp,
  UpdateSectionOp,
  UpdateThemeOp,
  UpdateCompanyOp,
  SetNavOp,
  RecordUnsupportedOp,
]);
export type BlueprintOperation = z.infer<typeof BlueprintOperation>;

export interface ApplyResult {
  blueprint: Blueprint;
  /** Human-readable line per operation, for the change summary and timeline. */
  changes: string[];
  /** Operations that could not be applied, with why. */
  rejected: { operation: BlueprintOperation; reason: string }[];
}

function clone(blueprint: Blueprint): Blueprint {
  return structuredClone(blueprint);
}

function findSection(blueprint: Blueprint, sectionId: string) {
  for (const page of blueprint.pages) {
    const index = page.sections.findIndex((s) => s.id === sectionId);
    if (index !== -1) return { page, index, section: page.sections[index] };
  }
  return null;
}

/** Ensures a proposed id does not collide with an existing page or section. */
function idTaken(blueprint: Blueprint, id: string): boolean {
  return (
    blueprint.pages.some((p) => p.id === id) ||
    blueprint.pages.some((p) => p.sections.some((s) => s.id === id))
  );
}

function labelFor(type: string, source: string, fallback: string): string {
  if (fallback) return fallback;
  if (source === "zm-careers-lib") return getComponent(type)?.name ?? type;
  return getStaticSection(type)?.name ?? type;
}

/**
 * Applies operations in order, returning a new blueprint.
 *
 * Rejected operations do not abort the batch — a request like "add resume
 * upload and make the hero purple" should still recolour the hero if the
 * upload turns out to be unavailable. The rejections are returned so the agent
 * can tell the admin exactly which half did not happen.
 */
export function applyOperations(
  input: Blueprint,
  operations: BlueprintOperation[],
): ApplyResult {
  const blueprint = clone(input);
  const changes: string[] = [];
  const rejected: ApplyResult["rejected"] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case "add_page": {
        if (idTaken(blueprint, operation.id)) {
          rejected.push({ operation, reason: `id "${operation.id}" is already in use` });
          break;
        }
        if (blueprint.pages.some((p) => p.path === operation.path)) {
          rejected.push({ operation, reason: `path "${operation.path}" is already in use` });
          break;
        }
        const page = {
          id: operation.id,
          name: operation.name,
          path: operation.path,
          sections: [],
          seo: { title: operation.name, description: "" },
        };
        const at = operation.afterPageId
          ? blueprint.pages.findIndex((p) => p.id === operation.afterPageId) + 1
          : blueprint.pages.length;
        blueprint.pages.splice(at > 0 ? at : blueprint.pages.length, 0, page);
        changes.push(`Added page "${operation.name}" at ${operation.path}`);
        break;
      }

      case "remove_page": {
        const index = blueprint.pages.findIndex((p) => p.id === operation.pageId);
        if (index === -1) {
          rejected.push({ operation, reason: `no page "${operation.pageId}"` });
          break;
        }
        if (blueprint.pages.length === 1) {
          rejected.push({ operation, reason: "a site must keep at least one page" });
          break;
        }
        const [removed] = blueprint.pages.splice(index, 1);
        blueprint.nav = blueprint.nav.filter((n) => n.pageId !== removed.id);
        changes.push(`Removed page "${removed.name}"`);
        break;
      }

      case "add_section": {
        const page = blueprint.pages.find((p) => p.id === operation.pageId);
        if (!page) {
          rejected.push({ operation, reason: `no page "${operation.pageId}"` });
          break;
        }
        if (idTaken(blueprint, operation.id)) {
          rejected.push({ operation, reason: `id "${operation.id}" is already in use` });
          break;
        }

        // The gate that keeps the agent honest: a functional section must name a
        // component that actually exists and is approved.
        let category: "functional" | "static" | "infrastructure" = "static";
        if (operation.source === "zm-careers-lib") {
          const component = getComponent(operation.type);
          if (!component || component.status !== "approved") {
            rejected.push({
              operation,
              reason: `"${operation.type}" is not an approved component in the registry`,
            });
            break;
          }
          const unknownProps = Object.keys(operation.props).filter((p) => !(p in component.props));
          if (unknownProps.length > 0) {
            rejected.push({
              operation,
              reason: `"${component.name}" does not accept: ${unknownProps.join(", ")}`,
            });
            break;
          }
          category = component.category as typeof category;
        }

        const section = Section.parse({
          id: operation.id,
          type: operation.type,
          category,
          source: operation.source,
          label: labelFor(operation.type, operation.source, operation.label),
          props:
            operation.source === "zm-careers-lib"
              ? { ...(getComponent(operation.type)?.defaults ?? {}), ...operation.props }
              : operation.props,
          content: operation.content,
          visible: true,
          origin: { kind: "agent", ref: "", note: "" },
        });

        const at = operation.index ?? page.sections.length;
        page.sections.splice(Math.min(at, page.sections.length), 0, section);
        changes.push(`Added "${section.label}" to ${page.name}`);
        break;
      }

      case "remove_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        found.page.sections.splice(found.index, 1);
        changes.push(`Removed "${found.section.label}" from ${found.page.name}`);
        break;
      }

      case "move_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        const target = operation.toPageId
          ? blueprint.pages.find((p) => p.id === operation.toPageId)
          : found.page;
        if (!target) {
          rejected.push({ operation, reason: `no page "${operation.toPageId}"` });
          break;
        }

        found.page.sections.splice(found.index, 1);

        let at = target.sections.length;
        if (operation.beforeSectionId) {
          const i = target.sections.findIndex((s) => s.id === operation.beforeSectionId);
          if (i === -1) {
            // Put it back where it came from rather than guessing a position.
            found.page.sections.splice(found.index, 0, found.section);
            rejected.push({ operation, reason: `no section "${operation.beforeSectionId}" to move before` });
            break;
          }
          at = i;
        } else if (operation.afterSectionId) {
          const i = target.sections.findIndex((s) => s.id === operation.afterSectionId);
          if (i === -1) {
            found.page.sections.splice(found.index, 0, found.section);
            rejected.push({ operation, reason: `no section "${operation.afterSectionId}" to move after` });
            break;
          }
          at = i + 1;
        } else if (operation.index !== undefined) {
          at = Math.min(operation.index, target.sections.length);
        }

        target.sections.splice(at, 0, found.section);
        const where =
          target.id === found.page.id ? `within ${target.name}` : `to ${target.name}`;
        changes.push(`Moved "${found.section.label}" ${where}`);
        break;
      }

      case "update_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        const { section } = found;

        if (operation.props) {
          if (section.source === "zm-careers-lib") {
            const component = getComponent(section.type);
            const unknown = Object.keys(operation.props).filter(
              (p) => !component || !(p in component.props),
            );
            if (unknown.length > 0) {
              rejected.push({
                operation,
                reason: `"${section.label}" does not accept: ${unknown.join(", ")}`,
              });
              break;
            }
          }
          for (const [key, value] of Object.entries(operation.props)) {
            if (value === null) delete section.props[key];
            else section.props[key] = value;
          }
        }

        if (operation.content) {
          for (const [key, value] of Object.entries(operation.content)) {
            if (value === null) delete section.content[key];
            else section.content[key] = value;
          }
        }

        if (operation.label !== undefined) section.label = operation.label;
        if (operation.visible !== undefined) section.visible = operation.visible;

        const what = [
          operation.props && "settings",
          operation.content && "content",
          operation.label !== undefined && "label",
          operation.visible !== undefined && (operation.visible ? "shown" : "hidden"),
        ].filter(Boolean);
        changes.push(`Updated ${what.join(" and ")} on "${section.label}"`);
        break;
      }

      case "update_theme": {
        const tokens = blueprint.company.brand.tokens;
        const { colors, ...rest } = operation.tokens as Record<string, unknown> & {
          colors?: Record<string, string>;
        };
        if (colors) Object.assign(tokens.colors, colors);
        Object.assign(tokens, rest);
        const touched = [...Object.keys(colors ?? {}), ...Object.keys(rest)];
        changes.push(`Updated theme: ${touched.join(", ")}`);
        break;
      }

      case "update_company": {
        if (operation.name) blueprint.company.name = operation.name;
        if (operation.tagline !== undefined) blueprint.company.tagline = operation.tagline;
        if (operation.logo !== undefined) blueprint.company.brand.logo = operation.logo;
        changes.push("Updated company details");
        break;
      }

      case "set_nav": {
        const missing = operation.items
          .filter((i) => i.pageId && !blueprint.pages.some((p) => p.id === i.pageId))
          .map((i) => i.pageId);
        if (missing.length > 0) {
          rejected.push({ operation, reason: `nav points at missing pages: ${missing.join(", ")}` });
          break;
        }
        blueprint.nav = operation.items;
        changes.push(`Set navigation to ${operation.items.map((i) => i.label).join(", ")}`);
        break;
      }

      case "record_unsupported": {
        blueprint.unsupportedRequests.push({
          request: operation.request,
          reason: operation.reason,
          requestedAt: new Date().toISOString(),
        });
        changes.push(`Logged an unsupported request: ${operation.request}`);
        break;
      }
    }
  }

  return { blueprint, changes, rejected };
}
