import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic, MODEL } from "./client";
import { catalogSummary, getComponent, getStaticSection } from "@/lib/registry";
import { renderSummary, summarizeDesign } from "@/lib/providers/figma/summarize";
import type { DesignDocument } from "@/lib/providers/figma/types";
import { Blueprint, DesignTokens } from "@/lib/blueprint/schema";

/**
 * Step 2-5 of the Figma import: turn a compressed design into an AI Site Plan.
 *
 * The plan is deliberately a separate artefact from the blueprint. It carries
 * the model's *reasoning* — why a band was read as a job search, how confident
 * it was, what it assumed — which is what the approval screen shows the admin.
 * Only after approval does the plan become a blueprint, at which point the
 * rationale has done its job and the structure is what matters.
 *
 * 06-figma-import.md sets the fidelity bar explicitly: semantic similarity and
 * reusable architecture beat pixel-perfect conversion. The prompt below is
 * written to that bar.
 */

/**
 * Props and content vary per component, so they travel as JSON strings rather
 * than open-ended objects. Strict structured output cannot express "an object
 * with arbitrary keys", and a string we parse and then validate against the
 * registry gives us a better error than a schema rejection would.
 */
const SectionPlan = z.object({
  id: z.string().describe("kebab-case, unique across the whole site, e.g. 'hero-home'"),
  type: z.string().describe("a registry component id, or a static section id"),
  source: z.enum(["zm-careers-lib", "custom"]),
  label: z.string().describe("friendly name for the admin, e.g. 'Search Jobs'"),
  figmaNodeId: z.string().describe("the band's node id, or empty if newly proposed"),
  rationale: z.string().describe("one sentence: what in the design made you read it this way"),
  confidence: z.number().min(0).max(1),
  propsJson: z.string().describe("JSON object of settings for a library component, or {}"),
  contentJson: z.string().describe("JSON object of copy for a static section, or {}"),
});

const PagePlan = z.object({
  id: z.string().describe("kebab-case page id"),
  name: z.string(),
  path: z.string().describe("route, starting with /"),
  figmaFrameId: z.string(),
  sections: z.array(SectionPlan),
});

const SitePlanSchema = z.object({
  companyName: z.string(),
  tagline: z.string(),
  tokens: z.object({
    primary: z.string().describe("hex"),
    secondary: z.string().describe("hex"),
    accent: z.string().describe("hex"),
    background: z.string().describe("hex"),
    text: z.string().describe("hex"),
    headingFont: z.string(),
    bodyFont: z.string(),
    radius: z.number(),
    spacing: z.number(),
    buttonStyle: z.enum(["solid", "outline", "pill", "square"]),
  }),
  pages: z.array(PagePlan),
  nav: z.array(z.object({ label: z.string(), pageId: z.string() })),
  unsupported: z
    .array(z.object({ request: z.string(), reason: z.string() }))
    .describe("things the design implies that no approved component can do"),
  assumptions: z.array(z.string()).describe("guesses the admin should check"),
});

export type SitePlan = z.infer<typeof SitePlanSchema>;

const SYSTEM = `You convert career-site designs into a structured site plan.

You are given a Figma design that has been flattened into ordered "bands" — one
per top-level child of each frame — with the text inside each band, its height,
background, and structural counts (how many text nodes, images, input-shaped
rectangles, button-shaped instances, and repeated sibling groups it contains).

Read the bands semantically. Layer names are frequently meaningless ("Frame 12",
"Group 47"); the text and the structural counts are the reliable signals.

MAPPING RULES, in order:

1. If a band provides *functional* capability — searching, listing, filtering,
   paginating, viewing or applying to jobs, uploading a resume — it MUST map to
   an approved component from the catalog below, with source "zm-careers-lib".
   Never invent a functional component. If the design shows functionality the
   catalog does not have, put it in "unsupported" and leave it out of the pages.

2. Otherwise it is presentation. Map it to the closest static section id with
   source "custom", and carry the design's real copy into contentJson.

3. A band that is only a header or footer maps to the "nav" or "footer" static
   section. Do not repeat nav/footer on every page — put them on each page, but
   keep their content identical.

RECOGNITION GUIDE:
- One wide input-like rectangle with placeholder text about roles/jobs → job-search.
- A column of 2+ repeated rows each naming a role, a location and an apply
  action → job-listing.
- A rail of grouped checkboxes/values under headings like Department, Location,
  Experience → job-filters.
- A short row of numbers and a "Next" → pagination.
- A file drop zone mentioning CV/resume → resume-upload, and a form with name
  and email fields around it → job-apply (which already includes the upload;
  do not add both unless the design clearly shows a standalone upload block).
- 2+ repeated cards with a person's name, a role and a quotation →
  employee-stories. Quotes without names or roles → testimonials.
- 3+ short repeated blocks about perks, cover, leave, budget → benefits.
- A tall first band with one large headline and a call to action → hero.

CONTENT:
Copy the design's actual words into contentJson — headlines, body copy, item
lists, quotes, names. Do not paraphrase and do not invent replacement copy. If a
static section needs a field the design does not supply, leave it out.

PROPS:
Only set props a component actually declares. Prefer setting the ones that carry
the design's intent (placeholder text, button labels, layout switches) and leave
the rest at their defaults.

IDS:
Every page id and section id must be unique across the entire site and be
lowercase kebab-case.

CONFIDENCE:
Be honest. A band you matched from strong structural evidence is 0.8-0.95. A
plausible reading of ambiguous content is 0.4-0.6. Anything you are guessing at
is below 0.4 and belongs in "assumptions" too.`;

export interface AnalyzeResult {
  plan: SitePlan;
  /** Sections dropped because they failed registry validation, with why. */
  dropped: { section: string; reason: string }[];
}

/** Runs the semantic analysis and repairs anything that violates the registry. */
export async function analyzeDesign(design: DesignDocument): Promise<AnalyzeResult> {
  const summary = summarizeDesign(design);

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(SitePlanSchema) },
    system: [
      { type: "text", text: SYSTEM },
      // The catalog is stable across every import, so it caches.
      { type: "text", text: catalogSummary(), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: renderSummary(summary) }],
  });

  const plan = response.parsed_output;
  if (!plan) {
    throw new Error("The design analysis did not return a usable site plan. Try importing again.");
  }

  return repairPlan(plan);
}

/**
 * Enforces the registry against the model's output.
 *
 * The prompt asks for approved components only; this makes it true. A section
 * naming a component that does not exist is dropped rather than passed on to
 * the blueprint, because a plan the admin approves must be one we can actually
 * build.
 */
function repairPlan(plan: SitePlan): AnalyzeResult {
  const dropped: AnalyzeResult["dropped"] = [];
  const usedIds = new Set<string>();

  const slug = (value: string, fallback: string) => {
    const base =
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || fallback;
    let candidate = base;
    let n = 2;
    while (usedIds.has(candidate)) candidate = `${base}-${n++}`;
    usedIds.add(candidate);
    return candidate;
  };

  const pages = plan.pages.map((page, pageIndex) => {
    const pageId = slug(page.id || page.name, `page-${pageIndex + 1}`);

    const sections = page.sections.flatMap((section) => {
      if (section.source === "zm-careers-lib") {
        const component = getComponent(section.type);
        if (!component || component.status !== "approved") {
          dropped.push({
            section: section.label || section.type,
            reason: `"${section.type}" is not an approved component`,
          });
          return [];
        }
        if (component.composedBy.length > 0) {
          dropped.push({
            section: section.label || section.type,
            reason: `"${component.name}" is rendered inside ${component.composedBy.join(", ")} and is not placed directly`,
          });
          return [];
        }
        const props = parseJsonObject(section.propsJson);
        const known = Object.fromEntries(
          Object.entries(props).filter(([key]) => key in component.props),
        );
        return [
          {
            ...section,
            id: slug(section.id || section.type, `${pageId}-section`),
            label: section.label || component.name,
            props: { ...component.defaults, ...known },
            content: {},
          },
        ];
      }

      const staticDef = getStaticSection(section.type);
      if (!staticDef) {
        // Unknown static types are recoverable — render as a text block rather
        // than lose the design's copy.
        dropped.push({
          section: section.label || section.type,
          reason: `unknown section type "${section.type}"; kept as a text block`,
        });
      }
      return [
        {
          ...section,
          type: staticDef ? section.type : "rich-text",
          id: slug(section.id || section.type, `${pageId}-section`),
          label: section.label || staticDef?.name || "Text Block",
          props: {},
          content: parseJsonObject(section.contentJson),
        },
      ];
    });

    return { ...page, id: pageId, path: page.path.startsWith("/") ? page.path : `/${page.path}`, sections };
  });

  const pageIds = new Set(pages.map((p) => p.id));
  const nav = plan.nav.filter((item) => pageIds.has(item.pageId));

  return { plan: { ...plan, pages: pages as SitePlan["pages"], nav }, dropped };
}

function parseJsonObject(input: string): Record<string, unknown> {
  if (!input?.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Converts an approved plan into the blueprint that becomes the source of truth. */
export function planToBlueprint(plan: SitePlan, projectId: string): Blueprint {
  const tokens = DesignTokens.parse({
    colors: {
      primary: safeHex(plan.tokens.primary, "#111111"),
      secondary: safeHex(plan.tokens.secondary, "#666666"),
      accent: safeHex(plan.tokens.accent, "#0f62fe"),
      background: safeHex(plan.tokens.background, "#ffffff"),
      text: safeHex(plan.tokens.text, "#111111"),
    },
    fonts: { heading: plan.tokens.headingFont || "Inter", body: plan.tokens.bodyFont || "Inter" },
    radius: clamp(plan.tokens.radius, 0, 64, 8),
    spacing: clamp(plan.tokens.spacing, 0, 64, 8),
    buttonStyle: plan.tokens.buttonStyle,
  });

  return Blueprint.parse({
    projectId,
    version: 1,
    company: {
      name: plan.companyName || "Untitled Company",
      tagline: plan.tagline,
      brand: { logo: "", logoAlt: plan.companyName, favicon: "", tokens },
    },
    nav: plan.nav,
    pages: plan.pages.map((page) => ({
      id: page.id,
      name: page.name,
      path: page.path,
      seo: { title: `${page.name} — ${plan.companyName}`, description: plan.tagline },
      sections: page.sections.map((section) => ({
        id: section.id,
        type: section.type,
        category: section.source === "zm-careers-lib" ? "functional" : "static",
        source: section.source,
        label: section.label,
        props: (section as { props?: Record<string, unknown> }).props ?? {},
        content: (section as { content?: Record<string, unknown> }).content ?? {},
        visible: true,
        origin: {
          kind: "figma" as const,
          ref: section.figmaNodeId,
          confidence: section.confidence,
          note: section.rationale,
        },
      })),
    })),
    unsupportedRequests: plan.unsupported.map((u) => ({
      request: u.request,
      reason: u.reason,
      requestedAt: new Date().toISOString(),
    })),
  });
}

function safeHex(value: string, fallback: string): string {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value?.trim() ?? "")
    ? value.trim()
    : fallback;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
