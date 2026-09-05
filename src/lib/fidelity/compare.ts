import type { Blueprint, Section } from "@/lib/blueprint/schema";
import type { SitePlan } from "@/lib/agent/analyze";
import type { DesignSummary } from "@/lib/providers/figma/summarize";
import type { DesignStyles } from "@/lib/providers/figma/types";
import { getComponent } from "@/lib/registry";
import type {
  BandComparison,
  BandVerdict,
  FidelityCapture,
  FidelityReport,
  TokenComparison,
} from "./types";

/**
 * Compares what was built against what was designed.
 *
 * Every imported section carries `origin.ref` — the Figma node id the analysis
 * read it out of — so the join between a design band and a built section is
 * exact rather than a second round of guessing. Nothing here re-infers what a
 * band was; it only asks whether the thing the analysis promised is present,
 * in the right place, rendering, and wearing the design's colours.
 *
 * This module is deliberately pure and image-free: capture, PNG decoding and
 * per-band scoring all happen elsewhere and arrive as arguments, which is what
 * lets the whole comparison be exercised in a test with three objects and no
 * browser.
 */

/** Below this the analysis said, in effect, "check my working". */
const LOW_CONFIDENCE = 0.6;

export interface CompareInput {
  projectId: string;
  /** The approved plan — `store.getPlan()` returns this alongside its meta. */
  plan: SitePlan;
  /**
   * The `meta` the import stored with the plan. Read tolerantly: it is a
   * `Record<string, unknown>` that has grown fields over time, and a project
   * imported before the design summary was kept there must still review.
   */
  meta?: Record<string, unknown>;
  blueprint: Blueprint;
  capture: FidelityCapture;
  /**
   * sectionId -> 0..1, from comparing the captured images. Optional because a
   * report is still produced when every capture failed — an administrator must
   * never be stuck behind a missing browser.
   */
  visualScores?: Record<string, number>;
  /** Which page to review. Defaults to the plan's first page. */
  pageId?: string;
}

export function compareToDesign(input: CompareInput): FidelityReport {
  const { plan, blueprint, capture } = input;

  const planPage =
    (input.pageId ? plan.pages.find((page) => page.id === input.pageId) : undefined) ??
    plan.pages[0];
  const builtPage =
    (planPage ? blueprint.pages.find((page) => page.id === planPage.id) : undefined) ??
    blueprint.pages[0];

  const frameId = planPage?.figmaFrameId ?? "";
  const evidence = readDesignEvidence(input.meta);
  const designBands = designBandsFor(evidence.summary, frameId, planPage);

  // A container's children are as much part of the built page as its siblings,
  // and an admin who tidied three imported sections into a row has not removed
  // them. Flattening in tree order keeps them joinable and keeps the built
  // ordering readable.
  const builtSections = flatten(builtPage?.sections ?? []);

  const claims = new Map<string, { section: Section; index: number }[]>();
  for (const [index, section] of builtSections.entries()) {
    const ref = section.origin?.ref ?? "";
    if (!ref) continue;
    claims.set(ref, [...(claims.get(ref) ?? []), { section, index }]);
  }

  const bands: BandComparison[] = designBands.map((band) =>
    compareBand(band, claims.get(band.ref), input.visualScores),
  );

  const claimedByABand = new Set(designBands.map((band) => band.ref));
  for (const [index, section] of builtSections.entries()) {
    if (!isExtra(section, claimedByABand)) continue;
    bands.push({
      ref: section.origin?.ref ?? "",
      designName: "",
      designHeightPx: 0,
      sectionId: section.id,
      sectionLabel: section.label || section.type,
      verdict: "extra",
      confidence: section.origin?.confidence,
      designIndex: -1,
      builtIndex: index,
      notes: [
        `Claims design node ${section.origin?.ref}, which is not a band in this frame — the design may have moved on since the import.`,
      ],
    });
  }

  const tokens = compareTokens(plan, blueprint, evidence.styles);

  // `total` counts the design's bands, so the headline reads "8 of 10 bands are
  // in the built site"; an extra is a fault of the site, not an eleventh band.
  const total = bands.filter((band) => band.verdict !== "extra").length;
  const matched = bands.filter(
    (band) => band.verdict !== "extra" && band.verdict !== "missing",
  ).length;
  // Low confidence and a poor visual score are things for a human to look at,
  // never things that hold the gate shut. Only presence is pass/fail.
  const blocking = bands.filter(
    (band) => band.verdict === "missing" || band.verdict === "extra",
  ).length;

  return {
    projectId: input.projectId,
    version: blueprint.version,
    pageId: builtPage?.id ?? planPage?.id ?? "",
    frameId,
    generatedAt: new Date().toISOString(),
    bands,
    tokens,
    capture,
    summary: { matched, total, blocking },
    approvedAt: "",
    approvedBy: "",
  };
}

/* -------------------------------------------------------------------------- */
/* Coverage and order                                                          */
/* -------------------------------------------------------------------------- */

/** One band of the design, however we were able to recover it. */
interface DesignBandRef {
  ref: string;
  name: string;
  heightPx: number;
  index: number;
  /** The section the analysis said this band should become, if it said one. */
  planned: string;
}

function compareBand(
  band: DesignBandRef,
  claimants: { section: Section; index: number }[] | undefined,
  visualScores: Record<string, number> | undefined,
): BandComparison {
  const notes: string[] = [];

  if (!claimants || claimants.length === 0) {
    notes.push(
      band.planned
        ? `The plan read this band as “${band.planned}”, and no section in the built page came from it.`
        : "The design analysis never mapped this band to a section.",
    );
    return {
      ref: band.ref,
      designName: band.name,
      designHeightPx: band.heightPx,
      sectionId: "",
      sectionLabel: "",
      verdict: "missing",
      designIndex: band.index,
      builtIndex: -1,
      notes,
    };
  }

  const { section, index } = claimants[0];
  if (claimants.length > 1) {
    notes.push(
      `${claimants.length} sections were built from this one band; only “${section.label || section.id}” is compared here.`,
    );
  }

  const confidence = section.origin?.confidence;
  const unsure = confidence !== undefined && confidence < LOW_CONFIDENCE;
  const unbuilt = !previewRenders(section);

  // A section the preview cannot render is the more actionable fault of the
  // two, so it takes the verdict and the confidence goes in a note rather than
  // the other way round.
  let verdict: BandVerdict = "matched";
  if (unbuilt) {
    verdict = "unbuilt";
    notes.push(
      `The preview has no binding for “${section.type}” yet, so this band shows as a placeholder. It is still emitted into the built site.`,
    );
    if (unsure) notes.push(`The analysis was ${Math.round((confidence ?? 0) * 100)}% confident of this reading.`);
  } else if (unsure) {
    verdict = "low-confidence";
    notes.push(
      `The analysis was only ${Math.round((confidence ?? 0) * 100)}% confident that this band is a “${section.label || section.type}”.`,
    );
  }

  if (index !== band.index) {
    notes.push(
      `Order differs — band ${band.index + 1} in the design, section ${index + 1} in the built page.`,
    );
  }

  const visualScore = visualScores?.[section.id];

  return {
    ref: band.ref,
    designName: band.name,
    designHeightPx: band.heightPx,
    sectionId: section.id,
    sectionLabel: section.label || section.type,
    verdict,
    confidence,
    designIndex: band.index,
    builtIndex: index,
    visualScore: Number.isFinite(visualScore) ? visualScore : undefined,
    notes,
  };
}

/**
 * Whether a built section counts against the site as an extra.
 *
 * Only a section that claims a Figma node the frame does not have qualifies.
 * An administrator who adds a benefits block the day after the import has
 * improved the site, not broken fidelity with it, so anything the agent or the
 * admin created — and anything from an import with no node behind it, which is
 * how the analysis records a section it proposed rather than read — is left
 * out of the count entirely.
 */
function isExtra(section: Section, claimedByABand: Set<string>): boolean {
  const origin = section.origin;
  if (!origin || origin.kind !== "figma") return false;
  if (!origin.ref) return false;
  return !claimedByABand.has(origin.ref);
}

/**
 * Whether the Angular preview actually renders a section of this type.
 *
 * section-host.component.html carries one `ngSwitchCase` per approved component
 * an admin can place directly and falls through to a "this preview does not
 * render it yet" box for everything else. That set is exactly the approved
 * components with an empty `composedBy` — `job-card` has no case of its own
 * because `job-listing` renders it internally — so deriving it from the
 * registry keeps the two in step instead of leaving a second list here to fall
 * out of date the first time the library gains a component.
 */
function previewRenders(section: Section): boolean {
  if (section.source !== "zm-careers-lib") return true;
  const component = getComponent(section.type);
  return component?.status === "approved" && component.composedBy.length === 0;
}

function flatten(sections: Section[], out: Section[] = []): Section[] {
  for (const section of sections) {
    out.push(section);
    flatten(section.children, out);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The design side                                                             */
/* -------------------------------------------------------------------------- */

export interface DesignEvidence {
  summary: DesignSummary | null;
  styles: DesignStyles | null;
  /** Persisted frame renders from `DesignDocument.images`, keyed by node id. */
  images: Record<string, string>;
}

/**
 * Recovers whatever the import kept about the design itself.
 *
 * `savePlan` takes an open `Record<string, unknown>` for its meta, so this
 * cannot be a `parse` that throws: a plan written before the summary was stored
 * there is a normal, reviewable project and not a corrupt one. Both keys are
 * checked because "summary" is the natural name and "designSummary" is the
 * unambiguous one, and it costs one line to accept either.
 */
export function readDesignEvidence(meta: Record<string, unknown> | undefined): DesignEvidence {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = meta?.[key];
      if (value && typeof value === "object") return value;
    }
    return undefined;
  };

  const summaryCandidate = pick("designSummary", "summary") as DesignSummary | undefined;
  const summary = Array.isArray(summaryCandidate?.frames) ? summaryCandidate : null;

  const stylesCandidate = (pick("designStyles", "styles") ??
    (summary as { styles?: unknown } | null)?.styles) as DesignStyles | undefined;
  const styles =
    Array.isArray(stylesCandidate?.colors) && Array.isArray(stylesCandidate?.text)
      ? stylesCandidate
      : null;

  const imagesCandidate = pick("designImages", "images") as Record<string, unknown> | undefined;
  const images = Object.fromEntries(
    Object.entries(imagesCandidate ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );

  return { summary, styles, images };
}

/**
 * The bands to compare against, best evidence first.
 *
 * The stored design summary is the better source because it holds every band of
 * the frame — including ones the analysis looked at and mapped to nothing,
 * which are exactly the omissions a reviewer wants to catch. Where it is absent
 * the plan's own sections stand in: that still catches a section dropped by
 * registry repair or deleted after approval, which is the majority of what goes
 * wrong, and it is a great deal more useful than refusing to produce a report.
 */
function designBandsFor(
  summary: DesignSummary | null,
  frameId: string,
  planPage: SitePlan["pages"][number] | undefined,
): DesignBandRef[] {
  const plannedByRef = new Map(
    (planPage?.sections ?? [])
      .filter((section) => section.figmaNodeId)
      .map((section) => [section.figmaNodeId, section.label || section.type] as const),
  );

  const frame =
    summary?.frames.find((candidate) => candidate.id === frameId) ??
    // A single-frame import is the common case and its frame id is not always
    // carried through the plan, so do not lose the summary over a blank key.
    (summary?.frames.length === 1 ? summary.frames[0] : undefined);

  if (frame) {
    return frame.bands.map((band, index) => ({
      ref: band.nodeId,
      name: band.layerName,
      heightPx: band.heightPx,
      index,
      planned: plannedByRef.get(band.nodeId) ?? "",
    }));
  }

  return (planPage?.sections ?? [])
    .filter((section) => section.figmaNodeId)
    .map((section, index) => ({
      ref: section.figmaNodeId,
      name: section.label || section.type,
      // The summary is what knows how tall a band was; without it, saying zero
      // is honest and the review screen can show nothing rather than a made-up
      // number.
      heightPx: 0,
      index,
      planned: section.label || section.type,
    }));
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compares the design's theme against the one the site is actually wearing.
 *
 * The design side is the plan's tokens — the analysis's reading of the file's
 * styles — and the built side is what the blueprint applies, so this catches a
 * token an admin changed after import as well as one the build never picked up.
 * Where the raw `DesignStyles` survived the import it adds two coverage rows on
 * top, which is the check the plan tokens cannot make: whether the colours and
 * fonts the site ended up with appear anywhere in the design file at all.
 */
function compareTokens(
  plan: SitePlan,
  blueprint: Blueprint,
  styles: DesignStyles | null,
): TokenComparison[] {
  const built = blueprint.company.brand.tokens;

  const rows: TokenComparison[] = [
    colorRow("primary colour", plan.tokens.primary, built.colors.primary),
    colorRow("secondary colour", plan.tokens.secondary, built.colors.secondary),
    colorRow("accent colour", plan.tokens.accent, built.colors.accent ?? ""),
    colorRow("background colour", plan.tokens.background, built.colors.background),
    colorRow("text colour", plan.tokens.text, built.colors.text),
    fontRow("heading font", plan.tokens.headingFont, built.fonts.heading),
    fontRow("body font", plan.tokens.bodyFont, built.fonts.body),
    exactRow("corner radius", `${plan.tokens.radius}px`, `${built.radius}px`),
    exactRow("spacing unit", `${plan.tokens.spacing}px`, `${built.spacing}px`),
    exactRow("button style", plan.tokens.buttonStyle, built.buttonStyle),
  ];

  if (styles && styles.colors.length > 0) {
    const palette = new Set(styles.colors.map((color) => normalizeHex(color.hex)));
    const applied = [
      built.colors.primary,
      built.colors.secondary,
      built.colors.accent ?? "",
      built.colors.background,
      built.colors.text,
    ].filter(Boolean);
    const found = applied.filter((hex) => palette.has(normalizeHex(hex)));
    rows.push({
      // `collectStyles` counts real usage and keeps the twelve most used, so
      // "not in the palette" means the site is wearing a colour that is barely
      // anywhere in the design — which is worth a look — rather than one the
      // designer forgot to publish as a style.
      name: "palette coverage",
      design: `${styles.colors.length} most-used colour${styles.colors.length === 1 ? "" : "s"} in the design`,
      built: `${found.length} of ${applied.length} applied colours are among them`,
      match: found.length === applied.length,
    });
  }

  if (styles && styles.text.length > 0) {
    const families = [...new Set(styles.text.map((style) => normalizeFont(style.fontFamily)))].filter(
      Boolean,
    );
    const used = [built.fonts.heading, built.fonts.body].map(normalizeFont);
    rows.push({
      name: "font coverage",
      design: families.join(", "),
      built: `${built.fonts.heading} heading / ${built.fonts.body} body`,
      match: used.every((font) => families.includes(font)),
    });
  }

  return rows;
}

function colorRow(name: string, design: string, built: string): TokenComparison {
  if (!design.trim()) return { name, design: "not specified", built, match: true };
  return { name, design, built, match: normalizeHex(design) === normalizeHex(built) };
}

function fontRow(name: string, design: string, built: string): TokenComparison {
  if (!design.trim()) return { name, design: "not specified", built, match: true };
  return { name, design, built, match: normalizeFont(design) === normalizeFont(built) };
}

function exactRow(name: string, design: string, built: string): TokenComparison {
  return { name, design, built, match: design.trim().toLowerCase() === built.trim().toLowerCase() };
}

/**
 * Figma and the blueprint disagree about how to write the same colour: case,
 * three-digit shorthand and a trailing `ff` for "fully opaque" are all things
 * one side does and the other does not, and none of them is a difference an
 * administrator should be asked to look at.
 */
function normalizeHex(value: string): string {
  const hex = value.trim().toLowerCase().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((channel) => channel + channel)
          .join("")
      : hex;
  return full.length === 8 && full.endsWith("ff") ? full.slice(0, 6) : full;
}

/**
 * Font names arrive as a Figma family ("Inter"), as something quoted, or as a
 * whole CSS stack once a token has been through a renderer. Only the first
 * family is the design decision; the rest is fallback.
 */
function normalizeFont(value: string): string {
  return (value.split(",")[0] ?? "")
    .replace(/["']/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
