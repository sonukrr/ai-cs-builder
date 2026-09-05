import type { Blueprint, LayoutProps, Page, Section, SectionLayout } from "@/lib/blueprint/schema";
import { getComponent, registry } from "@/lib/registry";

/**
 * Emits the real career site from a blueprint.
 *
 * `zm-careers-lib` is an Angular 15 library, while the Studio itself is React.
 * That is not a problem to paper over — it is the reason the blueprint exists.
 * The blueprint is framework-agnostic, and there are two renderers downstream of
 * it: the React preview (src/components/preview) for fast in-studio iteration,
 * and this emitter, which produces the Angular the approved library actually
 * runs in.
 *
 * The output is deliberately templates and config, not application
 * architecture. It fills in a site; it does not invent one.
 */

export interface EmittedFile {
  path: string;
  content: string;
}

const INDENT = "  ";

function attr(name: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return `[${name}]="${value}"`;
  if (typeof value === "number") return `[${name}]="${value}"`;
  if (typeof value === "object") return `[${name}]='${JSON.stringify(value)}'`;
  // Strings bind as plain attributes; escape the quote that would break out.
  return `${name}="${String(value).replace(/"/g, "&quot;")}"`;
}

/* ------------------------------------------------------------------ layout */

const DIRECTIONS = ["row", "column", "grid"] as const;
const ALIGNMENTS = ["start", "center", "end", "stretch"] as const;
const JUSTIFICATIONS = ["start", "center", "end", "space-between", "space-around"] as const;

// The shapes come from the schema so a field added there cannot be silently
// ignored here; the tuples above exist because the emitter still has to check
// values it reads out of an untyped props record at runtime.
type Alignment = LayoutProps["align"];
type Justification = LayoutProps["justify"];

/*
 * Layout values are read defensively rather than trusted.
 *
 * A section's props are a `Record<string, unknown>`, and saved versions are
 * restored from history as raw JSON without being re-parsed, so the emitter
 * cannot assume the operation layer validated what it is looking at. An
 * unchecked value would go straight into a style attribute — `flex-direction:
 * diagonal` breaks the page silently, and a string carrying a `;` would inject
 * declarations of its own.
 */
function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function hexOrEmpty(value: unknown): string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3,8})$/.test(value) ? value : "";
}

function lengthOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:auto|0|\d+(?:\.\d+)?(?:px|%|rem|em|vw|vh|ch))$/.test(value.trim()) ? value.trim() : undefined;
}

function isLayoutSection(section: Section): boolean {
  return section.source === "layout";
}

/**
 * A blueprint saved before layout containers existed has no `children` key at
 * all — versions are restored from history as stored, not re-parsed through the
 * schema's defaults.
 */
function childrenOf(section: Section): Section[] {
  return isLayoutSection(section) ? section.children ?? [] : [];
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

function alignValue(align: Alignment): string {
  if (align === "start") return "flex-start";
  if (align === "end") return "flex-end";
  return align;
}

function justifyValue(justify: Justification): string {
  if (justify === "start") return "flex-start";
  if (justify === "end") return "flex-end";
  return justify;
}

function containerStyle(props: LayoutProps): string[] {
  const decls: string[] = [];
  if (props.direction === "grid") {
    decls.push("display: grid", `grid-template-columns: repeat(${props.columns}, minmax(0, 1fr))`);
  } else {
    decls.push("display: flex", `flex-direction: ${props.direction}`);
    if (props.direction === "row") decls.push(`flex-wrap: ${props.wrap ? "wrap" : "nowrap"}`);
  }
  decls.push(`gap: ${props.gap}px`, `align-items: ${alignValue(props.align)}`, `justify-content: ${justifyValue(props.justify)}`);
  if (props.padding > 0) decls.push(`padding: ${props.padding}px`);
  if (props.maxWidth > 0) decls.push(`max-width: ${props.maxWidth}px`, "margin-inline: auto");
  if (props.background) decls.push(`background: ${props.background}`);
  return decls;
}

/** The declarations a child carries because of the container it sits in. */
function placementStyle(parent: LayoutProps, child: Section): string[] {
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
  if (parent.direction !== "column") {
    // Flex and grid items default to `min-width: auto`, which refuses to shrink
    // below the content's intrinsic width — a job list would push the row wider
    // than the viewport instead of narrowing beside the facets.
    decls.push("min-width: 0");
  }
  if (placement.align) decls.push(`align-self: ${alignValue(placement.align)}`);
  if (placement.order !== undefined) decls.push(`order: ${placement.order}`);
  return decls;
}

/**
 * Page-scoped: section ids are unique within a page, so a bare id could collide
 * with a container of the same name on another page and hand it the wrong
 * breakpoint.
 */
function layoutClass(page: Page, section: Section): string {
  return `layout-${page.id}--${section.id}`;
}

/* ----------------------------------------------------------------- sections */

function emitFunctionalSection(section: Section, depth: number, placement: string[]): string {
  const component = getComponent(section.type);
  const pad = INDENT.repeat(depth);
  if (!component) {
    return `${pad}<!-- unknown component "${section.type}" — skipped -->`;
  }

  const attrs = [
    ...Object.entries(section.props)
      .filter(([name]) => name in component.props)
      .map(([name, value]) => attr(name, value)),
    placement.length > 0 ? attr("style", placement.join("; ")) : null,
  ].filter((a): a is string => a !== null);

  const open = attrs.length > 0 ? `<${component.selector}\n${attrs.map((a) => `${pad}${INDENT}${a}`).join("\n")}\n${pad}>` : `<${component.selector}>`;
  return `${pad}<!-- ${section.label} -->\n${pad}${open}</${component.selector}>`;
}

function emitStaticSection(section: Section, depth: number, placement: string[]): string {
  const pad = INDENT.repeat(depth);
  const content = section.content as Record<string, unknown>;

  // Static sections render through the base site's own presentation components,
  // driven by content from the blueprint. Emitting a generic host keeps the
  // emitter out of the business of writing markup per section type.
  return [
    `${pad}<!-- ${section.label} -->`,
    `${pad}<app-section`,
    `${pad}${INDENT}type="${section.type}"`,
    `${pad}${INDENT}sectionId="${section.id}"`,
    `${pad}${INDENT}[content]='${JSON.stringify(content).replace(/'/g, "&apos;")}'`,
    placement.length > 0 ? `${pad}${INDENT}${attr("style", placement.join("; "))}` : null,
    `${pad}></app-section>`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function emitLayoutSection(section: Section, page: Page, depth: number, placement: string[]): string {
  const pad = INDENT.repeat(depth);
  const props = layoutPropsOf(section);
  const classes = ["layout", `layout--${props.direction}`, layoutClass(page, section)].join(" ");
  const style = [...containerStyle(props), ...placement].join("; ");

  const children = childrenOf(section)
    .filter((child) => child.visible)
    .map((child) => emitSection(child, page, depth + 1, placementStyle(props, child)))
    .join("\n\n");

  return [
    `${pad}<!-- ${section.label || section.id} -->`,
    `${pad}<div class="${classes}" ${attr("style", style)}>`,
    children || `${pad}${INDENT}<!-- empty layout container -->`,
    `${pad}</div>`,
  ].join("\n");
}

function emitSection(section: Section, page: Page, depth: number, placement: string[]): string {
  if (isLayoutSection(section)) return emitLayoutSection(section, page, depth, placement);
  return section.source === "zm-careers-lib"
    ? emitFunctionalSection(section, depth, placement)
    : emitStaticSection(section, depth, placement);
}

function emitPageTemplate(page: Page): string {
  const body = page.sections
    .filter((s) => s.visible)
    .map((section) => emitSection(section, page, 1, []))
    .join("\n\n");

  return `<!-- Generated from the Site Blueprint. Edit the blueprint, not this file. -->\n<main class="page page--${page.id}">\n${body}\n</main>\n`;
}

/* ------------------------------------------------------------------ styles */

function walkSections(sections: Section[], visit: (section: Section) => void): void {
  for (const section of sections) {
    visit(section);
    walkSections(childrenOf(section), visit);
  }
}

/**
 * The one part of a layout that cannot be an inline style: `stackBelow` is a
 * media query, and a media query needs a rule with a selector. Each container
 * therefore gets a class, and the rule for it is generated here — into the
 * theme stylesheet rather than a second file, so the consuming app still has
 * exactly one generated stylesheet to wire into its build.
 */
function emitLayoutRules(blueprint: Blueprint): string {
  const blocks: string[] = [];

  for (const page of blueprint.pages) {
    walkSections(page.sections, (section) => {
      if (!isLayoutSection(section)) return;
      const props = layoutPropsOf(section);
      // A column already is the stacked layout, and 0 means never collapse.
      if (props.direction === "column" || props.stackBelow <= 0) return;

      const selector = `.${layoutClass(page, section)}`;
      blocks.push(
        [
          // `max-width` is inclusive, so the breakpoint is nudged below
          // stackBelow: a viewport exactly that wide still gets the row.
          `@media (max-width: ${props.stackBelow - 0.02}px) {`,
          `${INDENT}${selector} {`,
          `${INDENT}${INDENT}display: flex;`,
          `${INDENT}${INDENT}flex-direction: ${props.reverseOnMobile ? "column-reverse" : "column"};`,
          `${INDENT}}`,
          // Once the axis turns vertical, a child's `flex: 0 1 300px` would read
          // as a 300px *height*, and a grid span would be meaningless.
          `${INDENT}${selector} > * {`,
          `${INDENT}${INDENT}flex: 0 1 auto;`,
          `${INDENT}${INDENT}grid-column: auto;`,
          `${INDENT}}`,
          `}`,
        ].join("\n"),
      );
    });
  }

  return blocks.join("\n\n");
}

/** CSS custom properties, so the theme is one file rather than scattered styles. */
function emitTheme(blueprint: Blueprint): string {
  const t = blueprint.company.brand.tokens;
  const lines = [
    `--brand-primary: ${t.colors.primary};`,
    `--brand-secondary: ${t.colors.secondary};`,
    t.colors.accent ? `--brand-accent: ${t.colors.accent};` : null,
    `--brand-background: ${t.colors.background};`,
    `--brand-text: ${t.colors.text};`,
    t.colors.surface ? `--brand-surface: ${t.colors.surface};` : null,
    t.colors.muted ? `--brand-muted: ${t.colors.muted};` : null,
    t.colors.border ? `--brand-border: ${t.colors.border};` : null,
    `--brand-font-heading: ${JSON.stringify(t.fonts.heading)}, system-ui, sans-serif;`,
    `--brand-font-body: ${JSON.stringify(t.fonts.body)}, system-ui, sans-serif;`,
    `--brand-radius: ${t.radius}px;`,
    `--brand-space: ${t.spacing}px;`,
  ].filter(Boolean);

  const layoutRules = emitLayoutRules(blueprint);
  return [
    `/* Generated from the Site Blueprint. */`,
    `:root {\n${lines.map((l) => `${INDENT}${l}`).join("\n")}\n}`,
    layoutRules ? `/* Responsive collapse for layout containers. */\n${layoutRules}` : null,
  ]
    .filter(Boolean)
    .join("\n\n") + "\n";
}

function emitRoutes(blueprint: Blueprint): string {
  const routes = blueprint.pages
    .map((page) => {
      const path = page.path === "/" ? "" : page.path.replace(/^\//, "");
      return `${INDENT}{ path: '${path}', component: ${componentClassName(page)} },`;
    })
    .join("\n");

  const imports = blueprint.pages
    .map((page) => `import { ${componentClassName(page)} } from './pages/${page.id}/${page.id}.component';`)
    .join("\n");

  return `// Generated from the Site Blueprint.\nimport { Routes } from '@angular/router';\n${imports}\n\nexport const routes: Routes = [\n${routes}\n];\n`;
}

function componentClassName(page: Page): string {
  const pascal = page.id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}PageComponent`;
}

function emitPageComponent(page: Page): string {
  return [
    "// Generated from the Site Blueprint.",
    "import { Component } from '@angular/core';",
    "",
    "@Component({",
    `${INDENT}selector: 'app-page-${page.id}',`,
    `${INDENT}templateUrl: './${page.id}.component.html',`,
    "})",
    `export class ${componentClassName(page)} {}`,
    "",
  ].join("\n");
}

/**
 * Everything a blueprint produces, as files.
 *
 * Returned rather than written, so the caller decides whether they go to a
 * GitHub branch, a preview build, or a download.
 */
export function emitAngularSite(blueprint: Blueprint): EmittedFile[] {
  const files: EmittedFile[] = [];

  for (const page of blueprint.pages) {
    files.push({ path: `src/app/pages/${page.id}/${page.id}.component.html`, content: emitPageTemplate(page) });
    files.push({ path: `src/app/pages/${page.id}/${page.id}.component.ts`, content: emitPageComponent(page) });
  }

  files.push({ path: "src/app/app.routes.ts", content: emitRoutes(blueprint) });
  files.push({ path: "src/styles/theme.css", content: emitTheme(blueprint) });
  files.push({
    path: "src/app/site.config.json",
    content: JSON.stringify(
      {
        company: blueprint.company.name,
        tagline: blueprint.company.tagline,
        nav: blueprint.nav,
        library: `${registry.package.name}@${registry.package.version}`,
        ngModule: registry.package.ngModule,
      },
      null,
      2,
    ),
  });
  files.push({ path: "blueprint.json", content: JSON.stringify(blueprint, null, 2) });

  return files;
}

/** The library components a blueprint actually uses — for a build manifest. */
export function usedComponents(blueprint: Blueprint): string[] {
  const used = new Set<string>();
  for (const page of blueprint.pages) {
    walkSections(page.sections, (section) => {
      if (section.source !== "zm-careers-lib") return;
      const component = getComponent(section.type);
      if (component) used.add(component.className);
    });
  }
  return [...used].sort();
}
