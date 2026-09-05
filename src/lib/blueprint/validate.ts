import { Blueprint, LayoutProps, MAX_SECTION_DEPTH, type Section } from "./schema";
import { getComponent, getLayoutSection, getStaticSection, LAYOUT_SECTIONS } from "@/lib/registry";

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
 * Everything here walks the section tree, not just each page's top level —
 * a section nested three containers deep is as capable of naming an
 * unapproved component as one sitting on the page.
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
  /** Every section on the site, flattened, in tree order. */
  const allSections: Section[] = [];
  const seenSectionIds = new Set<string>();

  const checkSections = (sections: Section[], basePath: string, depth: number) => {
    for (const [sectionIndex, section] of sections.entries()) {
      const sectionPath = `${basePath}[${sectionIndex}]`;
      allSections.push(section);

      // Section ids are unique per site, not per page or per container, so a
      // conversational edit like "move the job search above employee stories"
      // can name one section unambiguously without also naming where it lives.
      if (seenSectionIds.has(section.id)) {
        issues.push({
          level: "error",
          path: sectionPath,
          message: `duplicate section id "${section.id}"`,
        });
      }
      seenSectionIds.add(section.id);

      if (depth > MAX_SECTION_DEPTH) {
        issues.push({
          level: "error",
          path: sectionPath,
          message: `nested ${depth} containers deep; the limit is ${MAX_SECTION_DEPTH}`,
        });
      }

      // Only containers hold sections. Anywhere else the children would be
      // dropped silently by every renderer, which reads as data loss.
      if (section.source !== "layout" && section.children.length > 0) {
        issues.push({
          level: "error",
          path: `${sectionPath}.children`,
          message: `"${section.label || section.type}" is not a layout container, so it cannot hold sections`,
        });
      }

      if (section.source === "zm-careers-lib") {
        checkComponentSection(section, sectionPath);
      } else if (section.source === "layout") {
        checkLayoutSection(section, sectionPath);
      } else if (section.source === "custom") {
        checkCustomSection(section, sectionPath);
      }

      checkSections(section.children, `${sectionPath}.children`, depth + 1);
    }
  };

  const checkComponentSection = (section: Section, sectionPath: string) => {
    const component = getComponent(section.type);
    if (!component) {
      issues.push({
        level: "error",
        path: sectionPath,
        message: `"${section.type}" is not in the approved component registry`,
      });
      return;
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
  };

  // Containers are the third case: they never resolve against the component
  // registry, because there is no approved library component for a flexbox.
  const checkLayoutSection = (section: Section, sectionPath: string) => {
    if (!getLayoutSection(section.type)) {
      issues.push({
        level: "error",
        path: sectionPath,
        message: `"${section.type}" is not a layout container; expected one of ${LAYOUT_SECTIONS.map((s) => s.id).join(", ")}`,
      });
      return;
    }
    const parsedProps = LayoutProps.safeParse(section.props);
    if (!parsedProps.success) {
      for (const issue of parsedProps.error.issues) {
        issues.push({
          level: "error",
          path: `${sectionPath}.props.${issue.path.join(".")}`,
          message: issue.message,
        });
      }
    }
    for (const propName of Object.keys(section.props)) {
      if (!(propName in LayoutProps.shape)) {
        issues.push({
          level: "error",
          path: `${sectionPath}.props.${propName}`,
          message: `a layout container does not have a "${propName}" setting`,
        });
      }
    }
    if (section.category !== "layout") {
      issues.push({
        level: "warning",
        path: sectionPath,
        message: `category "${section.category}" should be "layout" on a layout container`,
      });
    }
    // Not an error: an admin builds the row before filling it.
    if (section.children.length === 0) {
      issues.push({
        level: "warning",
        path: sectionPath,
        message: `"${section.label || section.type}" is an empty container and renders as nothing`,
      });
    }
  };

  const checkCustomSection = (section: Section, sectionPath: string) => {
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
  };

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

    checkSections(page.sections, `${pagePath}.sections`, 1);
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
  const hasJobDiscovery =
    allSections.length > 0 &&
    allSections.some((s) =>
      ["job-search", "job-listing", "job-listing-elasticsearch", "find-your-spot"].includes(s.type),
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
