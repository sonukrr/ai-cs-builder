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
  source: "zm-careers-lib" | "base" | "custom";
  label: string;
  props: Record<string, any>;
  content: Record<string, any>;
  visible: boolean;
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
