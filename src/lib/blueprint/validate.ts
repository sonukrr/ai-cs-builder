import { Blueprint } from "./schema";
import { getComponent, getStaticSection } from "@/lib/registry";

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

/**
 * Validates a blueprint beyond what the zod schema can express.
 *
 * The schema guarantees shape; this guarantees the site is *buildable*: ids are
 * unique, every functional section resolves to an approved component, props are
 * ones that component actually accepts, and navigation points somewhere real.
 *
 * This runs before every render and before every publish request. It is the
 * gate that stops the agent claiming functionality the library does not have.
 */
export function validateBlueprint(blueprint: Blueprint): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const parsed = Blueprint.safeParse(blueprint);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        level: "error",
        path: issue.path.join("."),
        message: issue.message,
      });
    }
    // Shape is wrong; the structural checks below would report noise.
    return issues;
  }

  const site = parsed.data;

  const pageIds = new Set<string>();
  const pagePaths = new Set<string>();

  for (const [pageIndex, page] of site.pages.entries()) {
    const pagePath = `pages[${pageIndex}]`;

    if (pageIds.has(page.id)) {
      issues.push({ level: "error", path: pagePath, message: `duplicate page id "${page.id}"` });
    }
    pageIds.add(page.id);

    if (pagePaths.has(page.path)) {
      issues.push({ level: "error", path: pagePath, message: `duplicate page path "${page.path}"` });
    }
    pagePaths.add(page.path);

    // Section ids are unique per site, not per page, so a conversational edit
    // like "move the job search above employee stories" can name one section
    // unambiguously without also naming its page.
    for (const [sectionIndex, section] of page.sections.entries()) {
      const sectionPath = `${pagePath}.sections[${sectionIndex}]`;

      if (section.source === "zm-careers-lib") {
        const component = getComponent(section.type);
        if (!component) {
          issues.push({
            level: "error",
            path: sectionPath,
            message: `"${section.type}" is not in the approved component registry`,
          });
          continue;
        }
        if (component.status !== "approved") {
          issues.push({
            level: "error",
            path: sectionPath,
            message: `"${section.type}" is ${component.status}, not approved for admin use`,
          });
        }
        if (section.category !== component.category) {
          issues.push({
            level: "warning",
            path: sectionPath,
            message: `category "${section.category}" does not match registry category "${component.category}"`,
          });
        }
        for (const propName of Object.keys(section.props)) {
          if (!(propName in component.props)) {
            issues.push({
              level: "error",
              path: `${sectionPath}.props.${propName}`,
              message: `"${component.name}" does not accept a "${propName}" setting`,
            });
          }
        }
      } else if (section.source === "custom") {
        if (!getStaticSection(section.type)) {
          issues.push({
            level: "warning",
            path: sectionPath,
            message: `"${section.type}" is not a known static section; it will render as a plain text block`,
          });
        }
        if (section.category === "functional") {
          issues.push({
            level: "error",
            path: sectionPath,
            message:
              "a custom section cannot be functional — functional capability must come from the approved library",
          });
        }
      }
    }
  }

  const allSectionIds = site.pages.flatMap((p) => p.sections.map((s) => s.id));
  const seenSectionIds = new Set<string>();
  for (const id of allSectionIds) {
    if (seenSectionIds.has(id)) {
      issues.push({ level: "error", path: "pages[].sections[]", message: `duplicate section id "${id}"` });
    }
    seenSectionIds.add(id);
  }

  for (const [navIndex, item] of site.nav.entries()) {
    if (!item.pageId && !item.href) {
      issues.push({
        level: "error",
        path: `nav[${navIndex}]`,
        message: `nav item "${item.label}" links nowhere`,
      });
    }
    if (item.pageId && !pageIds.has(item.pageId)) {
      issues.push({
        level: "error",
        path: `nav[${navIndex}]`,
        message: `nav item "${item.label}" points at missing page "${item.pageId}"`,
      });
    }
  }

  // A career site with no way to see jobs is almost certainly a mistake, but it
  // is a legitimate intermediate state mid-build, so this is a warning.
  const hasJobDiscovery = allSectionIds.length > 0 &&
    site.pages.some((p) =>
      p.sections.some((s) =>
        ["job-search", "job-listing", "job-listing-elasticsearch", "find-your-spot"].includes(s.type),
      ),
    );
  if (!hasJobDiscovery) {
    issues.push({
      level: "warning",
      path: "pages",
      message: "no job search or job listing anywhere on the site — candidates cannot find roles",
    });
  }

  return issues;
}

export function isBuildable(issues: ValidationIssue[]): boolean {
  return !issues.some((i) => i.level === "error");
}
