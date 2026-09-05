import { catalog, registry, STATIC_SECTIONS } from "@/lib/registry";
import { IMAGE_SLOTS } from "@/lib/providers/images/types";

export const runtime = "nodejs";

/**
 * Everything an administrator can add to a page.
 *
 * Presented in the administrator's own vocabulary, per 04-component-registry.md:
 * friendly names and plain descriptions of what each thing *does*, never the
 * internal React or Angular component name. The class name and selector stay
 * server-side where the emitter needs them.
 *
 * Grouped, because a flat list of thirty things is a wall rather than a menu.
 */

const FUNCTIONAL_GROUPS: { id: string; name: string; blurb: string; members: string[] }[] = [
  {
    id: "find",
    name: "Finding jobs",
    blurb: "How candidates search and narrow down open roles.",
    members: ["job-search", "job-filters", "filter-chips", "job-listing", "job-listing-elasticsearch", "pagination"],
  },
  {
    id: "apply",
    name: "Applying",
    blurb: "The application itself, from job detail through to confirmation.",
    members: ["job-details", "job-apply", "custom-apply", "resume-upload", "apply-confirmation"],
  },
  {
    id: "discover",
    name: "Guided discovery",
    blurb: "Helping candidates who do not know what to search for.",
    members: ["find-your-spot", "job-recommendations"],
  },
];

const STATIC_GROUPS: { id: string; name: string; blurb: string; members: string[] }[] = [
  {
    id: "intro",
    name: "Introducing the company",
    blurb: "The first impression: what you do and why it matters.",
    members: ["hero", "value-props", "culture", "stats", "media"],
  },
  {
    id: "people",
    name: "People and culture",
    blurb: "Who works here, and what it is like.",
    members: ["employee-stories", "testimonials", "teams", "locations", "benefits"],
  },
  {
    id: "practical",
    name: "Practical information",
    blurb: "What candidates ask before applying.",
    members: ["process", "faq", "rich-text", "logo-wall"],
  },
  { id: "chrome", name: "Header and footer", blurb: "Navigation around the site.", members: ["nav", "footer"] },
];

export async function GET() {
  const approved = new Map(catalog().map((component) => [component.id, component]));
  const statics = new Map(STATIC_SECTIONS.map((section) => [section.id, section]));

  const functional = FUNCTIONAL_GROUPS.map((group) => ({
    ...group,
    items: group.members
      .map((id) => approved.get(id))
      .filter((component): component is NonNullable<typeof component> => Boolean(component))
      .map((component) => ({
        id: component.id,
        name: component.name,
        blurb: component.blurb,
        kind: "functional" as const,
        source: "zm-careers-lib" as const,
        capabilities: component.capabilities,
        /** Only documented settings are offered; the rest are library internals. */
        settings: Object.entries(component.props)
          .filter(([, meta]) => meta.documented)
          .map(([name, meta]) => ({ name, description: meta.description })),
        takesImage: false,
      })),
  })).filter((group) => group.items.length > 0);

  // Anything approved that no group claims still has to be offerable, or adding
  // a component to the library would silently hide it from administrators.
  const grouped = new Set(FUNCTIONAL_GROUPS.flatMap((group) => group.members));
  const ungrouped = catalog().filter((component) => !grouped.has(component.id));
  if (ungrouped.length > 0) {
    functional.push({
      id: "other",
      name: "Other capabilities",
      blurb: "Recently added to the approved library.",
      members: ungrouped.map((c) => c.id),
      items: ungrouped.map((component) => ({
        id: component.id,
        name: component.name,
        blurb: component.blurb,
        kind: "functional" as const,
        source: "zm-careers-lib" as const,
        capabilities: component.capabilities,
        settings: Object.entries(component.props)
          .filter(([, meta]) => meta.documented)
          .map(([name, meta]) => ({ name, description: meta.description })),
        takesImage: false,
      })),
    });
  }

  const content = STATIC_GROUPS.map((group) => ({
    ...group,
    items: group.members
      .map((id) => statics.get(id))
      .filter((section): section is NonNullable<typeof section> => Boolean(section))
      .map((section) => ({
        id: section.id,
        name: section.name,
        blurb: section.blurb,
        kind: "content" as const,
        source: "custom" as const,
        capabilities: [] as string[],
        settings: Object.entries(section.contentKeys).map(([name, description]) => ({ name, description })),
        takesImage: section.id in IMAGE_SLOTS,
      })),
  })).filter((group) => group.items.length > 0);

  return Response.json({
    library: {
      name: registry.package.name,
      version: registry.package.version,
      approvedCount: catalog().length,
    },
    functional,
    content,
  });
}
