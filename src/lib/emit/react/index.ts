import type { Blueprint, LayoutProps, Page, Section, SectionLayout } from "@/lib/blueprint/schema";
import { getComponent, getStaticSection } from "@/lib/registry";
import {
  collectStudioAssets,
  NEXT_ASSETS,
  rebaseAssets,
  type StudioAsset,
} from "@/lib/emit/assets";
import {
  BASE_CSS,
  CONTENT_TS,
  FALLBACK_COMPONENT,
  PENDING_COMPONENT,
  STATIC_COMPONENTS,
  type ComponentSource,
} from "./runtime";

/**
 * Emits a deployable React site from a blueprint.
 *
 * The third renderer over the blueprint, and the first that produces something
 * a candidate can visit. `src/components/preview` renders it in the studio and
 * `src/lib/emit/angular.ts` produces the Angular the approved library runs in;
 * this produces a self-contained Next.js application for a company's own
 * repository, which is what the deploy agent pushes and Vercel builds.
 *
 * Three properties are deliberate.
 *
 * IT IS A PORT OF THE PREVIEW, NOT A NEW DESIGN. Every presentation section
 * emits the same elements and the same classes as the Angular preview host, and
 * `runtime.ts` carries the preview's stylesheet. The administrator approved
 * what the preview showed them; a generator that quietly improved on it would
 * ship something nobody signed off.
 *
 * IT IS ORDINARY CODE. Pages are literal JSX with the content inline, not a
 * runtime interpreter over blueprint.json, because the point of pushing to a
 * repository is that a developer can read and change what arrives. The
 * blueprint travels along for provenance, not to be executed.
 *
 * IT DOES NOT PRETEND TO CARRY THE LIBRARY. `zm-careers-lib` is Angular, so
 * every functional section — search, listings, filters, apply, resume upload —
 * emits as `PendingIntegration` and is reported as a warning. Faking those in
 * React would put a search box that does not search in front of real
 * candidates, which is the exact failure the component registry exists to
 * prevent.
 */

export { collectStudioAssets } from "@/lib/emit/assets";
export type { StudioAsset } from "@/lib/emit/assets";

export interface ReactSiteFile {
  path: string;
  /** UTF-8 source, or base64 for the images copied out of the asset store. */
  content: string;
  encoding: "utf-8" | "base64";
}

export interface EmitReactOptions {
  /**
   * Bytes for the assets `collectStudioAssets` found, keyed by their
   * studio-relative URL. Anything missing is reported as a warning and its
   * reference is left rewritten but broken, because a silently dropped image is
   * worse than a visible gap.
   */
  images?: Map<string, { base64: string }>;
  /** Where the site came from, written into the generated README. */
  studioProjectId?: string;
}

export interface ReactSite {
  files: ReactSiteFile[];
  /** Things the administrator has to know about the deployed result. */
  warnings: string[];
  /** Facts about the build, for the deploy report. */
  notes: string[];
  pages: { id: string; route: string; file: string }[];
  /** Approved components the site uses that this build cannot render. */
  pendingComponents: string[];
  assets: StudioAsset[];
}

/* ------------------------------------------------------------------ routes */

/**
 * The App Router directory for a page.
 *
 * A blueprint path is admin-facing and, because both entry points come from an
 * Angular world, its parameters are written Angular's way: the base site's own
 * router has `jobview/:jobUrl`, and an imported design inherits the same
 * convention. So `:id` is translated to Next's `[id]` rather than rejected —
 * refusing it would drop the job-detail page out of every generated site for a
 * notation difference, which is what this used to do.
 *
 * Segments are still filtered rather than escaped: a path that cannot be
 * expressed as a route is reported and the page is skipped, because writing a
 * file outside the app directory is not a fixable mistake.
 */
const PLAIN_SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;
/** `:jobUrl` (Angular) and `[jobUrl]` (Next) are the same thing written twice. */
const PARAM_SEGMENT = /^(?::([a-z0-9-]+)|\[([a-z0-9-]+)\])$/i;

function routeSegment(segment: string): string | null {
  const param = segment.match(PARAM_SEGMENT);
  if (param) {
    // Next's file convention is lowercase-insensitive but the param name is
    // read back verbatim, so it is kept exactly as the blueprint wrote it.
    return `[${param[1] ?? param[2]}]`;
  }
  return PLAIN_SEGMENT.test(segment) ? segment : null;
}

function routeDirectory(page: Page): string | null {
  const segments = page.path.split("/").filter(Boolean);
  if (segments.length === 0) return "";

  const translated = segments.map(routeSegment);
  if (translated.some((segment) => segment === null)) return null;
  return translated.join("/");
}

function pascal(value: string): string {
  const name = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  // A route id can start with a digit; a component name cannot.
  return /^[A-Za-z]/.test(name) ? name : `Page${name}`;
}

/* ------------------------------------------------------------------ layout */

const DIRECTIONS = ["row", "column", "grid"] as const;
const ALIGNMENTS = ["start", "center", "end", "stretch"] as const;
const JUSTIFICATIONS = ["start", "center", "end", "space-between", "space-around"] as const;

/*
 * Layout values are read defensively, exactly as the Angular emitter reads
 * them: a section's props are an untyped record, and a version restored from
 * history was never re-parsed through the schema, so a value here can be
 * anything at all. An unchecked one would go straight into a stylesheet.
 */
function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function hexOrEmpty(value: unknown): string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3,8})$/.test(value) ? value : "";
}

function lengthOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:auto|0|\d+(?:\.\d+)?(?:px|%|rem|em|vw|vh|ch))$/.test(value.trim())
    ? value.trim()
    : undefined;
}

function isLayout(section: Section): boolean {
  return section.source === "layout";
}

function childrenOf(section: Section): Section[] {
  return isLayout(section) ? section.children ?? [] : [];
}

function layoutPropsOf(section: Section): LayoutProps {
  const p = section.props as Record<string, unknown>;
  return {
    direction: oneOf(p.direction, DIRECTIONS, "column"),
    columns: Math.round(num(p.columns, 2, 1, 12)),
    gap: num(p.gap, 24, 0, 96),
    align: oneOf(p.align, ALIGNMENTS, "stretch"),
    justify: oneOf(p.justify, JUSTIFICATIONS, "start"),
    wrap: bool(p.wrap, true),
    padding: num(p.padding, 0, 0, 160),
    maxWidth: num(p.maxWidth, 0, 0, 2560),
    background: hexOrEmpty(p.background),
    stackBelow: num(p.stackBelow, 720, 0, 1600),
    reverseOnMobile: bool(p.reverseOnMobile, false),
  };
}

function placementOf(section: Section): SectionLayout {
  const raw = section.layout as Record<string, unknown> | undefined | null;
  if (!raw || typeof raw !== "object") return {};
  return {
    span: typeof raw.span === "number" ? Math.round(num(raw.span, 1, 1, 12)) : undefined,
    grow: typeof raw.grow === "number" ? num(raw.grow, 0, 0, 12) : undefined,
    basis: lengthOrUndefined(raw.basis),
    align: typeof raw.align === "string" ? oneOf(raw.align, ALIGNMENTS, "stretch") : undefined,
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? Math.round(raw.order) : undefined,
  };
}

const alignValue = (align: LayoutProps["align"]): string =>
  align === "start" ? "flex-start" : align === "end" ? "flex-end" : align;

const justifyValue = (justify: LayoutProps["justify"]): string =>
  justify === "start" ? "flex-start" : justify === "end" ? "flex-end" : justify;

/** Page-scoped, because section ids are unique per site but classes are global. */
const containerClass = (page: Page, section: Section) => `layout-${page.id}--${section.id}`;
const placementClass = (page: Page, section: Section) => `place-${page.id}--${section.id}`;

function containerDeclarations(props: LayoutProps): string[] {
  const decls: string[] = [];
  if (props.direction === "grid") {
    decls.push("display: grid", `grid-template-columns: repeat(${props.columns}, minmax(0, 1fr))`);
  } else {
    decls.push("display: flex", `flex-direction: ${props.direction}`);
    if (props.direction === "row") decls.push(`flex-wrap: ${props.wrap ? "wrap" : "nowrap"}`);
  }
  decls.push(
    `gap: ${props.gap}px`,
    `align-items: ${alignValue(props.align)}`,
    `justify-content: ${justifyValue(props.justify)}`,
  );
  if (props.padding > 0) decls.push(`padding: ${props.padding}px`);
  if (props.maxWidth > 0) decls.push(`max-width: ${props.maxWidth}px`, "margin-inline: auto");
  if (props.background) decls.push(`background: ${props.background}`);
  return decls;
}

/** What a child carries because of the container it sits in. */
function placementDeclarations(parent: LayoutProps, child: Section): string[] {
  const placement = placementOf(child);
  const decls: string[] = [];

  if (parent.direction === "row") {
    // A child that names a basis is asking to keep that width, so it does not
    // grow unless it says so; one that names nothing shares the row equally.
    const grow = placement.grow ?? (placement.basis ? 0 : 1);
    decls.push(`flex: ${grow} 1 ${placement.basis ?? "0%"}`);
  }
  if (parent.direction === "grid" && placement.span !== undefined) {
    decls.push(`grid-column: span ${placement.span}`);
  }
  if (placement.align) decls.push(`align-self: ${alignValue(placement.align)}`);
  if (placement.order !== undefined) decls.push(`order: ${placement.order}`);
  return decls;
}

/* -------------------------------------------------------------- stylesheet */

function walkSections(sections: Section[], visit: (section: Section, page: Page) => void, page: Page): void {
  for (const section of sections) {
    visit(section, page);
    walkSections(childrenOf(section), visit, page);
  }
}

/** CSS custom properties, matching the preview host's `themeVariables`. */
function themeBlock(blueprint: Blueprint): string {
  const tokens = blueprint.company.brand.tokens;
  const colors = tokens.colors;
  const lines = [
    `--brand-primary: ${colors.primary};`,
    `--brand-secondary: ${colors.secondary};`,
    `--brand-accent: ${colors.accent ?? colors.primary};`,
    `--brand-background: ${colors.background};`,
    `--brand-text: ${colors.text};`,
    `--brand-surface: ${colors.surface ?? "#f4f6f8"};`,
    `--brand-muted: ${colors.muted ?? "#5b6672"};`,
    `--brand-border: ${colors.border ?? "rgba(0, 0, 0, 0.08)"};`,
    `--brand-font-heading: ${JSON.stringify(tokens.fonts.heading)}, system-ui, sans-serif;`,
    `--brand-font-body: ${JSON.stringify(tokens.fonts.body)}, system-ui, sans-serif;`,
    `--brand-radius: ${tokens.radius}px;`,
    `--brand-space: ${tokens.spacing}px;`,
  ];
  return `:root {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`;
}

/**
 * Container and placement rules.
 *
 * These are classes rather than inline styles for one reason: `stackBelow` is a
 * breakpoint, a breakpoint is a media query, and a media query needs a
 * selector. Once the container has stacked, a child's `flex: 0 1 300px` would
 * read as a 300px *height* and a grid span would mean nothing, so both are
 * unset there — the same reset the Angular emitter writes.
 */
function layoutRules(blueprint: Blueprint): string {
  const blocks: string[] = [];

  for (const page of blueprint.pages) {
    walkSections(
      page.sections,
      (section) => {
        if (!isLayout(section)) return;
        const props = layoutPropsOf(section);
        const selector = `.${containerClass(page, section)}`;

        blocks.push(
          `${selector} {\n${containerDeclarations(props)
            .map((decl) => `  ${decl};`)
            .join("\n")}\n}`,
        );

        for (const child of childrenOf(section)) {
          const decls = placementDeclarations(props, child);
          if (decls.length === 0) continue;
          blocks.push(
            `.${placementClass(page, child)} {\n${decls.map((decl) => `  ${decl};`).join("\n")}\n}`,
          );
        }

        // A column already is the stacked layout, and 0 means never collapse.
        if (props.direction === "column" || props.stackBelow <= 0) return;
        blocks.push(
          [
            // `max-width` is inclusive, so the breakpoint is nudged below
            // stackBelow: a viewport exactly that wide still gets the row.
            `@media (max-width: ${props.stackBelow - 0.02}px) {`,
            `  ${selector} {`,
            `    display: flex;`,
            `    flex-direction: ${props.reverseOnMobile ? "column-reverse" : "column"};`,
            `  }`,
            `  ${selector} > .place {`,
            `    flex: 0 1 auto;`,
            `    grid-column: auto;`,
            `  }`,
            `}`,
          ].join("\n"),
        );
      },
      page,
    );
  }

  return blocks.join("\n\n");
}

/**
 * The replicas' stylesheets, collected into the one generated stylesheet.
 *
 * Every selector was rewritten to sit under `[data-section-id="<id>"]` when the
 * section was saved, which is what makes it safe to concatenate them: a replica
 * cannot reach the sections around it. Same reasoning as the Angular emitter,
 * and the same ordering — replicas last, so their own rules win a tie.
 */
function replicaRules(blueprint: Blueprint): string {
  const blocks: string[] = [];
  for (const page of blueprint.pages) {
    walkSections(
      page.sections,
      (section) => {
        if (section.type !== "custom-html") return;
        const css = (section.content as Record<string, unknown>).css;
        if (typeof css !== "string" || !css.trim()) return;
        blocks.push(`/* ${section.label || section.id} (${page.id}) */\n${css.trim()}`);
      },
      page,
    );
  }
  return blocks.join("\n\n");
}

function emitStylesheet(blueprint: Blueprint): string {
  const layout = layoutRules(blueprint);
  const replicas = replicaRules(blueprint);

  return [
    `/* Generated from the Site Blueprint v${blueprint.version}. Do not edit — change the site in the studio. */`,
    themeBlock(blueprint),
    BASE_CSS,
    layout ? `/* ---- layout containers, per page ---------------------------------------- */\n\n${layout}` : null,
    replicas ? `/* ---- hand-authored replicas, scoped to their section id ----------------- */\n\n${replicas}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

/* ------------------------------------------------------------------- links */

/** A link the generated site may emit: an internal route or an absolute URL. */
function safeHref(value: unknown): string {
  if (typeof value !== "string") return "";
  const href = value.trim();
  if (/^https?:\/\//i.test(href)) return href;
  // `//evil.com` and `/\evil.com` both leave the site; a real route never does.
  if (/^\/[^/\\]/.test(href) || href === "/") return href;
  return "";
}

function navLinks(blueprint: Blueprint): { label: string; href: string }[] {
  const routes = new Map(blueprint.pages.map((page) => [page.id, page.path]));
  return blueprint.nav.map((item) => ({
    label: item.label,
    href: item.pageId ? safeHref(routes.get(item.pageId)) : safeHref(item.href),
  }));
}

/**
 * A section's content as the generated component will receive it.
 *
 * The only thing added is `ctaHref`: the blueprint names a target page by id,
 * and an id means nothing to a browser. Resolving it here is what makes the
 * hero's button an actual link rather than the dead `javascript:void(0)` the
 * preview renders — the preview has nowhere to navigate to, and a deployed site
 * does.
 */
function contentFor(section: Section, blueprint: Blueprint): Record<string, unknown> {
  const content = { ...(section.content as Record<string, unknown>) };
  const routes = new Map(blueprint.pages.map((page) => [page.id, page.path]));

  const target = content.ctaPageId;
  const resolved =
    typeof target === "string" && routes.has(target)
      ? safeHref(routes.get(target))
      : safeHref(content.ctaHref);
  if (resolved) content.ctaHref = resolved;
  else delete content.ctaHref;

  return content;
}


/* -------------------------------------------------------------- section jsx */

interface EmitContext {
  blueprint: Blueprint;
  /** Component files the site needs, so only those are written. */
  used: Map<string, ComponentSource>;
  /** Component files the page being emitted needs, for its import list. */
  pageUsed: Map<string, ComponentSource>;
  /** Approved functional types found, which this build cannot render. */
  pending: Set<string>;
  warnings: string[];
  notes: string[];
}

function componentFor(section: Section, context: EmitContext): ComponentSource {
  const component =
    section.source === "zm-careers-lib"
      ? PENDING_COMPONENT
      : STATIC_COMPONENTS[section.type] ?? FALLBACK_COMPONENT;

  if (section.source === "zm-careers-lib") context.pending.add(section.type);
  context.used.set(component.path, component);
  context.pageUsed.set(component.path, component);
  return component;
}

/** A JS object literal, re-indented to sit inside JSX. */
function literal(value: unknown, pad: string): string {
  const json = JSON.stringify(value, null, 2) ?? "{}";
  return json.split("\n").join(`\n${pad}`);
}

function renderSection(section: Section, page: Page, context: EmitContext, depth: number): string {
  const pad = "  ".repeat(depth);

  if (isLayout(section)) {
    const props = layoutPropsOf(section);
    const children = childrenOf(section).filter((child) => child.visible);
    const classes = ["layout", `layout--${props.direction}`, containerClass(page, section)].join(" ");

    if (children.length === 0) {
      context.notes.push(
        `“${section.label || section.id}” is an empty container, so it renders nothing on ${page.name}.`,
      );
      return `${pad}<div className="${classes}" />`;
    }

    const inner = children.map((child) => {
      // Every child carries `.place` because the stacked reset selects on it;
      // the specific class only exists when the child has placement of its own.
      const childClasses = ["place"];
      if (placementDeclarations(props, child).length > 0) {
        childClasses.push(placementClass(page, child));
      }
      return [
        `${pad}  <div className="${childClasses.join(" ")}">`,
        renderSection(child, page, context, depth + 2),
        `${pad}  </div>`,
      ].join("\n");
    });

    return [`${pad}<div className="${classes}">`, ...inner, `${pad}</div>`].join("\n");
  }

  const component = componentFor(section, context);

  if (component === PENDING_COMPONENT) {
    const settings = section.props as Record<string, unknown>;
    return [
      `${pad}<PendingIntegration`,
      `${pad}  component=${JSON.stringify(section.type)}`,
      `${pad}  label=${JSON.stringify(section.label || section.type)}`,
      Object.keys(settings).length > 0 ? `${pad}  settings={${literal(settings, `${pad}  `)}}` : null,
      `${pad}/>`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return [
    `${pad}<${component.name}`,
    section.type === "custom-html" ? `${pad}  sectionId=${JSON.stringify(section.id)}` : null,
    `${pad}  label=${JSON.stringify(section.label || section.type)}`,
    `${pad}  content={${literal(contentFor(section, context.blueprint), `${pad}  `)}}`,
    `${pad}/>`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Content fields no renderer reads.
 *
 * Reported rather than accommodated. The generated site renders exactly what
 * the preview renders, so a hero whose copy was written under `subheadline`
 * instead of `subhead` is already blank on screen in the studio — quietly
 * reading both here would make the deployed site differ from the thing the
 * administrator approved, and would hide the authoring mistake instead of
 * naming it.
 */
function unreadContentKeys(section: Section): string[] {
  const definition = getStaticSection(section.type);
  if (!definition) return [];

  const allowed = new Set(Object.keys(definition.contentKeys));
  // Companions every renderer reads for an image key, plus what the studio
  // itself writes onto a section.
  for (const key of [...allowed]) allowed.add(`${key}Alt`).add(`${key}Credit`);
  for (const key of ["credits", "css", "note", "ctaHref", "items"]) allowed.add(key);

  return Object.keys(section.content as Record<string, unknown>).filter((key) => !allowed.has(key));
}

function emitPage(page: Page, context: EmitContext): { route: string; file: string; source: string } | null {
  const directory = routeDirectory(page);
  if (directory === null) {
    context.warnings.push(
      `The page “${page.name}” has the path "${page.path}", which cannot be expressed as a Next.js route, so it is not in the generated site.`,
    );
    return null;
  }

  context.pageUsed = new Map();
  const body = page.sections
    .filter((section) => section.visible)
    .map((section) => renderSection(section, page, context, 3))
    .join("\n");

  const imports = [...context.pageUsed.values()]
    .map((component) => `import { ${component.name} } from "@/${component.path.replace(/\.tsx$/, "")}";`)
    .sort();

  const seo = page.seo ?? { title: "", description: "" };
  const metadata =
    seo.title || seo.description
      ? [
          "export const metadata: Metadata = {",
          seo.title ? `  title: ${JSON.stringify(seo.title)},` : null,
          seo.description ? `  description: ${JSON.stringify(seo.description)},` : null,
          "};",
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
      : "";

  const source = [
    `/* Generated from the Site Blueprint v${context.blueprint.version}. Do not edit — change the site in the studio. */`,
    metadata ? `import type { Metadata } from "next";` : null,
    imports.join("\n") || null,
    "",
    metadata || null,
    metadata ? "" : null,
    `export default function ${pascal(page.id)}Page() {`,
    "  return (",
    `    <main className="page page--${page.id}">`,
    body || "      {/* This page has no sections yet. */}",
    "    </main>",
    "  );",
    "}",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  return {
    route: page.path,
    file: directory ? `app/${directory}/page.tsx` : "app/page.tsx",
    source: `${source}\n`,
  };
}

/* --------------------------------------------------------------- scaffolding */

/** A repository name npm and GitHub will both accept. */
function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * The webfont link, when the brand names a font worth fetching.
 *
 * A deliberate difference from the preview host, which loads no webfonts at all
 * and therefore only shows a brand font that happens to be installed on the
 * operator's machine. A public career site should render its brand typography
 * for everyone, so the generated site asks for it — and the stack still falls
 * back to system-ui exactly as the preview's does if the request fails or the
 * family is not a Google font.
 */
const SYSTEM_FONTS = new Set([
  "inherit",
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "arial",
  "helvetica",
  "helvetica neue",
  "times new roman",
  "georgia",
  "courier new",
  "segoe ui",
  "roboto",
]);

function fontFamilies(blueprint: Blueprint): string[] {
  const { heading, body } = blueprint.company.brand.tokens.fonts;
  return [...new Set([heading, body])]
    .map((family) => family.trim())
    .filter((family) => family !== "" && !SYSTEM_FONTS.has(family.toLowerCase()))
    .filter((family) => /^[A-Za-z][A-Za-z0-9 ]{1,40}$/.test(family));
}

function fontHref(families: string[]): string {
  const query = families
    .map((family) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;600;700`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

function emitLayout(blueprint: Blueprint): string {
  const families = fontFamilies(blueprint);
  const title = blueprint.company.name ? `Careers at ${blueprint.company.name}` : "Careers";

  return `/* Generated from the Site Blueprint v${blueprint.version}. Do not edit — change the site in the studio. */
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: ${JSON.stringify(title)},
    template: ${JSON.stringify(`%s · ${blueprint.company.name || "Careers"}`)},
  },
  description: ${JSON.stringify(blueprint.company.tagline || title)},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
${
  families.length > 0
    ? `      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href=${JSON.stringify(fontHref(families))} />
      </head>
`
    : ""
}      <body>{children}</body>
    </html>
  );
}
`;
}

function emitSiteModule(blueprint: Blueprint): string {
  const nav = navLinks(blueprint);
  return `/* Generated from the Site Blueprint v${blueprint.version}. Do not edit — change the site in the studio. */

export interface NavLink {
  label: string;
  /** Empty when the blueprint's navigation item points nowhere yet. */
  href: string;
}

/** Copyright renders the year the page is served, not the year it was built. */
const year = new Date().getFullYear();

export const site: {
  name: string;
  tagline: string;
  legal: string;
  nav: NavLink[];
} = {
  name: ${JSON.stringify(blueprint.company.name)},
  tagline: ${JSON.stringify(blueprint.company.tagline)},
  legal: "© " + year + " " + ${JSON.stringify(blueprint.company.name)},
  nav: ${JSON.stringify(nav, null, 2).split("\n").join("\n  ")},
};
`;
}

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "^15.5.4",
        react: "^19.1.1",
        "react-dom": "^19.1.1",
      },
      devDependencies: {
        "@types/node": "^22.15.3",
        "@types/react": "^19.1.9",
        "@types/react-dom": "^19.1.7",
        typescript: "^5.7.3",
      },
    },
    null,
    2,
  )}\n`;

const TSCONFIG_JSON = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "dom.iterable", "ES2022"],
      allowJs: false,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
)}\n`;

const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;

const NEXT_ENV = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited.
`;

const GITIGNORE = `node_modules
.next
out
build
.DS_Store
*.pem
.env*.local
.vercel
*.tsbuildinfo
`;

/**
 * What a developer opening the repository needs to know first.
 *
 * Chiefly that the site is generated: an edit here is an edit the next publish
 * overwrites, and the place to change the site is the studio.
 */
function emitReadme(
  blueprint: Blueprint,
  pending: string[],
  options: EmitReactOptions,
): string {
  const pages = blueprint.pages.map((page) => `| ${page.name} | \`${page.path}\` |`).join("\n");

  return `# ${blueprint.company.name || "Career site"}

Generated from a Site Blueprint by Career Site Studio — version ${blueprint.version}${
    options.studioProjectId ? `, project \`${options.studioProjectId}\`` : ""
  }.

## This code is generated

Every file here except this README is written from \`blueprint.json\`. Change the
site in the studio and publish again; edits made directly in this repository are
overwritten by the next publish.

## Running it

\`\`\`bash
npm install
npm run dev
\`\`\`

Vercel builds it with no configuration: it is a standard Next.js application.

## Pages

| Page | Route |
| --- | --- |
${pages}

## Layout

- \`app/\` — one route per blueprint page, as literal JSX.
- \`app/globals.css\` — the brand's design tokens, the section styles, and the
  per-container layout rules that carry each container's mobile breakpoint.
- \`components/sections/\` — the presentation sections, ported from the studio
  preview so this site renders what the administrator approved.
- \`lib/\` — the company details and the content helpers those components use.
- \`public/images/\` — every image the site uses, copied out of the studio.
${
  pending.length > 0
    ? `- \`components/library/\` — the careers components this build cannot render.
  **Read \`components/library/README.md\` before launching this site.**
`
    : ""
}`;
}

/**
 * The integration note for the approved components a React build cannot host.
 *
 * This file is the whole reason `PendingIntegration` is honest rather than
 * broken: it names each component, what it does, and the settings the
 * administrator chose, so wiring up the real thing does not require going back
 * to the blueprint to find out what was asked for.
 */
function emitLibraryReadme(blueprint: Blueprint, pending: string[]): string {
  const rows = pending.map((type) => {
    const component = getComponent(type);
    const sections: string[] = [];
    for (const page of blueprint.pages) {
      walkSections(
        page.sections,
        (section) => {
          if (section.type === type && section.source === "zm-careers-lib") {
            sections.push(`${page.name} → ${section.label || section.id}`);
          }
        },
        page,
      );
    }
    return [
      `### ${component?.name ?? type} (\`${type}\`)`,
      "",
      component?.blurb ?? "An approved careers component.",
      "",
      component ? `Angular component: \`${component.className}\` — \`<${component.selector}>\`` : null,
      "",
      `Used on: ${sections.join(", ")}`,
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  });

  return `# Careers components that are not implemented here

This site's job search, listings, filters and application flow come from
\`zm-careers-lib\`, which is an **Angular 15** library. A React build cannot
render one, so each of those sections renders \`PendingIntegration\` — a labelled
gap — and the settings chosen in the studio travel with it in the page's JSX.

Nothing here imitates those components on purpose. A search box that does not
search, or a list showing invented roles, is worse in front of a real candidate
than an obvious gap.

## Ways to close the gap

1. **Deploy the Angular emit instead.** The same blueprint produces the real
   library-backed site — see \`src/lib/emit/angular.ts\` in the studio.
2. **Embed the Angular careers app** at a route this site links to.
3. **Implement React equivalents** against the same careers API the library
   uses, and replace the \`PendingIntegration\` calls in \`app/\`.

## What is missing

${rows.join("\n")}`;
}

/* ------------------------------------------------------------------- public */

export function emitReactSite(blueprint: Blueprint, options: EmitReactOptions = {}): ReactSite {
  const assets = collectStudioAssets(blueprint, NEXT_ASSETS);
  // Every renderer downstream of here sees /images/… rather than /api/….
  const site = rebaseAssets(blueprint, assets);

  const context: EmitContext = {
    blueprint: site,
    used: new Map(),
    pageUsed: new Map(),
    pending: new Set(),
    warnings: [],
    notes: [],
  };

  const files: ReactSiteFile[] = [];
  const text = (path: string, content: string) =>
    files.push({ path, content, encoding: "utf-8" as const });

  const pages: ReactSite["pages"] = [];
  for (const page of site.pages) {
    const emitted = emitPage(page, context);
    if (!emitted) continue;
    text(emitted.file, emitted.source);
    pages.push({ id: page.id, route: emitted.route, file: emitted.file });
  }

  if (pages.length === 0) {
    context.warnings.push("None of the blueprint's pages could be emitted as routes.");
  }
  // Next needs app/page.tsx to serve "/"; a blueprint whose pages all live
  // under a path would deploy to a 404 at the root, which reads as a failed
  // deployment rather than as a site with no home page.
  if (pages.length > 0 && !pages.some((page) => page.file === "app/page.tsx")) {
    context.warnings.push(
      `No blueprint page has the path "/", so the deployed site's home page is a 404. Give one page the path "/" in the studio.`,
    );
  }

  for (const component of context.used.values()) text(component.path, component.source);

  text("app/layout.tsx", emitLayout(site));
  text("app/globals.css", emitStylesheet(site));
  text("lib/content.ts", CONTENT_TS);
  text("lib/site.ts", emitSiteModule(site));
  text("package.json", PACKAGE_JSON(slug(blueprint.company.name, "career-site")));
  text("tsconfig.json", TSCONFIG_JSON);
  text("next.config.mjs", NEXT_CONFIG);
  text("next-env.d.ts", NEXT_ENV);
  text(".gitignore", GITIGNORE);
  // The blueprint travels for provenance: what shipped, and what it was built
  // from, in one commit.
  text("blueprint.json", `${JSON.stringify(blueprint, null, 2)}\n`);

  const pending = [...context.pending].sort();
  text("README.md", emitReadme(site, pending, options));
  if (pending.length > 0) text("components/library/README.md", emitLibraryReadme(site, pending));

  /* Images. A reference with no bytes is reported rather than dropped. */
  const missing: string[] = [];
  for (const asset of assets) {
    const bytes = options.images?.get(asset.url);
    if (!bytes) {
      missing.push(asset.url);
      continue;
    }
    files.push({ path: asset.path, content: bytes.base64, encoding: "base64" });
  }

  if (missing.length > 0) {
    context.warnings.push(
      `${missing.length} image${missing.length === 1 ? "" : "s"} could not be copied out of the studio, so ${
        missing.length === 1 ? "it" : "they"
      } will 404 on the deployed site: ${missing.slice(0, 5).join(", ")}${
        missing.length > 5 ? ", …" : ""
      }`,
    );
  }

  if (pending.length > 0) {
    const names = pending.map((type) => getComponent(type)?.name ?? type);
    context.warnings.push(
      `${pending.length} approved careers component${pending.length === 1 ? "" : "s"} cannot run in React and render as a labelled gap: ${names.join(
        ", ",
      )}. The deployed site will not search, list or accept applications — see components/library/README.md.`,
    );
  }

  /* Content the studio holds but no renderer reads. */
  for (const page of site.pages) {
    walkSections(
      page.sections,
      (section) => {
        const unread = unreadContentKeys(section);
        if (unread.length === 0) return;
        context.notes.push(
          `“${section.label || section.id}” on ${page.name} carries ${unread.join(", ")}, which no renderer reads — the studio preview leaves ${
            unread.length === 1 ? "it" : "them"
          } out too.`,
        );
      },
      page,
    );
  }

  context.notes.push(
    `${files.length} files, ${pages.length} route${pages.length === 1 ? "" : "s"}, ${assets.length - missing.length} image${
      assets.length - missing.length === 1 ? "" : "s"
    }.`,
  );

  return {
    files,
    warnings: context.warnings,
    notes: context.notes,
    pages,
    pendingComponents: pending,
    assets,
  };
}
