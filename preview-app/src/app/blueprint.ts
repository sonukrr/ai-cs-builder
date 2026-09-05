/**
 * The slice of the Site Blueprint this renderer needs.
 *
 * Deliberately a subset, and deliberately tolerant: the studio owns the schema,
 * and the preview should keep rendering when a field it does not care about is
 * added upstream. Anything unknown is ignored rather than rejected.
 */

export interface BlueprintSection {
  id: string;
  type: string;
  source: "zm-careers-lib" | "base" | "custom" | "layout";
  label: string;
  props: Record<string, any>;
  content: Record<string, any>;
  visible: boolean;
  /** Only a `source: "layout"` section owns children; everything else nests nothing. */
  children?: BlueprintSection[];
  /** How this section sits inside its parent container. Absent at page level. */
  layout?: SectionLayout;
}

export type LayoutDirection = "row" | "column" | "grid";
export type LayoutAlign = "start" | "center" | "end" | "stretch";
export type LayoutJustify = "start" | "center" | "end" | "space-between" | "space-around";

/** A child's placement inside its container. Every field is optional by design. */
export interface SectionLayout {
  span?: number;
  grow?: number;
  basis?: string;
  align?: LayoutAlign;
  order?: number;
}

/** The props of a layout container, as the shared layout contract defines them. */
export interface LayoutProps {
  direction: LayoutDirection;
  columns: number;
  gap: number;
  align: LayoutAlign;
  justify: LayoutJustify;
  wrap: boolean;
  padding: number;
  maxWidth: number;
  background: string;
  stackBelow: number;
  reverseOnMobile: boolean;
}

export const LAYOUT_DEFAULTS: LayoutProps = {
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

export function isLayoutSection(section: BlueprintSection): boolean {
  return section.source === "layout";
}

/**
 * Resolves a container's props against the defaults.
 *
 * The studio validates these before they are ever stored, so this is not a
 * second validation pass — it exists because the preview also renders drafts
 * mid-edit, where a prop can be missing or half-typed. A value of the wrong
 * shape falls back to the default rather than reaching CSS, where `gap: NaNpx`
 * would silently drop the whole declaration.
 */
export function layoutProps(raw: Record<string, any> | undefined): LayoutProps {
  const props = raw ?? {};
  const one = <T extends string>(name: string, allowed: readonly T[], fallback: T): T =>
    allowed.includes(props[name]) ? (props[name] as T) : fallback;
  const number = (name: string, fallback: number): number =>
    typeof props[name] === "number" && Number.isFinite(props[name]) ? props[name] : fallback;

  return {
    direction: one("direction", ["row", "column", "grid"] as const, LAYOUT_DEFAULTS.direction),
    columns: number("columns", LAYOUT_DEFAULTS.columns),
    gap: number("gap", LAYOUT_DEFAULTS.gap),
    align: one("align", ["start", "center", "end", "stretch"] as const, LAYOUT_DEFAULTS.align),
    justify: one(
      "justify",
      ["start", "center", "end", "space-between", "space-around"] as const,
      LAYOUT_DEFAULTS.justify,
    ),
    wrap: typeof props["wrap"] === "boolean" ? props["wrap"] : LAYOUT_DEFAULTS.wrap,
    padding: number("padding", LAYOUT_DEFAULTS.padding),
    maxWidth: number("maxWidth", LAYOUT_DEFAULTS.maxWidth),
    background: typeof props["background"] === "string" ? props["background"] : LAYOUT_DEFAULTS.background,
    stackBelow: number("stackBelow", LAYOUT_DEFAULTS.stackBelow),
    reverseOnMobile:
      typeof props["reverseOnMobile"] === "boolean"
        ? props["reverseOnMobile"]
        : LAYOUT_DEFAULTS.reverseOnMobile,
  };
}

export interface BlueprintPage {
  id: string;
  name: string;
  path: string;
  sections: BlueprintSection[];
}

export interface Blueprint {
  projectId: string;
  version: number;
  company: {
    name: string;
    tagline: string;
    brand: {
      logo: string;
      tokens: {
        colors: Record<string, string>;
        fonts: { heading: string; body: string };
        radius: number;
        spacing: number;
        buttonStyle: string;
      };
    };
  };
  nav: { label: string; pageId?: string; href?: string }[];
  pages: BlueprintPage[];
}

/** CSS custom properties derived from the blueprint's design tokens. */
export function themeVariables(blueprint: Blueprint): Record<string, string> {
  const tokens = blueprint.company.brand.tokens;
  const colors = tokens.colors ?? {};

  return {
    "--brand-primary": colors["primary"] ?? "#111111",
    "--brand-secondary": colors["secondary"] ?? "#666666",
    "--brand-accent": colors["accent"] ?? colors["primary"] ?? "#111111",
    "--brand-background": colors["background"] ?? "#ffffff",
    "--brand-text": colors["text"] ?? "#111111",
    "--brand-surface": colors["surface"] ?? "#f4f6f8",
    "--brand-muted": colors["muted"] ?? "#5b6672",
    "--brand-font-heading": `${tokens.fonts?.heading ?? "Inter"}, system-ui, sans-serif`,
    "--brand-font-body": `${tokens.fonts?.body ?? "Inter"}, system-ui, sans-serif`,
    "--brand-radius": `${tokens.radius ?? 8}px`,
    "--brand-space": `${tokens.spacing ?? 8}px`,
  };
}
