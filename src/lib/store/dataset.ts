import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * A project's sample job data.
 *
 * The preview has three data sources: the live careers API, the built-in
 * fixtures, and — this — a dataset the agent researched for the company in
 * question. The third exists because generic sample jobs make a demo feel
 * generic: an administrator at a logistics company evaluating their new career
 * site should see logistics roles in their own cities, not "Senior Backend
 * Engineer, London".
 *
 * The agent researches with web search and writes the result here. What it
 * gathers is factual — role titles, departments, the places a company hires —
 * and every description is written fresh. Job descriptions are not copied.
 */

const ROOT = process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), ".data", "projects");

export const JobSeed = z.object({
  title: z.string().min(1).max(120),
  department: z.string().min(1).max(60),
  city: z.string().min(1).max(60),
  country: z.string().min(1).max(60),
  /** Full Time, Part Time, Contract, Internship… */
  type: z.string().min(1).max(40),
  minExp: z.number().int().min(0).max(40),
  maxExp: z.number().int().min(0).max(50),
  skills: z.array(z.string().min(1).max(40)).max(8),
  /** One original sentence. Never copied from a real posting. */
  summary: z.string().min(1).max(400),
});
export type JobSeed = z.infer<typeof JobSeed>;

export const JobDataset = z.object({
  companyName: z.string().min(1).max(120),
  /** Where the agent got the shape of this from, shown in the studio. */
  basedOn: z.string().default(""),
  generatedAt: z.string(),
  roles: z.array(JobSeed).min(1).max(60),
});
export type JobDataset = z.infer<typeof JobDataset>;

function datasetPath(projectId: string): string {
  return path.join(ROOT, projectId, "job-dataset.json");
}

export const dataset = {
  async get(projectId: string): Promise<JobDataset | null> {
    try {
      const parsed = JobDataset.safeParse(JSON.parse(await readFile(datasetPath(projectId), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async save(projectId: string, input: Omit<JobDataset, "generatedAt">): Promise<JobDataset> {
    const record = JobDataset.parse({ ...input, generatedAt: new Date().toISOString() });
    await mkdir(path.dirname(datasetPath(projectId)), { recursive: true });
    await writeFile(datasetPath(projectId), JSON.stringify(record, null, 2), "utf8");
    return record;
  },

  async clear(projectId: string): Promise<void> {
    await writeFile(datasetPath(projectId), JSON.stringify({ cleared: true }), "utf8").catch(() => {});
  },
};
