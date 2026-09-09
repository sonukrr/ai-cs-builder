import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { catalog, getComponent, STATIC_SECTIONS, searchRegistry } from "@/lib/registry";
import { applyOperations, BlueprintOperation } from "@/lib/blueprint/operations";
import { isBuildable, validateBlueprint } from "@/lib/blueprint/validate";
import { store } from "@/lib/store/store";
import { getFigmaProvider, parseFigmaUrl } from "@/lib/providers/figma";
import { summarizeDesign } from "@/lib/providers/figma/summarize";
import { analyzeDesign, planToBlueprint } from "./analyze";
import {
  baseSiteRepo,
  getBaseSiteProvider,
  isWritable,
  PROTECTED_BRANCHES,
} from "@/lib/providers/github";
import { buildImageTools } from "./image-tools";
import { buildDatasetTools } from "./dataset-tools";
import { buildFidelityTools } from "./fidelity-tools";
import { buildDesignTools } from "./design-tools";
import type { Blueprint, Section } from "@/lib/blueprint/schema";

/**
 * The agent's tools.
 *
 * Built per request so each closure carries the project it is acting on — the
 * model never passes a project id around, and so cannot act on someone else's
 * project by hallucinating one.
 *
 * Every tool returns a string. Tool results are the model's only view of what
 * actually happened, so they are written to be precise about failure: a
 * rejected operation comes back naming the operation and the reason, which is
 * what lets the agent correct itself instead of asserting success.
 */

export interface ToolContext {
  projectId: string;
  /** Called for each tool invocation so the UI can show an activity timeline. */
  onActivity: (tool: string, summary: string) => void;
}

/** Complex, per-component shapes travel as JSON strings; see analyze.ts. */
const JSON_NOTE = "a JSON string";

/** Mirrors the LayoutProps defaults, so only configured values are printed. */
const LAYOUT_DEFAULTS: Record<string, unknown> = {
  direction: "column",
  columns: 2,
  gap: 24,
  align: "stretch",
  justify: "start",
  wrap: true,
  padding: 0,
  maxWidth: 0,
  background: "",
  stackBelow: 720,
  reverseOnMobile: false,
};

/** Blueprints stored before layout containers existed have no `children` key. */
function childrenOf(section: Section): Section[] {
  return section.source === "layout" ? section.children ?? [] : [];
}

function countSections(sections: Section[]): number {
  return sections.reduce((total, section) => total + 1 + countSections(childrenOf(section)), 0);
}

/** "row · gap 32 · align start · 2 children" — what the container is and how it is set up. */
function describeContainer(section: Section): string {
  const props = section.props as Record<string, unknown>;
  const direction = typeof props.direction === "string" ? props.direction : "column";
  const parts: string[] = [direction === "grid" ? `grid ${props.columns ?? LAYOUT_DEFAULTS.columns} columns` : direction];

  parts.push(`gap ${props.gap ?? LAYOUT_DEFAULTS.gap}`);
  for (const key of ["align", "justify", "wrap", "padding", "maxWidth", "background", "stackBelow", "reverseOnMobile"]) {
    const value = props[key];
    if (value === undefined || value === LAYOUT_DEFAULTS[key]) continue;
    parts.push(`${key} ${value}`);
  }

  const count = childrenOf(section).length;
  parts.push(count === 0 ? "EMPTY — nothing inside it" : count === 1 ? "1 child" : `${count} children`);
  return parts.join(" · ");
}

/** How a section sits in its parent — blank when it takes the container's default. */
function describePlacement(section: Section): string {
  const layout = section.layout as Record<string, unknown> | undefined | null;
  if (!layout) return "";
  const parts = (["basis", "grow", "span", "align", "order"] as const)
    .filter((key) => layout[key] !== undefined)
    .map((key) => `${key === "align" ? "align-self" : key} ${layout[key]}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * Sections nest, and this listing is the agent's only view of the structure. An
 * ambiguous one is why an agent invents section ids or wraps the wrong things:
 * every line therefore carries its index within its own parent, containers say
 * what they are and how they are configured, and children say how they sit
 * inside the container above them.
 */
function describeSectionTree(sections: Section[], includeContent: boolean, depth = 0, path = ""): string[] {
  const lines: string[] = [];
  const pad = "    " + "  ".repeat(depth);

  sections.forEach((section, index) => {
    const position = `${path}${index}`;
    const isContainer = section.source === "layout";
    // A container is described twice over: what it arranges, and — since
    // containers nest — how it is itself placed in the container above it.
    const suffix = isContainer
      ? ` · ${describeContainer(section)}${describePlacement(section)}`
      : describePlacement(section);
    lines.push(
      `${pad}${position}. ${section.id} — "${section.label}" [${section.type}, ${section.source}]${section.visible ? "" : " (hidden)"}${suffix}`,
    );

    if (includeContent && !isContainer) {
      if (Object.keys(section.props).length > 0) lines.push(`${pad}   settings: ${JSON.stringify(section.props)}`);
      if (Object.keys(section.content).length > 0) {
        lines.push(`${pad}   content: ${JSON.stringify(section.content).slice(0, 600)}`);
      }
    }

    lines.push(...describeSectionTree(childrenOf(section), includeContent, depth + 1, `${position}.`));
  });

  return lines;
}

export function buildTools(context: ToolContext) {
  const { projectId, onActivity } = context;

  const requireBlueprint = async (): Promise<Blueprint> => {
    const blueprint = await store.getCurrentBlueprint(projectId);
    if (!blueprint) {
      throw new Error(
        "This project has no site blueprint yet. Import a Figma design or start from the base site first.",
      );
    }
    return blueprint;
  };

  const searchComponents = betaZodTool({
    name: "search_components",
    description:
      "Search the approved functional component catalog. Use this before claiming any career capability exists. Returns friendly names, what each can do, and the settings it accepts.",
    inputSchema: z.object({
      query: z.string().describe("what the admin asked for, e.g. 'upload a CV' or 'filter by city'"),
    }),
    run: async ({ query }) => {
      onActivity("search_components", `Searched the component catalog for “${query}”`);
      const hits = searchRegistry(query);
      if (hits.length === 0) {
        return `No approved component matches "${query}". The full catalog is: ${catalog().map((c) => `${c.id} (${c.name})`).join(", ")}. If nothing fits, this capability is not supported — record it with apply_operations using a record_unsupported operation rather than inventing it.`;
      }
      return hits
        .map(
          (c) =>
            `${c.id} — "${c.name}": ${c.blurb}\n  can: ${c.capabilities.join(", ")}\n  settings: ${Object.keys(c.props).join(", ") || "none"}`,
        )
        .join("\n\n");
    },
  });

  const describeComponent = betaZodTool({
    name: "describe_component",
    description:
      "Full detail for one approved component: every setting it accepts, what each does, and its defaults. Call this before setting any props.",
    inputSchema: z.object({ id: z.string().describe("registry component id, e.g. 'job-search'") }),
    run: async ({ id }) => {
      onActivity("describe_component", `Read the specification for ${id}`);
      const component = getComponent(id);
      if (!component) {
        const staticDef = STATIC_SECTIONS.find((s) => s.id === id);
        if (staticDef) {
          return `${staticDef.id} — "${staticDef.name}" (static section, content only)\n${staticDef.blurb}\ncontent keys:\n${Object.entries(
            staticDef.contentKeys,
          )
            .map(([key, description]) => `  ${key}: ${description}`)
            .join("\n")}`;
        }
        return `No component or section "${id}".`;
      }
      const props = Object.entries(component.props)
        .map(([name, meta]) => `  ${name}${meta.description ? ` — ${meta.description}` : " — (undocumented; set only if you are confident)"}`)
        .join("\n");
      return [
        `${component.id} — "${component.name}" (${component.status})`,
        component.blurb,
        `can: ${component.capabilities.join(", ")}`,
        `settings:\n${props || "  none"}`,
        `defaults: ${JSON.stringify(component.defaults)}`,
      ].join("\n");
    },
  });

  const listSections = betaZodTool({
    name: "list_static_sections",
    description:
      "List the static presentation sections the renderer supports. These carry content only and never provide functional behaviour. " +
      "They are fixed shapes, so use one only when the band really is that shape. A band whose arrangement none of them describes is a \"custom-html\" section instead: add it with apply_operations, read the design with describe_design_node, and author it with set_custom_html. Bending a bespoke band into the nearest listed type is how a design stops looking like the design.",
    inputSchema: z.object({}),
    run: async () => {
      onActivity("list_static_sections", "Listed the available presentation sections");
      return STATIC_SECTIONS.map((s) => `${s.id} — "${s.name}": ${s.blurb}`).join("\n");
    },
  });

  const getBlueprint = betaZodTool({
    name: "get_blueprint",
    description:
      "Read the current site blueprint: pages, the section tree on each, their ids, and the theme. Sections nest — a section with source \"layout\" is a container printed with its arrangement, and the sections indented under it are its children, each shown with how it sits in that container. Call this before any edit so you reference real section ids and real containers.",
    inputSchema: z.object({
      includeContent: z
        .boolean()
        .optional()
        .describe("include each section's copy and settings; default false"),
    }),
    run: async ({ includeContent }) => {
      onActivity("get_blueprint", "Read the current site structure");
      const blueprint = await requireBlueprint();

      const pages = blueprint.pages
        .map((page) => {
          const sections = describeSectionTree(page.sections, includeContent ?? false).join("\n");
          return `  ${page.id} — "${page.name}" at ${page.path}\n${sections || "    (no sections)"}`;
        })
        .join("\n");

      const tokens = blueprint.company.brand.tokens;
      return [
        `Company: ${blueprint.company.name} — ${blueprint.company.tagline}`,
        `Version: ${blueprint.version}`,
        `Theme: primary ${tokens.colors.primary}, secondary ${tokens.colors.secondary}, background ${tokens.colors.background}, text ${tokens.colors.text}, heading font ${tokens.fonts.heading}, radius ${tokens.radius}, buttons ${tokens.buttonStyle}`,
        `Navigation: ${blueprint.nav.map((n) => n.label).join(", ") || "(none)"}`,
        `Pages (a section indented under a layout container is inside it; the number is its position within its own parent):\n${pages}`,
        blueprint.unsupportedRequests.length > 0
          ? `Previously requested but unsupported: ${blueprint.unsupportedRequests.map((u) => u.request).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const applyOps = betaZodTool({
    name: "apply_operations",
    description:
      "Apply structured edits to the site blueprint and save a new version. This is the ONLY way to change the site. Operations are applied in order; ones that fail validation are rejected individually and reported back to you.",
    inputSchema: z.object({
      operationsJson: z
        .string()
        .describe(
          `${JSON_NOTE} containing an array of operations. Sections nest: a section with source "layout" is a container that holds children and arranges them as a row, stack or grid; every other section is a leaf. Each operation is one of: ` +
            `{"op":"add_page","id","name","path"} · {"op":"remove_page","pageId"} · ` +
            `{"op":"add_section","pageId","id","type","source":"zm-careers-lib"|"custom"|"layout","label","props":{},"content":{},"parentId"?,"index"?} — parentId puts the new section inside that layout container; omit it or pass "" for the page root. Rejected if parentId names a section that is not a layout container, or if the nesting would go deeper than 4. For source "layout", type is "row" | "stack" | "grid" and props are the layout props below, not component props. · ` +
            `{"op":"remove_section","sectionId"} — removing a layout container removes everything inside it · ` +
            `{"op":"move_section","sectionId","toPageId"?,"toParentId"?,"beforeSectionId"?|"afterSectionId"?|"index"?} — toParentId moves the section into that layout container; "" means the page root. beforeSectionId/afterSectionId resolve anywhere in the tree and land the section beside that sibling, inside whatever container the sibling is in. Rejected if it would put a container inside its own subtree or nest deeper than 4. · ` +
            `{"op":"update_section","sectionId","props"?,"content"?,"label"?,"visible"?,"layout"?} — layout sets how THIS section sits inside its parent: {"span"?,"grow"?,"basis"?,"align"?,"order"?}, or null to clear it. On a layout container, props are layout props. · ` +
            `{"op":"wrap_sections","id","layoutType":"row"|"stack"|"grid","sectionIds":[...],"label"?,"props"?,"childLayout"?} — the one-step way to rearrange existing sections: creates a container with id at the position of the earliest listed section and moves those sections into it in the order given by sectionIds, so that array order is left-to-right in a row. All listed sections must already share the same parent; otherwise the operation is rejected naming the offenders. childLayout maps each sectionId to that child's layout. · ` +
            `{"op":"unwrap_section","sectionId"} — dissolves a layout container, leaving its children in its place in the parent. Rejected if the section is not a layout container. · ` +
            `{"op":"update_theme","tokens":{"colors":{...},"radius"?,"buttonStyle"?,...}} · ` +
            `{"op":"update_company","name"?,"tagline"?,"logo"?} · ` +
            `{"op":"set_nav","items":[{"label","pageId"}]} · ` +
            `{"op":"record_unsupported","request","reason"}` +
            `\nLayout props, with their defaults: direction "column"|"row"|"grid" ("column"), columns 1-12 (2, grid only), gap 0-96 (24), align "start"|"center"|"end"|"stretch" ("stretch"), justify "start"|"center"|"end"|"space-between"|"space-around" ("start"), wrap true (row only), padding 0-160 (0), maxWidth 0-2560 (0 = full bleed), background hex or "" (""), stackBelow 0-1600 (720 — below this viewport width a row or grid collapses to one column; 0 = never), reverseOnMobile false.` +
            `\nChild layout: span 1-12 (grid column span), grow 0-12 (share of the leftover space in a row), basis e.g. "300px" or "40%", align, order. In a row, a child with basis and no grow is a fixed-width sidebar, and a child with grow 1 takes the rest; a child that sets neither shares the row equally.` +
            `\nWorked example — put the facet filter on the left and the job list on the right, in one row: ` +
            `[{"op":"wrap_sections","id":"jobs-row","layoutType":"row","label":"Jobs","sectionIds":["job-filters","job-listing"],"props":{"gap":32,"align":"start","maxWidth":1200,"padding":24},"childLayout":{"job-filters":{"basis":"300px"},"job-listing":{"grow":1}}}]` +
            `\nWHAT A BAND OF A DESIGN SHOULD BECOME — decide in this order, and stop at the first that fits. (1) FUNCTIONAL — search, filtering, listings, pagination, apply, resume upload: an approved component, source "zm-careers-lib", found with search_components. Never hand-write one. (2) A WRAPPER — a band that only holds the bands below it, e.g. a frame named "Container" 820px tall: source "layout", type row/stack/grid. (3) PRESENTATION with no behaviour that no static type describes — a bespoke hero, a stats strip, an editorial block, an unusual footer: source "custom", type "custom-html", then describe_design_node and set_custom_html to author the replica. Use a fixed static type (hero, benefits, faq…) only when the band genuinely is that shape. (4) NOTHING — a zero-height frame, an empty or hidden node, or a duplicate of something already built: record_unsupported and move on. Manufacturing copy to fill a band that carries nothing is worse than leaving it out.`,
        ),
      summary: z
        .string()
        .describe("one sentence describing the change, shown to the admin as the version summary"),
    }),
    run: async ({ operationsJson, summary }) => {
      const blueprint = await requireBlueprint();

      let raw: unknown;
      try {
        raw = JSON.parse(operationsJson);
      } catch (error) {
        return `operationsJson was not valid JSON: ${error instanceof Error ? error.message : error}. Send a JSON array of operation objects.`;
      }
      if (!Array.isArray(raw)) return "operationsJson must be a JSON array of operations.";

      const parsed: BlueprintOperation[] = [];
      const malformed: string[] = [];
      for (const [index, candidate] of raw.entries()) {
        const result = BlueprintOperation.safeParse(candidate);
        if (result.success) parsed.push(result.data);
        else {
          malformed.push(
            `operation ${index} (${(candidate as { op?: string })?.op ?? "unknown"}): ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          );
        }
      }
      if (parsed.length === 0) {
        return `No operation was well-formed.\n${malformed.join("\n")}`;
      }

      const result = applyOperations(blueprint, parsed);

      // Validation runs before the version is saved, so a broken blueprint is
      // never committed and never rendered.
      const issues = validateBlueprint(result.blueprint);
      if (!isBuildable(issues)) {
        return [
          "The change was NOT saved — the resulting site would not be valid:",
          ...issues.filter((i) => i.level === "error").map((i) => `  ${i.path}: ${i.message}`),
          "Fix these and call apply_operations again.",
        ].join("\n");
      }

      const version = await store.saveVersion(projectId, {
        blueprint: result.blueprint,
        summary,
        operations: parsed as unknown as Record<string, unknown>[],
      });

      onActivity("apply_operations", `${summary} (saved as version ${version.version})`);

      const warnings = issues.filter((i) => i.level === "warning");
      return [
        `Saved as version ${version.version}.`,
        result.changes.length > 0 ? `Applied:\n${result.changes.map((c) => `  - ${c}`).join("\n")}` : null,
        result.rejected.length > 0
          ? `REJECTED — tell the admin about these:\n${result.rejected.map((r) => `  - ${r.operation.op}: ${r.reason}`).join("\n")}`
          : null,
        malformed.length > 0 ? `MALFORMED (ignored):\n${malformed.map((m) => `  - ${m}`).join("\n")}` : null,
        warnings.length > 0 ? `Warnings:\n${warnings.map((w) => `  - ${w.message}`).join("\n")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const importFigma = betaZodTool({
    name: "import_figma",
    description:
      "Import a Figma design: fetch it, analyse each band semantically, map functional bands to approved components, and produce a site plan for the admin to approve. Use when the admin supplies a Figma link.",
    inputSchema: z.object({
      figmaUrl: z.string().describe("a Figma file URL, or a bare file key"),
      nodeId: z.string().optional().describe("optional node id to scope the import to one frame"),
    }),
    run: async ({ figmaUrl, nodeId }) => {
      const parsed = parseFigmaUrl(figmaUrl);
      if (!parsed) {
        return `"${figmaUrl}" is not a Figma file URL or key. Expected something like https://www.figma.com/design/<key>/<name>.`;
      }

      onActivity("import_figma", `Fetching the Figma design ${parsed.fileKey}`);
      const provider = getFigmaProvider();
      // Passing the project id is what makes the rendered frame PNGs persist:
      // the backends put them through the asset store instead of leaving
      // Figma's signed URLs, which expire long before anyone reviews them.
      const design = await provider.fetchDesign(parsed.fileKey, nodeId ?? parsed.nodeId, projectId);

      onActivity("import_figma", `Analysing ${design.frames.length} frame(s) from “${design.fileName}”`);
      const { plan, dropped, notes } = await analyzeDesign(design);

      await store.savePlan(projectId, plan, {
        backend: design.backend,
        fileName: design.fileName,
        dropped,
        // The importer's own notes belong beside the backend's: from the
        // admin's side both are "things to know about this import".
        warnings: [...design.warnings, ...notes],
        // The fidelity review compares the built site back against the design,
        // so the design has to survive past this request. Band heights and the
        // rendered frame images live only on the DesignDocument, which is not
        // persisted anywhere else — without them the review can still check
        // coverage and tokens, but it has no reference image to show.
        designSummary: summarizeDesign(design),
        designStyles: design.styles,
        designImages: design.images,
      });
      // The summary above deliberately has no geometry, so it cannot drive a
      // replica. describe_design_node reads the document itself for that.
      await store.saveDesign(projectId, design);
      await store.updateProject(projectId, { sourceRef: parsed.fileKey, entryPoint: "figma" });

      const pages = plan.pages
        .map(
          (page) =>
            `  ${page.name} (${page.path})\n${page.sections
              .map(
                (s) =>
                  `    - ${s.label} [${s.source === "zm-careers-lib" ? "approved component" : "content section"}, ${Math.round(s.confidence * 100)}% confident] — ${s.rationale}`,
              )
              .join("\n")}`,
        )
        .join("\n");

      return [
        `Imported "${design.fileName}" via the ${design.backend} backend.`,
        `Proposed site plan (NOT yet applied — the admin approves it on the plan screen):`,
        pages,
        `Theme: primary ${plan.tokens.primary}, accent ${plan.tokens.accent}, heading font ${plan.tokens.headingFont}`,
        plan.unsupported.length > 0
          ? `Design implies unsupported functionality: ${plan.unsupported.map((u) => `${u.request} (${u.reason})`).join("; ")}`
          : null,
        dropped.length > 0 ? `Dropped during validation: ${dropped.map((d) => `${d.section} — ${d.reason}`).join("; ")}` : null,
        plan.assumptions.length > 0 ? `Assumptions to check: ${plan.assumptions.join("; ")}` : null,
        design.warnings.length > 0 ? `Import warnings: ${design.warnings.join("; ")}` : null,
        `Tell the admin what you found and point them at the plan screen to approve it.`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const approvePlan = betaZodTool({
    name: "approve_plan",
    description:
      "Turn the pending site plan into the project's first site blueprint. Only call this when the admin has explicitly approved the plan. For an imported design this does not open the studio: the project moves to design fidelity review, where the built site is compared against the Figma design and an administrator has to approve the result.",
    inputSchema: z.object({}),
    run: async () => {
      const pending = await store.getPlan(projectId);
      if (!pending) return "There is no pending site plan for this project.";

      const blueprint = planToBlueprint(pending.plan, projectId);
      const issues = validateBlueprint(blueprint);
      if (!isBuildable(issues)) {
        return `The plan does not validate: ${issues.filter((i) => i.level === "error").map((i) => i.message).join("; ")}`;
      }

      const version = await store.saveVersion(projectId, {
        blueprint,
        summary: `Created the site from the imported design`,
        operations: [{ op: "approve_plan" }],
      });

      // Only an imported design can be reviewed against anything. A base-site
      // project has no design behind it, so sending it to "reviewing" would
      // park it behind a gate that can never be passed.
      const project = await store.getProject(projectId);
      const reviewable = project?.entryPoint === "figma";
      await store.updateProject(projectId, { status: reviewable ? "reviewing" : "ready" });

      const built = `Built version ${version.version}: ${blueprint.pages.length} page(s), ${blueprint.pages.reduce((n, p) => n + countSections(p.sections), 0)} sections.`;

      onActivity(
        "approve_plan",
        reviewable
          ? `Built the site from the approved plan (version ${version.version}) — awaiting design fidelity review`
          : `Built the site from the approved plan (version ${version.version})`,
      );

      if (!reviewable) return `${built} The preview is live.`;

      return [
        built,
        "The preview is live, but the project is now in DESIGN FIDELITY REVIEW rather than ready: the studio stays closed until an administrator approves the comparison between the Figma design and what was built.",
        "Run review_fidelity now, tell the administrator what it found — anything missing or extra is worth fixing before they look — and then ask them to open the fidelity review screen and approve it. You cannot approve it yourself.",
      ].join("\n");
    },
  });

  const readBaseSite = betaZodTool({
    name: "read_base_site",
    description:
      "Read the approved base career-site repository: its structure, documentation, reusable components and configuration. Use before customising from the base.",
    inputSchema: z.object({
      repo: z.string().optional().describe("owner/name or GitHub URL; defaults to the configured base repo"),
    }),
    run: async ({ repo }) => {
      const target = repo || baseSiteRepo();
      const provider = getBaseSiteProvider();

      if (!target && provider.backend !== "mock") {
        return "No base repository has been configured yet (BASE_SITE_REPO is unset) and none was supplied. Ask the admin for the approved base repository link.";
      }

      onActivity("read_base_site", `Read the base career site ${target || "(stand-in)"}`);
      const site = await provider.readContext(target);

      return [
        `Base site: ${site.repo} — ${site.framework}, default branch ${site.defaultBranch}`,
        `Routes: ${site.pages.map((p) => `${p.path} (${p.name})`).join(", ") || "none discovered"}`,
        `Reusable components: ${site.components.map((c) => c.name).join(", ") || "none discovered"}`,
        `Configuration you may change: ${site.config.map((c) => c.path).join(", ") || "none — you will create it on the company branch"}`,
        site.config.length > 0
          ? `Current configuration:\n${site.config.map((c) => `--- ${c.path}\n${c.content.slice(0, 1200)}`).join("\n")}`
          : "",
        site.keyFiles.length > 0
          ? `How the app is wired (READ ONLY — never write to these):\n${site.keyFiles
              .map((f) => `--- ${f.path}\n${f.content.slice(0, 1500)}`)
              .join("\n")}`
          : "",
        site.readme ? `README:\n${site.readme.slice(0, 2000)}` : "",
        site.warnings.length > 0 ? `Warnings: ${site.warnings.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  });

  const startFromBase = betaZodTool({
    name: "start_from_base",
    description:
      "Create this project's first blueprint from the approved base site, customised for the company. Call read_base_site first, then pass the pages and sections you propose.",
    inputSchema: z.object({
      companyName: z.string(),
      tagline: z.string().optional(),
      operationsJson: z
        .string()
        .describe(
          "a JSON array of add_page / add_section / update_theme / set_nav operations describing the customised site, in the same format as apply_operations",
        ),
      summary: z.string().describe("one sentence describing the site you built"),
    }),
    run: async ({ companyName, tagline, operationsJson, summary }) => {
      const existing = await store.getCurrentBlueprint(projectId);
      if (existing) {
        return "This project already has a blueprint. Use apply_operations to change it instead.";
      }

      // A minimal valid blueprint that the operations then build out. Starting
      // from a real blueprint rather than a null one means every operation goes
      // through exactly the same validated path as a later conversational edit.
      const seed: Blueprint = {
        projectId,
        version: 1,
        company: {
          name: companyName,
          tagline: tagline ?? "",
          brand: {
            logo: "",
            logoAlt: companyName,
            favicon: "",
            tokens: {
              colors: { primary: "#111111", secondary: "#666666", background: "#ffffff", text: "#111111" },
              fonts: { heading: "Inter", body: "Inter" },
              typeScale: [48, 32, 24, 18, 16, 14],
              radius: 8,
              spacing: 8,
              buttonStyle: "solid",
            },
          },
        },
        nav: [],
        pages: [{ id: "home", name: "Home", path: "/", sections: [], seo: { title: companyName, description: "" } }],
        unsupportedRequests: [],
      };

      let raw: unknown;
      try {
        raw = JSON.parse(operationsJson);
      } catch (error) {
        return `operationsJson was not valid JSON: ${error instanceof Error ? error.message : error}`;
      }
      const operations = (Array.isArray(raw) ? raw : [])
        .map((candidate) => BlueprintOperation.safeParse(candidate))
        .filter((r): r is { success: true; data: BlueprintOperation } => r.success)
        .map((r) => r.data);

      const result = applyOperations(seed, operations);
      const issues = validateBlueprint(result.blueprint);
      if (!isBuildable(issues)) {
        return `The site would not be valid: ${issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`).join("; ")}`;
      }

      const version = await store.saveVersion(projectId, {
        blueprint: result.blueprint,
        summary,
        operations: operations as unknown as Record<string, unknown>[],
      });
      await store.updateProject(projectId, { status: "ready", entryPoint: "base" });
      onActivity("start_from_base", `${summary} (version ${version.version})`);

      return [
        `Built version ${version.version} from the base site.`,
        result.changes.map((c) => `  - ${c}`).join("\n"),
        result.rejected.length > 0
          ? `Rejected: ${result.rejected.map((r) => `${r.operation.op} — ${r.reason}`).join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  const commitToBranch = betaZodTool({
    name: "commit_to_branch",
    description:
      "Write the site's configuration to a company-specific branch of the base repository. Never touches a protected branch and never writes outside the approved configuration files.",
    inputSchema: z.object({
      branch: z.string().describe("company-specific branch name, e.g. 'company/northwind'"),
    }),
    run: async ({ branch }) => {
      if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
        return `Refusing: "${branch}" is a protected branch. Changes reach production only through a publish request.`;
      }

      const blueprint = await store.getCurrentBlueprint(projectId);
      if (!blueprint) return "There is no blueprint to commit yet.";

      const repo = baseSiteRepo();
      const provider = getBaseSiteProvider();
      if (!repo && provider.backend !== "mock") {
        return "No base repository is configured (BASE_SITE_REPO is unset). Ask the admin for the approved repository link.";
      }

      const tokens = blueprint.company.brand.tokens;
      const files = [
        { path: "blueprint.json", content: JSON.stringify(blueprint, null, 2) },
        {
          path: "config/theme.json",
          content: JSON.stringify(
            { colors: tokens.colors, fonts: tokens.fonts, radius: tokens.radius, buttonStyle: tokens.buttonStyle },
            null,
            2,
          ),
        },
        {
          path: "config/site.json",
          content: JSON.stringify(
            {
              name: blueprint.company.name,
              tagline: blueprint.company.tagline,
              nav: blueprint.nav,
              pages: blueprint.pages.map((p) => ({ id: p.id, name: p.name, path: p.path })),
            },
            null,
            2,
          ),
        },
      ].filter((f) => isWritable(f.path));

      onActivity("commit_to_branch", `Committing configuration to ${branch}`);
      await provider.createBranch(repo, branch);
      const commit = await provider.commitFiles(
        repo,
        branch,
        files,
        `Career Site Studio: ${blueprint.company.name} v${blueprint.version}`,
      );

      return `Wrote ${commit.files.join(", ")} to branch ${branch}${commit.commitUrl ? ` (${commit.commitUrl})` : " (stand-in repository — nothing was pushed)"}.`;
    },
  });

  const listVersions = betaZodTool({
    name: "list_versions",
    description: "List the project's saved versions, newest first.",
    inputSchema: z.object({}),
    run: async () => {
      onActivity("list_versions", "Read the version history");
      const versions = await store.listVersions(projectId);
      if (versions.length === 0) return "No versions saved yet.";
      return versions
        .map((v) => `v${v.version} — ${v.summary} (${new Date(v.createdAt).toLocaleString()})`)
        .join("\n");
    },
  });

  const revertToVersion = betaZodTool({
    name: "revert_to_version",
    description:
      "Undo by restoring a previous version. This saves the old blueprint forward as a new version, so history is preserved and the undo itself can be undone.",
    inputSchema: z.object({ version: z.number().int().positive() }),
    run: async ({ version }) => {
      const record = await store.revertTo(projectId, version);
      onActivity("revert_to_version", `Reverted to version ${version}`);
      return `Restored version ${version} as version ${record.version}. The preview has updated.`;
    },
  });

  const requestPublish = betaZodTool({
    name: "request_publish",
    description:
      "File a request to publish the current version. Validates the blueprint first. This never deploys — a reviewer approves it separately.",
    inputSchema: z.object({
      notes: z.string().optional().describe("anything the reviewer should know"),
    }),
    run: async ({ notes }) => {
      const blueprint = await requireBlueprint();
      const issues = validateBlueprint(blueprint);
      if (!isBuildable(issues)) {
        return `Cannot request publication — the site does not validate:\n${issues
          .filter((i) => i.level === "error")
          .map((i) => `  ${i.path}: ${i.message}`)
          .join("\n")}`;
      }

      const versions = await store.listVersions(projectId);
      const recent = versions.slice(0, 5).map((v) => `v${v.version}: ${v.summary}`).join("\n");

      const request = await store.createPublishRequest({
        projectId,
        version: blueprint.version,
        requestedBy: "company-admin",
        changeSummary: recent,
        notes: notes ?? "",
      });

      onActivity("request_publish", `Filed a publish request for version ${blueprint.version}`);

      const warnings = issues.filter((i) => i.level === "warning");
      return [
        `Publish request ${request.id.slice(0, 8)} filed for version ${blueprint.version}. Status: pending review.`,
        warnings.length > 0 ? `Reviewer will see these warnings: ${warnings.map((w) => w.message).join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  return [
    searchComponents,
    describeComponent,
    listSections,
    getBlueprint,
    applyOps,
    importFigma,
    approvePlan,
    readBaseSite,
    startFromBase,
    commitToBranch,
    listVersions,
    revertToVersion,
    requestPublish,
    ...buildImageTools({ projectId, onActivity }),
    ...buildDatasetTools({ projectId, onActivity }),
    ...buildFidelityTools({ projectId, onActivity }),
    ...buildDesignTools({ projectId, onActivity }),
  ];
}
