import registryJson from "./registry.json";
import type { LayoutProps } from "@/lib/blueprint/schema";

/**
 * The approved component catalog.
 *
 * `registry.json` is generated from the published `zm-careers-lib` package by
 * `scripts/build-registry.mjs` — see that file for why the compiled `.d.ts` is
 * the source rather than the package README.
 *
 * Note that `zm-careers-lib` is an **Angular 15** library. The Studio itself is
 * React, so the registry deliberately records `selector` and `className` as
 * framework-specific emit details; nothing in the blueprint or the preview
 * depends on them. See src/lib/emit/angular.ts.
 */

export interface RegistryProp {
  documented: boolean;
  description: string;
}

export interface RegistryComponent {
  id: string;
  /** Friendly, admin-facing name. The only name the UI is allowed to show. */
  name: string;
  blurb: string;
  category: "functional" | "static" | "infrastructure";
  status: "approved" | "internal" | "unreviewed";
  package: string;
  packageVersion: string;
  framework: string;
  className: string;
  selector: string;
  capabilities: string[];
  /** Ids of components that already render this one internally. */
  composedBy: string[];
  props: Record<string, RegistryProp>;
  events: string[];
  defaults: Record<string, unknown>;
}

export interface Registry {
  package: {
    name: string;
    version: string;
    framework: string;
    ngModule: string;
    peerDependencies: Record<string, string>;
  };
  components: RegistryComponent[];
}

export const registry = registryJson as unknown as Registry;

/**
 * Static sections the renderer owns. These carry content but never behaviour —
 * that separation is what lets the agent create them freely while functional
 * capability stays gated behind the approved library.
 */
export interface StaticSectionDef {
  id: string;
  name: string;
  blurb: string;
  /** Content keys the renderer understands, with a short description each. */
  contentKeys: Record<string, string>;
}

export const STATIC_SECTIONS: StaticSectionDef[] = [
  {
    id: "hero",
    name: "Hero Banner",
    blurb: "Headline, supporting copy, a call to action and a background image.",
    contentKeys: {
      headline: "Main headline.",
      subhead: "Supporting sentence under the headline.",
      ctaLabel: "Primary button label.",
      ctaPageId: "Page the primary button links to.",
      image: "Background or side image URL.",
      alignment: "left | center",
    },
  },
  {
    id: "value-props",
    name: "Why Join Us",
    blurb: "A row of short value propositions, each with an icon and blurb.",
    contentKeys: { headline: "Section headline.", items: "[{ title, body, icon }]" },
  },
  {
    id: "benefits",
    name: "Benefits",
    blurb: "Grid of benefits and perks.",
    contentKeys: { headline: "Section headline.", items: "[{ title, body, icon }]" },
  },
  {
    id: "culture",
    name: "Culture",
    blurb: "Narrative block about how the company works, with imagery.",
    contentKeys: {
      headline: "Section headline.",
      body: "Paragraph copy.",
      image: "Supporting image URL.",
    },
  },
  {
    id: "employee-stories",
    name: "Employee Stories",
    blurb: "Cards featuring individual employees and their story.",
    contentKeys: { headline: "Section headline.", items: "[{ name, role, quote, photo }]" },
  },
  {
    id: "testimonials",
    name: "Testimonials",
    blurb: "Pull quotes from employees or candidates.",
    contentKeys: { headline: "Section headline.", items: "[{ quote, author, role }]" },
  },
  {
    id: "teams",
    name: "Teams",
    blurb: "Grid of departments or teams, each linking to filtered jobs.",
    contentKeys: { headline: "Section headline.", items: "[{ name, body, image, filter }]" },
  },
  {
    id: "locations",
    name: "Locations",
    blurb: "Offices and regions where the company hires.",
    contentKeys: { headline: "Section headline.", items: "[{ city, country, image }]" },
  },
  {
    id: "stats",
    name: "By the Numbers",
    blurb: "Headline statistics about the company.",
    contentKeys: { headline: "Section headline.", items: "[{ value, label }]" },
  },
  {
    id: "process",
    name: "Hiring Process",
    blurb: "Numbered steps explaining what candidates should expect.",
    contentKeys: { headline: "Section headline.", items: "[{ title, body }]" },
  },
  {
    id: "faq",
    name: "FAQ",
    blurb: "Frequently asked questions, as an accordion.",
    contentKeys: { headline: "Section headline.", items: "[{ question, answer }]" },
  },
  {
    id: "cta",
    name: "Call to Action",
    blurb: "A closing banner pushing candidates toward open roles.",
    contentKeys: { headline: "Headline.", body: "Supporting copy.", ctaLabel: "Button label.", ctaPageId: "Target page." },
  },
  {
    id: "rich-text",
    name: "Text Block",
    blurb: "A free-form block of formatted copy.",
    contentKeys: { headline: "Optional headline.", body: "Markdown body copy." },
  },
  {
    id: "media",
    name: "Image or Video",
    blurb: "A single full-width image or embedded video.",
    contentKeys: { image: "Image URL.", video: "Video embed URL.", caption: "Caption." },
  },
  {
    id: "logo-wall",
    name: "Logo Wall",
    blurb: "Press mentions, awards or partner logos.",
    contentKeys: { headline: "Section headline.", items: "[{ name, image }]" },
  },
  {
    id: "nav",
    name: "Navigation",
    blurb: "Site header with logo and navigation links.",
    contentKeys: { showLogo: "true | false", sticky: "true | false" },
  },
  {
    id: "footer",
    name: "Footer",
    blurb: "Site footer with links, social icons and legal copy.",
    contentKeys: { columns: "[{ title, links: [{ label, href }] }]", legal: "Copyright line." },
  },
];

/**
 * Layout containers the renderer owns.
 *
 * These are not components in the `zm-careers-lib` sense — they emit no markup
 * of their own beyond a wrapper element, so they are exempt from the approval
 * gate. All three are the same container with different LayoutProps defaults;
 * separate ids exist so the agent can say "row" instead of reasoning about
 * flex-direction.
 */
export interface LayoutSectionDef {
  id: string;
  name: string;
  blurb: string;
  /** LayoutProps overrides applied when a container of this type is created. */
  defaults: Partial<LayoutProps>;
}

export const LAYOUT_SECTIONS: LayoutSectionDef[] = [
  {
    id: "row",
    name: "Row",
    blurb: "Children side by side, wrapping and stacking on narrow screens.",
    defaults: { direction: "row" },
  },
  {
    id: "stack",
    name: "Stack",
    blurb: "Children one above another, with a shared gap and padding.",
    defaults: { direction: "column" },
  },
  {
    id: "grid",
    name: "Grid",
    blurb: "Children in N equal columns.",
    defaults: { direction: "grid", columns: 2 },
  },
];

const byId = new Map(registry.components.map((c) => [c.id, c]));
const staticById = new Map(STATIC_SECTIONS.map((s) => [s.id, s]));
const layoutById = new Map(LAYOUT_SECTIONS.map((s) => [s.id, s]));

export function getComponent(id: string): RegistryComponent | undefined {
  return byId.get(id);
}

export function getStaticSection(id: string): StaticSectionDef | undefined {
  return staticById.get(id);
}

export function getLayoutSection(id: string): LayoutSectionDef | undefined {
  return layoutById.get(id);
}

/** Components an administrator is allowed to add. Excludes internal plumbing. */
export function catalog(): RegistryComponent[] {
  return registry.components.filter(
    (c) => c.status === "approved" && c.composedBy.length === 0,
  );
}

/**
 * Keyword search over the approved catalog.
 *
 * Deliberately simple and deterministic: the agent calls this as a tool and
 * reasons over the results, rather than the search itself being a model call.
 */
export function searchRegistry(query: string, limit = 6): RegistryComponent[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (terms.length === 0) return catalog().slice(0, limit);

  const scored = catalog().map((component) => {
    const haystack = [
      component.id,
      component.name,
      component.blurb,
      ...component.capabilities,
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (component.id.includes(term)) score += 5;
      if (component.name.toLowerCase().includes(term)) score += 4;
      if (component.capabilities.some((c) => c.includes(term))) score += 3;
      if (haystack.includes(term)) score += 1;
    }
    return { component, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.component);
}

/** A compact catalog description for the agent's system prompt. */
export function catalogSummary(): string {
  const functional = catalog()
    .map(
      (c) =>
        `- ${c.id} — "${c.name}": ${c.blurb} capabilities: ${c.capabilities.join(", ")}. props: ${Object.keys(c.props).join(", ") || "none"}`,
    )
    .join("\n");

  const statics = STATIC_SECTIONS.map((s) => `- ${s.id} — "${s.name}": ${s.blurb}`).join("\n");

  const layouts = LAYOUT_SECTIONS.map(
    (s) =>
      `- ${s.id} — "${s.name}": ${s.blurb} defaults: ${JSON.stringify(s.defaults)}`,
  ).join("\n");

  return `APPROVED FUNCTIONAL COMPONENTS (source: ${registry.package.name}@${registry.package.version})\n${functional}\n\nSTATIC SECTIONS (renderer-owned, content only, no functional behaviour)\n${statics}\n\nLAYOUT CONTAINERS (source: "layout" — hold other sections in "children", nest up to 4 deep)\n${layouts}\nContainer props: direction, columns, gap, align, justify, wrap, padding, maxWidth, background, stackBelow, reverseOnMobile. Per-child placement goes on the child's "layout": span, grow, basis, align, order.`;
}
