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
 */
export const SectionSource = z.enum(["zm-careers-lib", "base", "custom"]);
export type SectionSource = z.infer<typeof SectionSource>;

export const SectionCategory = z.enum(["functional", "static", "infrastructure"]);

export const Section = z.object({
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
export type Section = z.infer<typeof Section>;

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

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  entryPoint: z.enum(["figma", "base"]),
  /** Figma file key or base repo URL, depending on entryPoint. */
  sourceRef: z.string().default(""),
  status: z.enum(["planning", "ready", "publish-requested"]).default("planning"),
  currentVersion: z.number().int().nonnegative().default(0),
});
export type Project = z.infer<typeof Project>;
