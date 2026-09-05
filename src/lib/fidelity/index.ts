import type { Blueprint, Project } from "@/lib/blueprint/schema";
import type { SitePlan } from "@/lib/agent/analyze";
import { store } from "@/lib/store/store";
import { fidelity } from "@/lib/store/fidelity";
import { type CapturePreviewOptions, capturePreview } from "./capture";
import { compareToDesign, readDesignEvidence } from "./compare";
import type { FidelityCapture, FidelityReport } from "./types";

export * from "./types";
export { compareToDesign, readDesignEvidence } from "./compare";
export type { CompareInput, DesignEvidence } from "./compare";

/**
 * The design fidelity review, end to end.
 *
 * The route, the agent's `review_fidelity` tool and anything else that wants a
 * report all come through here so there is one answer to "can this project be
 * reviewed at all", one order of operations, and one place where a failed
 * capture becomes evidence rather than an exception.
 */

export interface ReviewInputs {
  project: Project;
  plan: SitePlan;
  meta: Record<string, unknown>;
  blueprint: Blueprint;
}

/**
 * Not every project has something to review, and the ones that do not are
 * ordinary rather than broken — so this answers with a sentence written for an
 * administrator to read, not an error. Callers that only want to know whether
 * the review applies (the studio deciding whether to show the gate) use it
 * without paying for a capture.
 */
export type ReviewCheck = { ok: true; inputs: ReviewInputs } | { ok: false; reason: string };

export async function checkReviewable(projectId: string): Promise<ReviewCheck> {
  const project = await store.getProject(projectId);
  if (!project) return { ok: false, reason: "No such project." };

  // A base-site project has no design behind it, so there is nothing to compare
  // against and nothing to approve. Producing an empty report for one would
  // park it behind a gate it could never pass.
  if (project.entryPoint !== "figma") {
    return {
      ok: false,
      reason:
        "This project was started from the base site rather than a Figma design, so there is nothing to review it against.",
    };
  }

  const pending = await store.getPlan(projectId);
  if (!pending) {
    return {
      ok: false,
      reason:
        "This project has no stored design plan, so there is no record of what the site was meant to be. Import the Figma design again to review it.",
    };
  }

  const blueprint = await store.getCurrentBlueprint(projectId);
  if (!blueprint) {
    return {
      ok: false,
      reason: "The site has not been built from the plan yet, so there is nothing to compare.",
    };
  }

  return { ok: true, inputs: { project, plan: pending.plan, meta: pending.meta, blueprint } };
}

export type FidelityOutcome =
  | { ok: true; report: FidelityReport }
  | { ok: false; reason: string };

/** Captures the built site, compares it to the design, and stores the result. */
export async function generateFidelityReport(projectId: string): Promise<FidelityOutcome> {
  const check = await checkReviewable(projectId);
  if (!check.ok) return check;

  const { plan, meta, blueprint } = check.inputs;
  const planPage = plan.pages[0];

  // The design half of the evidence is a frame render the import already put in
  // the asset store, looked up by the frame the page was built from. A
  // single-frame import does not always carry that id through the plan, so fall
  // back to the only render there is rather than reviewing without a reference.
  const images = readDesignEvidence(meta).images;
  const designImageUrl =
    images[planPage?.figmaFrameId ?? ""] ?? Object.values(images)[0] ?? "";

  const capture = await captureOrExplain({
    projectId,
    pageId: planPage?.id ?? "",
    designImageUrl,
  });

  const report = compareToDesign({
    projectId,
    plan,
    meta,
    blueprint,
    capture,
    visualScores: visualScoresIn(capture),
  });

  return { ok: true, report: await fidelity.save(projectId, report) };
}

/**
 * The visual axis is evidence, never a verdict, so nothing it does is allowed
 * to be fatal: a missing Chrome, a preview host nobody started and a page that
 * threw on load are all things an administrator can act on once they are told,
 * and all things that would otherwise leave them unable to open their own site.
 *
 * `capturePreview` already contracts never to throw. This catches anyway,
 * because the promise that has to hold is "a report always comes back", and
 * hanging that on another module keeping its word is how an admin ends up
 * looking at a 500 instead of their site.
 */
async function captureOrExplain(options: CapturePreviewOptions): Promise<FidelityCapture> {
  try {
    return await capturePreview(options);
  } catch (error) {
    return {
      designImageUrl: options.designImageUrl ?? "",
      previewImageUrl: "",
      sectionImages: {},
      viewportWidth: 0,
      capturedAt: new Date().toISOString(),
      unavailable: `The screenshots could not be taken: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Per-band scores travel on the capture rather than through a second export,
 * because only the capture layer knows which images it actually got. They are
 * read off it defensively so a capture that gave up early still yields a report
 * with the exact axes intact.
 */
function visualScoresIn(capture: FidelityCapture): Record<string, number> | undefined {
  const scores = (capture as { visualScores?: unknown }).visualScores;
  return scores && typeof scores === "object" ? (scores as Record<string, number>) : undefined;
}
