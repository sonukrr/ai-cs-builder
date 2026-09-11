import type { Blueprint, Section } from "./schema";

/**
 * The career site every base project starts as.
 *
 * A project used to begin empty and wait for the agent to invent a layout,
 * which made the first preview both slow and different every time. This is the
 * baseline instead: a complete, routable site the administrator can look at
 * immediately and the agent then *adjusts* rather than assembles.
 *
 * Everything here is deliberately ordinary blueprint — sections, props, content
 * and layout containers, nothing special-cased — so every part of it can be
 * changed by the same operations that change any other site. The agent moves a
 * section, rewrites copy or swaps an image on this site exactly as it would on
 * an imported one.
 *
 * WHY THE ROUTES LOOK LIKE THIS. The job routes are not a style choice; they
 * are the contract `zm-careers-lib` publishes through its own components:
 *
 *   lib-jobs-list  emits (jobURL) as "<slug>?id=<n>" and navigates nowhere —
 *                  routing is the host application's job, which is why the
 *                  Angular emitter binds that output.
 *   lib-job-view   reads the job id from queryParams['id'].
 *   lib-job-apply  reads route.snapshot.paramMap.get('jobUrl').
 *
 * So the detail page is `/jobs/:jobUrl` and the id rides in the query. Naming
 * that parameter anything else — `:id`, say — silently breaks the apply flow,
 * because the library looks it up by name.
 */

export interface DefaultSiteInput {
  projectId: string;
  companyName: string;
  tagline?: string;
}

/**
 * A branded placeholder from the studio's own generator.
 *
 * Deterministic, needs no credentials, and survives publishing: both emitters
 * copy these into the generated repository as real files. Real photography
 * replaces them through `set_section_image` whenever the company has any.
 */
function placeholder(input: {
  width: number;
  height: number;
  label: string;
  background: string;
  foreground: string;
}): string {
  const query = new URLSearchParams({
    w: String(input.width),
    h: String(input.height),
    label: input.label,
    bg: input.background,
    fg: input.foreground,
  });
  return `/api/placeholder?${query.toString()}`;
}

/**
 * The palette.
 *
 * A near-black heading colour with one saturated accent, on white with a cool
 * off-white for tinted bands — the arrangement most company career sites
 * converge on, and one that keeps text contrast well clear of the AA threshold
 * whatever the accent is later changed to.
 */
const COLORS = {
  primary: "#0F172A",
  secondary: "#475569",
  accent: "#2563EB",
  background: "#FFFFFF",
  surface: "#F8FAFC",
  text: "#0F172A",
  muted: "#64748B",
  border: "#E2E8F0",
} as const;

/** Every section carries these; spelled out once rather than at each site. */
function section(input: Partial<Section> & Pick<Section, "id" | "type" | "category" | "source">): Section {
  return {
    label: "",
    props: {},
    content: {},
    visible: true,
    children: [],
    origin: { kind: "base", ref: "default-site", confidence: 1, note: "" },
    ...input,
  } as Section;
}

/** The header, repeated per page because a blueprint page owns its own sections. */
function header(id: string): Section {
  return section({
    id,
    type: "nav",
    category: "static",
    source: "custom",
    label: "Header",
    content: { showLogo: "true", sticky: "true" },
  });
}

function footer(id: string, companyName: string): Section {
  return section({
    id,
    type: "footer",
    category: "static",
    source: "custom",
    label: "Footer",
    content: {
      legal: `© ${new Date().getFullYear()} ${companyName}. All rights reserved.`,
    },
  });
}

export function defaultCareerSite(input: DefaultSiteInput): Blueprint {
  const company = input.companyName.trim() || "Your company";
  const tagline = input.tagline?.trim() || "Explore opportunities and find your next career move.";

  /*
    Deliberately unlabelled. A hero image is a *background* — the placeholder
    generator centres its label, and at 42% opacity behind the copy that label
    lands on top of the subhead. With no label it renders as the brand gradient
    and its diagonal pattern, which reads as a designed backdrop rather than as
    a placeholder with text on it.
  */
  const heroImage = placeholder({
    width: 1600,
    height: 900,
    label: "",
    background: COLORS.primary,
    foreground: "#FFFFFF",
  });

  const portrait = (name: string) =>
    placeholder({
      width: 480,
      height: 480,
      label: name,
      background: COLORS.accent,
      foreground: "#FFFFFF",
    });

  /*
    Written here rather than researched. The agent has web research and could
    fetch real testimonials, but somebody else's words about somebody else's
    employer are their copyright and would be a lie on this site — so the
    default ships obviously-placeholder copy that is complete enough to judge
    the layout, and the agent replaces it with the company's own.
  */
  const testimonials = [
    {
      name: "Placeholder name",
      role: "Engineering",
      quote:
        "Replace this with something one of your people actually said. Two sentences about the work and the team reads better than a paragraph about the company.",
      photo: portrait("Photo"),
      photoAlt: "",
    },
    {
      name: "Placeholder name",
      role: "Design",
      quote:
        "A second voice from a different team. Naming the team and how long they have been here makes a testimonial believable.",
      photo: portrait("Photo"),
      photoAlt: "",
    },
    {
      name: "Placeholder name",
      role: "Customer success",
      quote:
        "A third keeps the row balanced. Ask the assistant to swap these for real quotes and photographs once you have them.",
      photo: portrait("Photo"),
      photoAlt: "",
    },
  ];

  const home = {
    id: "home",
    name: "Home",
    path: "/",
    seo: {
      title: `Careers at ${company}`,
      description: tagline,
    },
    sections: [
      header("home-header"),
      section({
        id: "home-hero",
        type: "hero",
        category: "static",
        source: "custom",
        label: "Hero banner",
        content: {
          headline: `Build your career at ${company}`,
          subhead: tagline,
          ctaLabel: "See open roles",
          ctaPageId: "jobs",
          image: heroImage,
          imageAlt: "",
          alignment: "left",
        },
      }),
      section({
        id: "home-testimonials",
        type: "employee-stories",
        category: "static",
        source: "custom",
        label: "Testimonials",
        content: {
          headline: "What it is like to work here",
          items: testimonials,
        },
      }),
      footer("home-footer", company),
    ],
  };

  /*
    The jobs page: facets on the left, search above the results on the right.
    A row container with a fixed-basis sidebar and a growing main column — the
    facet column asks for 300px and nothing else, so it settles there while the
    listing takes the rest, and below 900px the container stacks.
  */
  const jobs = {
    id: "jobs",
    name: "Jobs",
    path: "/jobs",
    seo: { title: `Open roles at ${company}`, description: `Search and filter every open role at ${company}.` },
    sections: [
      header("jobs-header"),
      section({
        id: "jobs-layout",
        type: "row",
        category: "layout",
        source: "layout",
        label: "Filters and results",
        props: {
          direction: "row",
          gap: 32,
          align: "start",
          padding: 32,
          maxWidth: 1240,
          stackBelow: 900,
          wrap: true,
        },
        children: [
          section({
            id: "jobs-filters",
            type: "job-filters",
            category: "functional",
            source: "zm-careers-lib",
            label: "Filter jobs",
            props: { label: "Filter roles", isClearAll: true },
            layout: { basis: "300px" },
          }),
          section({
            id: "jobs-results",
            type: "stack",
            category: "layout",
            source: "layout",
            label: "Search and results",
            props: { direction: "column", gap: 16 },
            layout: { grow: 1 },
            children: [
              section({
                id: "jobs-search",
                type: "job-search",
                category: "functional",
                source: "zm-careers-lib",
                label: "Search jobs",
                props: {
                  placeholder: "Search by title, skill or location",
                  showSearchButton: true,
                  appearance: "outline",
                },
              }),
              section({
                id: "jobs-applied-filters",
                type: "filter-chips",
                category: "functional",
                source: "zm-careers-lib",
                label: "Applied filters",
              }),
              section({
                id: "jobs-list",
                type: "job-listing",
                category: "functional",
                source: "zm-careers-lib",
                label: "Open roles",
                props: { applyBtnText: "View role", cardClickable: true, chipsViewForSkills: true },
              }),
              section({
                id: "jobs-pagination",
                type: "pagination",
                category: "functional",
                source: "zm-careers-lib",
                label: "Page through results",
                props: { currentPage: 1 },
              }),
            ],
          }),
        ],
      }),
      footer("jobs-footer", company),
    ],
  };

  /*
    The detail page. `:jobUrl` is the library's parameter name, not a
    preference — see the note at the top of this file.
  */
  const detail = {
    id: "job-detail",
    name: "Job details",
    path: "/jobs/:jobUrl",
    seo: { title: `Role at ${company}`, description: "" },
    sections: [
      header("detail-header"),
      section({
        id: "detail-view",
        type: "job-details",
        category: "functional",
        source: "zm-careers-lib",
        label: "Role",
      }),
      footer("detail-footer", company),
    ],
  };

  return {
    projectId: input.projectId,
    version: 1,
    company: {
      name: company,
      tagline,
      brand: {
        logo: "",
        logoAlt: company,
        favicon: "",
        tokens: {
          colors: { ...COLORS },
          fonts: { heading: "Poppins", body: "Inter" },
          typeScale: [52, 36, 28, 20, 16, 14],
          radius: 12,
          spacing: 8,
          buttonStyle: "solid",
        },
      },
    },
    nav: [
      { label: "Home", pageId: "home" },
      { label: "Jobs", pageId: "jobs" },
    ],
    pages: [home, jobs, detail],
    unsupportedRequests: [],
  } as Blueprint;
}

/**
 * A site with nothing in it.
 *
 * For a project that is going to be *scraped* into existence: the agent reads a
 * page and builds what it finds, so anything seeded here would be a layout
 * nobody asked for that has to be deleted before the real one can be built —
 * and, worse, a first preview showing a site that is not theirs.
 *
 * It is still a real blueprint rather than nothing at all, because that is what
 * keeps every edit on one path: `apply_operations` validates against an
 * existing site, so a project with no blueprint would need a second way in.
 * The home page is empty, and the preview says so.
 */
export function emptyCareerSite(input: DefaultSiteInput): Blueprint {
  const company = input.companyName.trim() || "Your company";

  return {
    projectId: input.projectId,
    version: 1,
    company: {
      name: company,
      tagline: input.tagline?.trim() ?? "",
      brand: {
        logo: "",
        logoAlt: company,
        favicon: "",
        tokens: {
          colors: { ...COLORS },
          fonts: { heading: "Inter", body: "Inter" },
          typeScale: [48, 32, 24, 18, 16, 14],
          radius: 8,
          spacing: 8,
          buttonStyle: "solid",
        },
      },
    },
    nav: [],
    pages: [
      {
        id: "home",
        name: "Home",
        path: "/",
        sections: [],
        seo: { title: company, description: "" },
      },
    ],
    unsupportedRequests: [],
  } as Blueprint;
}

/** One line for the version history, so the first version explains itself. */
export const EMPTY_SITE_SUMMARY = "Created an empty site, ready for the imported page";

/** One line for the version history, so the first version explains itself. */
export const DEFAULT_SITE_SUMMARY =
  "Created the standard career site: home with a hero and testimonials, a jobs page with filters and search, and a job details page";
