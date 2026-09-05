/**
 * The shared vocabulary of the design fidelity review.
 *
 * This is the contract three layers agree on — the capture layer that produces
 * the evidence, the comparison that produces the verdicts, and the screen an
 * administrator approves on — so it holds types and nothing else. Anything with
 * behaviour would drag one of those layers into the other two.
 *
 * The review is deliberately not a pixel-equality gate. summarize.ts flattens
 * the design into bands and throws the geometry away on purpose, and the
 * preview renders the real approved zm-careers-lib components, which have their
 * own fixed markup and cannot look like a rectangle a designer drew. So the
 * exact axes — coverage, order, tokens — are the ones with verdicts, and the
 * visual axis is evidence for a human rather than a judgement about them.
 */

export type BandVerdict =
  | "matched"          // a section exists for this band
  | "low-confidence"   // matched, but the analysis was unsure (< 0.6)
  | "missing"          // the design has this band, the site does not
  | "extra"            // the site has a section with no band behind it
  | "unbuilt";         // matched, but the preview does not render this type yet

export interface BandComparison {
  ref: string;              // Figma node id — the join key ("" for extras)
  designName: string;       // Figma layer name, e.g. "Frame 12"
  designHeightPx: number;
  sectionId: string;        // "" when missing
  sectionLabel: string;
  verdict: BandVerdict;
  confidence?: number;      // from origin.confidence
  designIndex: number;      // order in the design, -1 if absent
  builtIndex: number;       // order in the built page, -1 if absent
  visualScore?: number;     // 0..1, only when both images were captured
  notes: string[];          // reviewer-facing, one short line each
}

export interface TokenComparison {
  name: string;             // "primary colour", "heading font", "radius"
  design: string;
  built: string;
  match: boolean;
}

export interface FidelityCapture {
  designImageUrl: string;             // "" when unavailable
  previewImageUrl: string;            // "" when unavailable
  sectionImages: Record<string, string>;  // sectionId -> asset URL
  viewportWidth: number;
  capturedAt: string;
  /** Plain-English reason the visual axis is missing. "" when it is present. */
  unavailable: string;
}

export interface FidelityReport {
  projectId: string;
  version: number;          // blueprint version reviewed
  pageId: string;
  frameId: string;
  generatedAt: string;
  bands: BandComparison[];
  tokens: TokenComparison[];
  capture: FidelityCapture;
  summary: { matched: number; total: number; blocking: number };
  approvedAt: string;       // "" until approved — the studio unlocks on this
  approvedBy: string;
}
