import { z } from "zod";

/**
 * The Site Blueprint is the single source of truth for a career site.
 *
 * Both entry points (Figma import, Start From Base) converge on this shape, and
 * every conversational edit is applied as a structured operation against it —
 * never as a freehand edit to generated code. Renderers are downstream: the
 * React preview and the Angular emitter both read the blueprint, so neither can
 * drift into being the real definition of the site.
 */

export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected a hex colour");

/** A stable, URL-safe identifier. Used for page and section ids. */
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase kebab-case id");

export const DesignTokens = z.object({
  colors: z.object({
    primary: HexColor.default("#111111"),
    secondary: HexColor.default("#666666"),
    accent: HexColor.optional(),
    background: HexColor.default("#ffffff"),
    surface: HexColor.optional(),
    text: HexColor.default("#111111"),
    muted: HexColor.optional(),
    border: HexColor.optional(),
  }),
  fonts: z
    .object({
      heading: z.string().default("Inter"),
      body: z.string().default("Inter"),
    })
    .default({ heading: "Inter", body: "Inter" }),
  /** Type scale in px, largest first. Extracted from Figma where available. */
  typeScale: z.array(z.number().positive()).default([48, 32, 24, 18, 16, 14]),
  radius: z.number().min(0).max(64).default(8),
  /** Base spacing unit in px; the renderer derives a 4-step scale from it. */
  spacing: z.number().min(0).max(64).default(8),
  buttonStyle: z.enum(["solid", "outline", "pill", "square"]).default("solid"),
});
export type DesignTokens = z.infer<typeof DesignTokens>;

export const Brand = z.object({
  logo: z.string().default(""),
  logoAlt: z.string().default(""),
  favicon: z.string().default(""),
  tokens: DesignTokens,
});

/**
 * Where a section's implementation comes from.
 *
 * - `zm-careers-lib` — an approved functional component. Its `type` must resolve
 *   to a registry entry and its props are validated against that entry.
 * - `base` — a reusable presentation component from the approved base repo.
 * - `custom` — a configurable static section owned by the renderer. Content
 *   only; it can never introduce functional behaviour.
 * - `layout` — a container that renders nothing of its own and exists only to
 *   arrange its `children`. It resolves against LAYOUT_SECTIONS, never against
 *   the component registry, and its `props` are LayoutProps.
 */
export const SectionSource = z.enum(["zm-careers-lib", "base", "custom", "layout"]);
export type SectionSource = z.infer<typeof SectionSource>;

export const SectionCategory = z.enum(["functional", "static", "infrastructure", "layout"]);

/**
 * The props of a `source: "layout"` section — the whole vocabulary an admin has
 * for arranging things.
 *
 * Every renderer (React preview, Angular emit, and the studio canvas) derives
 * its container CSS from exactly these fields, so anything that is not here
 * cannot be expressed and anything added here has to be honoured in all three.
 */
export const LayoutProps = z.object({
  direction: z.enum(["row", "column", "grid"]).default("column"),
  /** Grid only. Ignored for row/column. */
  columns: z.number().int().min(1).max(12).default(2),
  gap: z.number().min(0).max(96).default(24),
  align: z.enum(["start", "center", "end", "stretch"]).default("stretch"),
  justify: z
    .enum(["start", "center", "end", "space-between", "space-around"])
    .default("start"),
  /** Row only. */
  wrap: z.boolean().default(true),
  padding: z.number().min(0).max(160).default(0),
  /** 0 means full bleed — the container does not centre itself. */
  maxWidth: z.number().min(0).max(2560).default(0),
  background: z.string().default(""),
  /** Below this viewport width a row/grid collapses to one column. 0 = never. */
  stackBelow: z.number().min(0).max(1600).default(720),
  reverseOnMobile: z.boolean().default(false),
});
export type LayoutProps = z.infer<typeof LayoutProps>;

/**
 * How a section sits inside its parent container.
 *
 * This lives on the child rather than as a per-index entry on the container so
 * that moving a section carries its placement with it — the driving example's
 * "300px sidebar" stays a 300px sidebar when it is reordered.
 */
export const SectionLayout = z.object({
  /** Grid column span. */
  span: z.number().int().min(1).max(12).optional(),
  /** flex-grow inside a row. */
  grow: z.number().min(0).max(12).optional(),
  /** flex-basis, e.g. "320px" or "40%". */
  basis: z.string().optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
  order: z.number().int().optional(),
});
export type SectionLayout = z.infer<typeof SectionLayout>;

/** Max nesting depth. A section sitting directly on a page is depth 1. */
export const MAX_SECTION_DEPTH = 4;

const SectionBase = z.object({
  id: Slug,
  /** Registry component id, or a static section type such as "hero". */
  type: z.string().min(1),
  category: SectionCategory,
  source: SectionSource,
  /** Admin-facing label. Never an internal React/Angular component name. */
  label: z.string().default(""),
  props: z.record(z.string(), z.unknown()).default({}),
  /** Free-form copy for static sections: headline, body, items, image refs. */
  content: z.record(z.string(), z.unknown()).default({}),
  visible: z.boolean().default(true),
  /** How this section is placed inside its parent container. Root-level
   * sections have no container, so this is ignored there. */
  layout: SectionLayout.optional(),
  /**
   * Provenance from an import — which Figma node this came from and how sure
   * the analysis was. Surfaced in the AI Site Plan so admins can audit guesses.
   */
  origin: z
    .object({
      kind: z.enum(["figma", "base", "agent", "admin"]),
      ref: z.string().default(""),
      confidence: z.number().min(0).max(1).optional(),
      note: z.string().default(""),
    })
    .optional(),
});

/**
 * A section, possibly a container of other sections.
 *
 * `children` is defined through zod v4's getter idiom because the type is
 * self-referential; the explicit `z.ZodType<Section, SectionInput>` annotation
 * is what stops TypeScript giving up with "implicitly has type 'any' because it
 * does not have a type annotation" on the circular `.default([])`.
 *
 * It defaults to `[]`, which is what keeps every blueprint written before
 * containers existed parsing unchanged.
 */
export interface Section extends z.infer<typeof SectionBase> {
  /** MUST be empty unless `source === "layout"`. */
  children: Section[];
}
export interface SectionInput extends z.input<typeof SectionBase> {
  children?: SectionInput[];
}
export const Section: z.ZodType<Section, SectionInput> = SectionBase.extend({
  get children() {
    return z.array(Section).default([]);
  },
});

export const Page = z.object({
  id: Slug,
  name: z.string().min(1),
  path: z.string().regex(/^\//, "page path must start with /"),
  sections: z.array(Section).default([]),
  seo: z
    .object({ title: z.string().default(""), description: z.string().default("") })
    .default({ title: "", description: "" }),
});
export type Page = z.infer<typeof Page>;

export const NavItem = z.object({
  label: z.string().min(1),
  /** Internal target: must match a page path. External links use `href`. */
  pageId: Slug.optional(),
  href: z.string().optional(),
});

export const Blueprint = z.object({
  projectId: z.string().min(1),
  version: z.number().int().positive().default(1),
  company: z.object({
    name: z.string().min(1),
    tagline: z.string().default(""),
    brand: Brand,
  }),
  nav: z.array(NavItem).default([]),
  pages: z.array(Page).min(1),
  /**
   * Capabilities the admin asked for that no approved component supports. The
   * agent records them here rather than inventing an implementation, and the
   * studio shows them as "needs the product team".
   */
  unsupportedRequests: z
    .array(z.object({ request: z.string(), reason: z.string(), requestedAt: z.string() }))
    .default([]),
});
export type Blueprint = z.infer<typeof Blueprint>;

/** A saved point in a project's history. Every approved change creates one. */
export const BlueprintVersion = z.object({
  version: z.number().int().positive(),
  createdAt: z.string(),
  /** One-line description of what changed, written by the agent. */
  summary: z.string(),
  /** The operations that produced this version, for undo and for audit. */
  operations: z.array(z.record(z.string(), z.unknown())).default([]),
  blueprint: Blueprint,
  previewUrl: z.string().default(""),
  branch: z.string().default(""),
});
export type BlueprintVersion = z.infer<typeof BlueprintVersion>;

export const PublishRequest = z.object({
  id: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  changeSummary: z.string(),
  notes: z.string().default(""),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

/**
 * Where a project's generated React site is published.
 *
 * Held per project rather than per deployment, and never inferred: an
 * administrator names the repository once and every later publish goes to the
 * same place. `allowNonEmpty` records that they were shown the repository
 * already had files in it and said to go ahead — a decision the deploy agent
 * must never make for them.
 */
/**
 * Which application a publish generates.
 *
 * Not a preference so much as a consequence. The approved careers components
 * are an Angular 15 library, so a site that uses any of them can only work as
 * an Angular application — `angular` installs the real library and renders live
 * jobs. `react` produces a Next.js app and marks every functional section as a
 * labelled gap, which is the right answer only for a site that is presentation
 * from top to bottom.
 */
export const DeployTargetKind = z.enum(["angular", "react"]);
export type DeployTargetKind = z.infer<typeof DeployTargetKind>;

export const DeployTarget = z.object({
  /** owner/name. Stored normalised, whatever shape it was typed in. */
  repo: z.string().min(1),
  branch: z.string().default("main"),
  /** Defaults to Angular, because that is the one that can carry the library. */
  target: DeployTargetKind.default("angular"),
  /** Vercel project name; defaults to one derived from the company name. */
  vercelProject: z.string().default(""),
  /** Applies only when the studio is the one creating the repository. */
  private: z.boolean().default(true),
  allowNonEmpty: z.boolean().default(false),
  savedAt: z.string(),
  savedBy: z.string().default("company-admin"),
});
export type DeployTarget = z.infer<typeof DeployTarget>;

/**
 * One publish of a version to a repository, and what became of it.
 *
 * Append-only, like the version history and for the same reason: "what is on
 * the live site, and which version is it" has to be answerable later, including
 * for the attempts that failed.
 */
export const Deployment = z.object({
  id: z.string(),
  projectId: z.string(),
  /** The blueprint version that was generated. */
  version: z.number().int().positive(),
  /** The publish request this deployment answers, when there is one. */
  publishRequestId: z.string().default(""),
  requestedBy: z.string().default("company-admin"),
  startedAt: z.string(),
  finishedAt: z.string().default(""),
  status: z.enum(["running", "succeeded", "failed"]).default("running"),
  repo: z.string().default(""),
  branch: z.string().default(""),
  /** Which application was generated. Older records predate the choice. */
  target: DeployTargetKind.default("react"),
  commitSha: z.string().default(""),
  commitUrl: z.string().default(""),
  filesPushed: z.number().int().nonnegative().default(0),
  vercelProject: z.string().default(""),
  vercelDeploymentId: z.string().default(""),
  /** The live URL, once there is one. */
  url: z.string().default(""),
  inspectorUrl: z.string().default(""),
  /** Approved components the React build could not render. */
  pendingComponents: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  /** What the deploy agent said it did, in one paragraph. */
  summary: z.string().default(""),
});
export type Deployment = z.infer<typeof Deployment>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  entryPoint: z.enum(["figma", "base"]),
  /** Figma file key or base repo URL, depending on entryPoint. */
  sourceRef: z.string().default(""),
  /**
   * `reviewing` is the design-fidelity gate: the site is built, but a Figma
   * import is held there until an administrator has approved the comparison
   * between the design and what was built. Base-site projects never enter it —
   * they have no design to be compared against.
   */
  status: z
    .enum(["planning", "reviewing", "ready", "publish-requested", "deployed"])
    .default("planning"),
  currentVersion: z.number().int().nonnegative().default(0),
});
export type Project = z.infer<typeof Project>;
