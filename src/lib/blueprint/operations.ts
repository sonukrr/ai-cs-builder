import { z } from "zod";
import {
  type Blueprint,
  DesignTokens,
  LayoutProps,
  MAX_SECTION_DEPTH,
  type Page,
  Section,
  SectionLayout,
  SectionSource,
  Slug,
} from "./schema";
import { getComponent, getLayoutSection, getStaticSection, LAYOUT_SECTIONS } from "@/lib/registry";

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

/**
 * A container id, or "" for the page root.
 *
 * `Slug` rejects the empty string, but "" is the only way an operation can say
 * "take this out of its container and put it back on the page", so it is
 * spelled out as a separate member rather than conflated with omission.
 */
const ParentId = z.union([Slug, z.literal("")]);

export const AddSectionOp = z.object({
  op: z.literal("add_section"),
  pageId: Slug,
  id: Slug,
  type: z.string().min(1),
  source: SectionSource,
  label: z.string().default(""),
  props: z.record(z.string(), z.unknown()).default({}),
  content: z.record(z.string(), z.unknown()).default({}),
  /** Layout container to add this inside. Omitted or "" means the page itself. */
  parentId: ParentId.optional(),
  /** Insert position within that container. Omit to append. */
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
  /** Layout container to move into. "" means the page root. */
  toParentId: ParentId.optional(),
  /**
   * Exactly one of these positioning hints. A sibling id resolves anywhere in
   * the tree and takes the section with it into that sibling's container, so
   * "put it next to the job list" works without also naming the row.
   */
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
  /** Placement inside the parent container. Pass null to clear it. */
  layout: SectionLayout.nullable().optional(),
});

/**
 * Wraps sections that already sit together into a new container.
 *
 * This exists as one operation rather than add_section + N move_sections
 * because the driving example — filters on the left, listing on the right — is
 * a single admin intention, and applying it in pieces means a half-built row
 * shows up in the preview between operations.
 */
export const WrapSectionsOp = z.object({
  op: z.literal("wrap_sections"),
  id: Slug,
  layoutType: z.enum(["row", "stack", "grid"]),
  /** All must currently share a parent. Array order becomes child order. */
  sectionIds: z.array(Slug).min(1),
  props: z.record(z.string(), z.unknown()).default({}),
  label: z.string().default(""),
  /** Per-child placement, keyed by section id. */
  childLayout: z.record(z.string(), SectionLayout).default({}),
});

export const UnwrapSectionOp = z.object({
  op: z.literal("unwrap_section"),
  sectionId: Slug,
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
  WrapSectionsOp,
  UnwrapSectionOp,
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

/** Where a section sits: the array that holds it, and how deep that array is. */
interface SectionSite {
  page: Page;
  /** The page's own `sections`, or a container's `children`. */
  parent: Section[];
  index: number;
  section: Section;
  /** 1 for a section sitting directly on the page. */
  depth: number;
  /** The container holding it, or null at the page root. */
  container: Section | null;
}

function collectSites(
  page: Page,
  parent: Section[],
  depth: number,
  container: Section | null,
  out: SectionSite[],
) {
  for (const [index, section] of parent.entries()) {
    out.push({ page, parent, index, section, depth, container });
    collectSites(page, section.children, depth + 1, section, out);
  }
}

/**
 * Every section on the site, containers before their children.
 *
 * Recomputed per lookup rather than cached: an operation splices sections in
 * and out mid-batch, and a stale `index` here would silently move the wrong
 * one.
 */
function allSites(blueprint: Blueprint): SectionSite[] {
  const out: SectionSite[] = [];
  for (const page of blueprint.pages) collectSites(page, page.sections, 1, null, out);
  return out;
}

function findSection(blueprint: Blueprint, sectionId: string): SectionSite | null {
  return allSites(blueprint).find((site) => site.section.id === sectionId) ?? null;
}

/** A section and everything nested under it. */
function subtree(section: Section): Section[] {
  return [section, ...section.children.flatMap(subtree)];
}

/** 1 for a leaf, 2 for a container of leaves, and so on. */
function subtreeHeight(section: Section): number {
  return 1 + section.children.reduce((tallest, c) => Math.max(tallest, subtreeHeight(c)), 0);
}

/**
 * Ensures a proposed id does not collide with an existing page or section.
 *
 * Section ids are unique per site rather than per page or per container, which
 * is what lets a conversational edit name one section and nothing else.
 */
function idTaken(blueprint: Blueprint, id: string): boolean {
  return (
    blueprint.pages.some((p) => p.id === id) ||
    allSites(blueprint).some((site) => site.section.id === id)
  );
}

function labelFor(type: string, source: string, fallback: string): string {
  if (fallback) return fallback;
  if (source === "zm-careers-lib") return getComponent(type)?.name ?? type;
  if (source === "layout") return getLayoutSection(type)?.name ?? type;
  return getStaticSection(type)?.name ?? type;
}

const LAYOUT_IDS = LAYOUT_SECTIONS.map((s) => s.id);
const LAYOUT_LIST = LAYOUT_IDS.join(", ");
const LAYOUT_CHOICE = `${LAYOUT_IDS.slice(0, -1).join(", ")} or ${LAYOUT_IDS[LAYOUT_IDS.length - 1]}`;
const LAYOUT_PROP_NAMES = Object.keys(LayoutProps.shape).join(", ");

/**
 * The third validation case.
 *
 * A container never touches the component registry — there is no `zm-careers-lib`
 * entry for a flexbox — so its props are checked against LayoutProps instead.
 * Unknown keys are rejected rather than stripped for the same reason unknown
 * component props are: silently dropping a setting the admin asked for reads as
 * the edit having worked.
 */
function layoutPropsProblem(props: Record<string, unknown>): string | null {
  const unknown = Object.keys(props).filter((p) => !(p in LayoutProps.shape));
  if (unknown.length > 0) {
    return `a layout container does not accept: ${unknown.join(", ")} — the settings it has are ${LAYOUT_PROP_NAMES}`;
  }
  // Nulls are the documented way to clear a prop, so they are not values to check.
  const settable = Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== null),
  );
  const parsed = LayoutProps.partial().safeParse(settable);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`);
    return `layout settings are out of range: ${bad.join("; ")}`;
  }
  return null;
}

function tooDeep(depth: number, height: number): boolean {
  return depth + height - 1 > MAX_SECTION_DEPTH;
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

        // Where it lands: a container's children, or the page itself.
        let parent = page.sections;
        let container: Section | null = null;
        if (operation.parentId) {
          const site = findSection(blueprint, operation.parentId);
          if (!site) {
            rejected.push({
              operation,
              reason: `no section "${operation.parentId}" to put this inside — omit parentId to add it straight to the page`,
            });
            break;
          }
          if (site.section.source !== "layout") {
            rejected.push({
              operation,
              reason: `"${site.section.label}" is not a layout container — wrap_sections it into a ${LAYOUT_CHOICE} first`,
            });
            break;
          }
          if (site.page.id !== page.id) {
            rejected.push({
              operation,
              reason: `"${operation.parentId}" is on ${site.page.name}, not ${page.name} — set pageId to "${site.page.id}"`,
            });
            break;
          }
          if (tooDeep(site.depth + 1, 1)) {
            rejected.push({
              operation,
              reason: `"${site.section.label}" is already ${MAX_SECTION_DEPTH} levels deep — unwrap_section one of its containers first`,
            });
            break;
          }
          parent = site.section.children;
          container = site.section;
        }

        // The gate that keeps the agent honest: a functional section must name a
        // component that actually exists and is approved.
        let category: "functional" | "static" | "infrastructure" | "layout" = "static";
        let props = operation.props;
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
          props = { ...component.defaults, ...operation.props };
        } else if (operation.source === "layout") {
          const def = getLayoutSection(operation.type);
          if (!def) {
            rejected.push({
              operation,
              reason: `"${operation.type}" is not a layout container — use one of ${LAYOUT_LIST}`,
            });
            break;
          }
          const problem = layoutPropsProblem(operation.props);
          if (problem) {
            rejected.push({ operation, reason: problem });
            break;
          }
          category = "layout";
          // Stored fully resolved so all three renderers read the same numbers
          // rather than each reapplying defaults their own way.
          props = LayoutProps.parse({ ...def.defaults, ...operation.props });
        }

        const section = Section.parse({
          id: operation.id,
          type: operation.type,
          category,
          source: operation.source,
          label: labelFor(operation.type, operation.source, operation.label),
          props,
          content: operation.content,
          visible: true,
          children: [],
          origin: { kind: "agent", ref: "", note: "" },
        });

        const at = operation.index ?? parent.length;
        parent.splice(Math.min(at, parent.length), 0, section);
        changes.push(
          container
            ? `Added "${section.label}" inside "${container.label}"`
            : `Added "${section.label}" to ${page.name}`,
        );
        break;
      }

      case "remove_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        found.parent.splice(found.index, 1);
        const alsoGone = subtree(found.section).length - 1;
        changes.push(
          alsoGone > 0
            ? `Removed "${found.section.label}" from ${found.page.name}, along with the ${alsoGone} section${alsoGone === 1 ? "" : "s"} inside it`
            : `Removed "${found.section.label}" from ${found.page.name}`,
        );
        break;
      }

      case "move_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        // The destination is resolved in full before anything is spliced. A tree
        // move has enough ways to fail — missing anchor, cycle, depth — that the
        // old remove-then-put-it-back-on-rejection dance stopped being readable.
        let targetPage = found.page;
        let targetParent = found.parent;
        let targetContainer = found.container;
        let targetDepth = found.depth;
        let at: number | null = null;
        // An anchor's index is read while the section is still in the tree, so
        // it needs correcting after the splice-out; an explicit `index` has
        // always meant a position in the array as it ends up, and still does.
        let atIsPreRemoval = false;

        const anchorId = operation.beforeSectionId ?? operation.afterSectionId;
        if (anchorId) {
          // A sibling hint wins over toParentId: naming a neighbour names a
          // position, and the position already implies which container it is in.
          const anchor = findSection(blueprint, anchorId);
          if (!anchor) {
            rejected.push({
              operation,
              reason: `no section "${anchorId}" to move ${operation.beforeSectionId ? "before" : "after"} — name a section that exists, or use toParentId and index`,
            });
            break;
          }
          targetPage = anchor.page;
          targetParent = anchor.parent;
          targetContainer = anchor.container;
          targetDepth = anchor.depth;
          at = operation.beforeSectionId ? anchor.index : anchor.index + 1;
          atIsPreRemoval = true;
        } else if (operation.toParentId) {
          const site = findSection(blueprint, operation.toParentId);
          if (!site) {
            rejected.push({
              operation,
              reason: `no section "${operation.toParentId}" to move into — pass "" as toParentId to move it out to the page`,
            });
            break;
          }
          if (site.section.source !== "layout") {
            rejected.push({
              operation,
              reason: `"${site.section.label}" is not a layout container — wrap_sections it into a ${LAYOUT_CHOICE} first`,
            });
            break;
          }
          targetPage = site.page;
          targetParent = site.section.children;
          targetContainer = site.section;
          targetDepth = site.depth + 1;
        } else if (operation.toParentId === "" || operation.toPageId) {
          const target = operation.toPageId
            ? blueprint.pages.find((p) => p.id === operation.toPageId)
            : found.page;
          if (!target) {
            rejected.push({ operation, reason: `no page "${operation.toPageId}"` });
            break;
          }
          targetPage = target;
          targetParent = target.sections;
          targetContainer = null;
          targetDepth = 1;
        }
        if (at === null && operation.index !== undefined) at = operation.index;

        // A container cannot become its own descendant; the section would
        // vanish from the tree along with everything under it.
        const moving = subtree(found.section).map((sec) => sec.id);
        if (targetContainer && moving.includes(targetContainer.id)) {
          rejected.push({
            operation,
            reason: `"${found.section.label}" cannot go inside itself — move "${targetContainer.label}" out first, or move the other section instead`,
          });
          break;
        }
        if (tooDeep(targetDepth, subtreeHeight(found.section))) {
          rejected.push({
            operation,
            reason: `"${found.section.label}" would nest past the ${MAX_SECTION_DEPTH}-level limit there — unwrap_section a container on the way down first`,
          });
          break;
        }

        const sameParent = targetParent === found.parent;
        found.parent.splice(found.index, 1);
        let insertAt = at ?? targetParent.length;
        // Pulling it out of the array it is going back into shifted every
        // position after it left by one.
        if (atIsPreRemoval && sameParent && found.index < insertAt) insertAt -= 1;
        targetParent.splice(Math.max(0, Math.min(insertAt, targetParent.length)), 0, found.section);

        const where = targetContainer
          ? `into "${targetContainer.label}"`
          : targetPage.id === found.page.id
            ? `within ${targetPage.name}`
            : `to ${targetPage.name}`;
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
          } else if (section.source === "layout") {
            const problem = layoutPropsProblem(operation.props);
            if (problem) {
              rejected.push({ operation, reason: problem });
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
        if (operation.layout !== undefined) {
          if (operation.layout === null) delete section.layout;
          else section.layout = operation.layout;
        }

        const what = [
          operation.props && "settings",
          operation.content && "content",
          operation.label !== undefined && "label",
          operation.layout !== undefined && "placement",
          operation.visible !== undefined && (operation.visible ? "shown" : "hidden"),
        ].filter(Boolean);
        changes.push(`Updated ${what.join(" and ")} on "${section.label}"`);
        break;
      }

      case "wrap_sections": {
        if (idTaken(blueprint, operation.id)) {
          rejected.push({ operation, reason: `id "${operation.id}" is already in use` });
          break;
        }
        const def = getLayoutSection(operation.layoutType);
        if (!def) {
          rejected.push({
            operation,
            reason: `"${operation.layoutType}" is not a layout container — use one of ${LAYOUT_LIST}`,
          });
          break;
        }
        const problem = layoutPropsProblem(operation.props);
        if (problem) {
          rejected.push({ operation, reason: problem });
          break;
        }

        const wrapped: SectionSite[] = [];
        const missing: string[] = [];
        for (const id of operation.sectionIds) {
          const site = findSection(blueprint, id);
          if (site) wrapped.push(site);
          else missing.push(id);
        }
        if (missing.length > 0) {
          rejected.push({
            operation,
            reason: `no section${missing.length === 1 ? "" : "s"} ${missing.map((id) => `"${id}"`).join(", ")} — list ids that exist`,
          });
          break;
        }
        if (new Set(operation.sectionIds).size !== operation.sectionIds.length) {
          rejected.push({
            operation,
            reason: "sectionIds lists the same section twice — each section can only sit in one place",
          });
          break;
        }

        // Wrapping is a reparent, not a move: everything has to already be
        // side by side, or the container would silently pull sections out of
        // wherever else they were and reorder the page around them.
        const home = wrapped[0];
        const strays = wrapped
          .filter((site) => site.parent !== home.parent)
          .map((site) => site.section.id);
        if (strays.length > 0) {
          rejected.push({
            operation,
            reason: `${strays.map((id) => `"${id}"`).join(", ")} ${strays.length === 1 ? "does" : "do"} not sit alongside "${home.section.id}" — move_section them into the same place first`,
          });
          break;
        }
        const tallest = Math.max(...wrapped.map((site) => subtreeHeight(site.section)));
        if (tooDeep(home.depth + 1, tallest)) {
          rejected.push({
            operation,
            reason: `a container here would nest past the ${MAX_SECTION_DEPTH}-level limit — unwrap_section one of the containers being wrapped first`,
          });
          break;
        }
        const unplaceable = Object.keys(operation.childLayout).filter(
          (id) => !operation.sectionIds.includes(id),
        );
        if (unplaceable.length > 0) {
          rejected.push({
            operation,
            reason: `childLayout names sections that are not being wrapped: ${unplaceable.join(", ")} — add them to sectionIds`,
          });
          break;
        }

        const container = Section.parse({
          id: operation.id,
          type: operation.layoutType,
          category: "layout",
          source: "layout",
          label: operation.label || def.name,
          props: LayoutProps.parse({ ...def.defaults, ...operation.props }),
          content: {},
          visible: true,
          children: [],
          origin: { kind: "agent", ref: "", note: "" },
        });

        // The container takes the earliest position the group occupied, so the
        // row shows up where the admin was already looking.
        const at = Math.min(...wrapped.map((site) => site.index));
        // Back to front, so the indices ahead of each splice stay valid.
        for (const site of [...wrapped].sort((a, b) => b.index - a.index)) {
          site.parent.splice(site.index, 1);
        }
        // Child order follows sectionIds rather than document order: the order
        // of that array is how the agent says which one is on the left.
        container.children = wrapped.map((site) => {
          const placement = operation.childLayout[site.section.id];
          if (placement) site.section.layout = placement;
          return site.section;
        });
        home.parent.splice(Math.min(at, home.parent.length), 0, container);

        changes.push(
          `Wrapped ${wrapped.map((site) => `"${site.section.label}"`).join(", ")} in a ${def.name.toLowerCase()} — "${container.label}"`,
        );
        break;
      }

      case "unwrap_section": {
        const found = findSection(blueprint, operation.sectionId);
        if (!found) {
          rejected.push({ operation, reason: `no section "${operation.sectionId}"` });
          break;
        }
        if (found.section.source !== "layout") {
          rejected.push({
            operation,
            reason: `"${found.section.label}" is not a layout container — use remove_section to delete a section`,
          });
          break;
        }
        const freed = found.section.children;
        found.parent.splice(found.index, 1, ...freed);
        changes.push(
          freed.length > 0
            ? `Dissolved "${found.section.label}", leaving its ${freed.length} section${freed.length === 1 ? "" : "s"} in its place`
            : `Removed the empty "${found.section.label}" container`,
        );
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
