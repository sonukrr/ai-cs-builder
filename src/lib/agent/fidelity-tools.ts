import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { store } from "@/lib/store/store";
import { fidelity } from "@/lib/store/fidelity";
import { generateFidelityReport } from "@/lib/fidelity";
import type { BandComparison, FidelityReport, TokenComparison } from "@/lib/fidelity/types";

/**
 * The design fidelity tools.
 *
 * After an imported plan is approved the project sits in `reviewing` until an
 * administrator signs off the comparison between the Figma design and what was
 * actually built. These are the agent's half of that: it can run the
 * comparison, read the last one, and act on what they say.
 *
 * It cannot approve. The importer throws geometry away and the preview renders
 * the real approved library components, so nothing here can decide whether a
 * substituted component is an acceptable rendering of a bespoke design — only a
 * person can. An approval the agent could grant itself would not be an
 * approval, so no tool below writes `approvedAt`, and the descriptions say so
 * plainly rather than leaving the model to infer it and then tell an
 * administrator the review is done.
 */

export interface FidelityToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

function describeMissing(band: BandComparison): string {
  const position = band.designIndex >= 0 ? ` It is band ${band.designIndex + 1} in the design.` : "";
  return [
    `MISSING · "${band.designName}" (${band.ref || "no node id"}, ${Math.round(band.designHeightPx)}px tall)`,
    `    The design has this band and the built site has nothing for it.${position}`,
    `    Fix: work out what it is — search_components, or the notes below — and add it with apply_operations at that position.`,
    ...band.notes.map((note) => `    ${note}`),
  ].join("\n");
}

function describeExtra(band: BandComparison): string {
  return [
    `EXTRA · "${band.sectionLabel}" (${band.sectionId})`,
    `    The built site has this section and no band of the design maps to it.`,
    `    Fix: remove it with apply_operations, or tell the administrator why it should stay — an extra section is only wrong if nobody asked for it.`,
    ...band.notes.map((note) => `    ${note}`),
  ].join("\n");
}

function describeLowConfidence(band: BandComparison): string {
  const confidence =
    band.confidence === undefined ? "unknown confidence" : `${Math.round(band.confidence * 100)}% confident`;
  return [
    `"${band.designName}" → "${band.sectionLabel}" (${band.sectionId}) — the import was only ${confidence}.`,
    ...band.notes.map((note) => `    ${note}`),
  ].join("\n");
}

function describeOrder(band: BandComparison): string {
  return `"${band.sectionLabel}" is band ${band.designIndex + 1} in the design but sits at position ${
    band.builtIndex + 1
  } on the page.`;
}

function describeToken(token: TokenComparison): string {
  return `${token.name}: design ${token.design || "—"}, built ${token.built || "—"}${
    token.match ? "" : "  ← differs"
  }`;
}

/**
 * The report as something the model can act on.
 *
 * Ordered by what an administrator would want fixed before they look: blocking
 * first, then things to check, then evidence. Every blocking line names the
 * operation that would resolve it, because a tool result that says only "two
 * bands are missing" produces an apology rather than an edit.
 */
function renderReport(report: FidelityReport, approvedNote: string): string {
  const missing = report.bands.filter((band) => band.verdict === "missing");
  const extra = report.bands.filter((band) => band.verdict === "extra");
  const lowConfidence = report.bands.filter((band) => band.verdict === "low-confidence");
  const unbuilt = report.bands.filter((band) => band.verdict === "unbuilt");
  const outOfOrder = report.bands.filter(
    (band) =>
      band.verdict !== "missing" &&
      band.verdict !== "extra" &&
      band.designIndex >= 0 &&
      band.builtIndex >= 0 &&
      band.designIndex !== band.builtIndex,
  );
  const mismatchedTokens = report.tokens.filter((token) => !token.match);

  const lines: string[] = [
    `DESIGN FIDELITY — version ${report.version}, page "${report.pageId}" against frame "${report.frameId}".`,
    `${report.summary.matched} of ${report.summary.total} bands matched; ${report.summary.blocking} blocking.`,
    "",
  ];

  if (report.summary.blocking === 0) {
    lines.push("Nothing is blocking: every band of the design has a section and every section has a band.");
  } else {
    lines.push("BLOCKING — coverage differences. Fix these before asking the administrator to look:");
    lines.push(...missing.map(describeMissing));
    lines.push(...extra.map(describeExtra));
  }

  if (unbuilt.length > 0) {
    lines.push(
      "",
      "MATCHED BUT NOT RENDERED — the section exists in the blueprint and the preview has nothing for its type yet. Say so rather than claiming the design is reproduced:",
      ...unbuilt.map((band) => `  "${band.sectionLabel}" (${band.sectionId})`),
    );
  }

  if (lowConfidence.length > 0) {
    lines.push(
      "",
      "LOW CONFIDENCE — matched, but the import was unsure it read the band correctly. Not blocking; worth checking the mapping is what the designer meant:",
      ...lowConfidence.map((band) => `  ${describeLowConfidence(band)}`),
    );
  }

  if (outOfOrder.length > 0) {
    lines.push(
      "",
      "OUT OF ORDER — matched, but the page reads in a different sequence than the design. move_section fixes these:",
      ...outOfOrder.map((band) => `  ${describeOrder(band)}`),
    );
  }

  lines.push("", "DESIGN TOKENS:");
  if (report.tokens.length === 0) {
    lines.push("  none were extracted from this design.");
  } else {
    lines.push(...report.tokens.map((token) => `  ${describeToken(token)}`));
    if (mismatchedTokens.length > 0) {
      lines.push(
        `  ${mismatchedTokens.length} token(s) differ. update_theme sets them; propose the change rather than applying it silently, because the built value may have been chosen deliberately.`,
      );
    }
  }

  lines.push("", "VISUAL EVIDENCE:");
  if (report.capture.unavailable) {
    lines.push(
      `  Not captured — ${report.capture.unavailable}`,
      "  The review still opens without it; the administrator will be comparing on the coverage and token findings alone. Tell them what is missing and why.",
    );
  } else {
    const scored = report.bands.filter((band) => typeof band.visualScore === "number");
    lines.push(`  Captured at ${report.capture.viewportWidth}px on ${new Date(report.capture.capturedAt).toLocaleString()}.`);
    if (scored.length > 0) {
      lines.push(
        ...scored
          .slice()
          .sort((a, b) => (a.visualScore ?? 0) - (b.visualScore ?? 0))
          .map((band) => `  ${Math.round((band.visualScore ?? 0) * 100)}% — "${band.sectionLabel}" against "${band.designName}"`),
      );
    }
    lines.push(
      "  These scores are evidence for a human, never a verdict. An approved component that replaced a bespoke design block scores low by design — that is the substitution working, not a fault. Never report a low score as a failure or promise to make it higher.",
    );
  }

  lines.push("", approvedNote);
  return lines.join("\n");
}

/** The one sentence the model must not get wrong about who approves. */
function approvalNote(report: FidelityReport): string {
  if (report.approvedAt) {
    return `APPROVED by ${report.approvedBy || "an administrator"} on ${new Date(
      report.approvedAt,
    ).toLocaleString()}. The studio is open.`;
  }
  return "NOT APPROVED. The project stays in review until an administrator approves it on the fidelity review screen. You cannot approve it and must not say or imply that it is approved — offer to fix what is listed above instead.";
}

export function buildFidelityTools(context: FidelityToolContext) {
  const { projectId, onActivity } = context;

  const reviewFidelity = betaZodTool({
    name: "review_fidelity",
    description:
      "Compare the built site against the Figma design it was imported from, and report what differs: bands of the design with no section (missing) or sections with no band (extra), which are blocking; matches the import was unsure about; design tokens that disagree; and per-section visual scores where the preview could be captured. Run it after approve_plan and again after every fix, then propose real apply_operations edits for what it names. It does NOT approve anything — approval is the administrator's click on the fidelity review screen, and there is no tool that does it for them.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        const outcome = await generateFidelityReport(projectId);
        if (!outcome.ok) {
          onActivity("review_fidelity", "Could not review this project against a design");
          return `${outcome.reason} Nothing is being held up by a fidelity review here — say that plainly rather than reporting it as a failure.`;
        }

        const { report } = outcome;
        onActivity(
          "review_fidelity",
          report.summary.blocking === 0
            ? `Checked the site against the design — ${report.summary.matched}/${report.summary.total} bands matched`
            : `Checked the site against the design — ${report.summary.blocking} blocking difference(s)`,
        );
        return renderReport(report, approvalNote(report));
      } catch (error) {
        // A check that cannot run is a fact about this deployment, not a fact
        // about the design, and the difference decides what the agent then
        // tells the administrator.
        return `The fidelity comparison could not be run: ${
          error instanceof Error ? error.message : String(error)
        }. This is a fault in the check, not a finding about the site — do not report it as a design difference. Tell the administrator what failed.`;
      }
    },
  });

  const getFidelityReportTool = betaZodTool({
    name: "get_fidelity_report",
    description:
      "Read the last design fidelity comparison without re-running it — what it found, and whether an administrator has approved it yet. Use this to answer questions about the review, or to check whether the project is still held in review, without paying for a fresh capture. Reading the report never approves it; only an administrator can do that.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        const project = await store.getProject(projectId);
        if (!project) return "This project does not exist.";
        if (project.entryPoint !== "figma") {
          return "This project was started from the approved base site rather than a design, so there is nothing to review it against and it is not held behind a fidelity review.";
        }

        const report = await fidelity.get(projectId);
        if (!report) {
          onActivity("get_fidelity_report", "Looked for a fidelity report — none had been run");
          return "No fidelity comparison has been run for this project yet. Call review_fidelity to produce one.";
        }

        const stale =
          project.currentVersion !== report.version
            ? `\n\nThis report is for version ${report.version}; the site is now on version ${project.currentVersion}. Re-run review_fidelity so the administrator approves what actually exists.`
            : "";

        onActivity(
          "get_fidelity_report",
          report.approvedAt
            ? `Read the fidelity report (approved)`
            : `Read the fidelity report (${report.summary.blocking} blocking difference(s), awaiting approval)`,
        );
        return `${renderReport(report, approvalNote(report))}${stale}`;
      } catch (error) {
        return `The stored fidelity report could not be read: ${
          error instanceof Error ? error.message : String(error)
        }. Try review_fidelity, which regenerates it.`;
      }
    },
  });

  return [reviewFidelity, getFidelityReportTool];
}
