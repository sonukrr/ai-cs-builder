import type { Blueprint, Page, Section } from "@/lib/blueprint/schema";
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

function emitFunctionalSection(section: Section, depth: number): string {
  const component = getComponent(section.type);
  const pad = INDENT.repeat(depth);
  if (!component) {
    return `${pad}<!-- unknown component "${section.type}" — skipped -->`;
  }

  const attrs = Object.entries(section.props)
    .filter(([name]) => name in component.props)
    .map(([name, value]) => attr(name, value))
    .filter((a): a is string => a !== null);

  const open = attrs.length > 0 ? `<${component.selector}\n${attrs.map((a) => `${pad}${INDENT}${a}`).join("\n")}\n${pad}>` : `<${component.selector}>`;
  return `${pad}<!-- ${section.label} -->\n${pad}${open}</${component.selector}>`;
}

function emitStaticSection(section: Section, depth: number): string {
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
    `${pad}></app-section>`,
  ].join("\n");
}

function emitPageTemplate(page: Page): string {
  const body = page.sections
    .filter((s) => s.visible)
    .map((section) =>
      section.source === "zm-careers-lib"
        ? emitFunctionalSection(section, 1)
        : emitStaticSection(section, 1),
    )
    .join("\n\n");

  return `<!-- Generated from the Site Blueprint. Edit the blueprint, not this file. -->\n<main class="page page--${page.id}">\n${body}\n</main>\n`;
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

  return `/* Generated from the Site Blueprint. */\n:root {\n${lines.map((l) => `${INDENT}${l}`).join("\n")}\n}\n`;
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
    for (const section of page.sections) {
      if (section.source !== "zm-careers-lib") continue;
      const component = getComponent(section.type);
      if (component) used.add(component.className);
    }
  }
  return [...used].sort();
}
