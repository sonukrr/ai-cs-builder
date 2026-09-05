import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FidelityReport } from "@/lib/fidelity/types";

/**
 * A project's design fidelity report.
 *
 * One report per project, overwritten each time it is regenerated. Keeping a
 * history would suggest the old ones still mean something, and they do not: a
 * report is a statement about one blueprint version against one design, and the
 * moment either moves the previous answer is worth nothing. What has to survive
 * is the approval — `approvedAt` is the flag the studio unlocks on — so
 * regenerating deliberately clears it, and an administrator has to look again.
 */

const ROOT = process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), ".data", "projects");

const BandComparison = z.object({
  ref: z.string().default(""),
  designName: z.string().default(""),
  designHeightPx: z.number().default(0),
  sectionId: z.string().default(""),
  sectionLabel: z.string().default(""),
  verdict: z.enum(["matched", "low-confidence", "missing", "extra", "unbuilt"]),
  confidence: z.number().optional(),
  designIndex: z.number().default(-1),
  builtIndex: z.number().default(-1),
  visualScore: z.number().optional(),
  notes: z.array(z.string()).default([]),
});

const TokenComparison = z.object({
  name: z.string(),
  design: z.string().default(""),
  built: z.string().default(""),
  match: z.boolean(),
});

const FidelityCapture = z.object({
  designImageUrl: z.string().default(""),
  previewImageUrl: z.string().default(""),
  sectionImages: z.record(z.string(), z.string()).default({}),
  viewportWidth: z.number().default(0),
  capturedAt: z.string().default(""),
  unavailable: z.string().default(""),
});

const StoredReport = z.object({
  projectId: z.string(),
  version: z.number(),
  pageId: z.string().default(""),
  frameId: z.string().default(""),
  generatedAt: z.string(),
  bands: z.array(BandComparison).default([]),
  tokens: z.array(TokenComparison).default([]),
  capture: FidelityCapture,
  summary: z.object({ matched: z.number(), total: z.number(), blocking: z.number() }),
  approvedAt: z.string().default(""),
  approvedBy: z.string().default(""),
});

function reportPath(projectId: string): string {
  return path.join(ROOT, projectId, "fidelity.json");
}

export const fidelity = {
  async get(projectId: string): Promise<FidelityReport | null> {
    try {
      const parsed = StoredReport.safeParse(JSON.parse(await readFile(reportPath(projectId), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async save(projectId: string, report: FidelityReport): Promise<FidelityReport> {
    const record = StoredReport.parse({ ...report, projectId });
    await mkdir(path.dirname(reportPath(projectId)), { recursive: true });
    await writeFile(reportPath(projectId), JSON.stringify(record, null, 2), "utf8");
    return record;
  },

  /**
   * Records that a named human looked at the evidence and accepted it.
   *
   * The stamp goes on the report rather than on the project because the project
   * only carries a status, and a status cannot say *which* comparison was
   * approved. Pairing `approvedAt` with the report's `version` is what makes
   * the approval auditable after the site has moved on.
   */
  async approve(projectId: string, approvedBy: string): Promise<FidelityReport | null> {
    const report = await fidelity.get(projectId);
    if (!report) return null;
    return fidelity.save(projectId, {
      ...report,
      approvedAt: new Date().toISOString(),
      approvedBy: approvedBy || "company-admin",
    });
  },
};
