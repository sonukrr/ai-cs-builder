import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { dataset, JobSeed } from "@/lib/store/dataset";
import { researchStatus, researchToolNames } from "@/lib/providers/research";

/**
 * Tools for the preview's job data.
 *
 * The built-in fixtures are engineering roles in London and Berlin, which makes
 * every demo look like the same company. These let the agent research what a
 * company actually hires for and put *those* roles in the preview instead. A
 * hospital group evaluating their career site should see nursing roles in their
 * own cities.
 *
 * The division of labour matters: the research tools gather — Tavily's
 * research_web and read_web_page when a key is configured, the built-in
 * web_search otherwise — and set_job_data persists. Nothing here fetches
 * anything, so there is exactly one place in the system that reaches the open
 * web.
 *
 * What may be gathered is factual: role titles, departments, locations, the
 * shape of a hiring plan. Summaries are written fresh, because job descriptions
 * are somebody's copyright and are never reproduced. That rule is repeated in
 * the tool descriptions below rather than left in this comment, because the
 * model reads the descriptions and never reads this.
 */

export interface DatasetToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

/** Roughly: did the agent record a page it actually read, or a recollection? */
function looksLikeSource(basedOn: string): boolean {
  return /^https?:\/\/\S+$/i.test(basedOn.trim());
}

export function buildDatasetTools(context: DatasetToolContext) {
  const { projectId, onActivity } = context;

  // Named here so the descriptions point at tools this deployment actually
  // has. Telling the model to call research_web when it was handed web_search
  // is worse than saying nothing.
  const research = researchStatus();
  const tools = researchToolNames();
  const howToGather =
    research.backend === "off"
      ? "Web research is switched off in this deployment, so work from what the administrator tells you about their hiring and say that is where it came from."
      : `Research the company first with ${tools}, then call this.`;

  const getJobData = betaZodTool({
    name: "get_job_data",
    description:
      "Check which jobs the preview is showing for this project — the built-in samples, or roles researched for this company — and where the researched ones came from. Call this before offering to change them.",
    inputSchema: z.object({}),
    run: async () => {
      onActivity("get_job_data", "Checked the preview's job data");
      const existing = await dataset.get(projectId);
      if (!existing) {
        return [
          "This project has no researched job data, so the preview shows the built-in sample roles: generic engineering, design and sales positions in London and Berlin. They make every company's preview look like the same company.",
          research.backend === "off"
            ? "Web research is switched off (ENABLE_RESEARCH=false). You can still replace them with set_job_data using roles the administrator describes."
            : `You can fix that: find what this company actually hires for with ${tools}, then call set_job_data. Offer it whenever generic roles would obscure the decision the administrator is trying to make.`,
        ].join("\n");
      }
      const departments = [...new Set(existing.roles.map((role) => role.department))];
      return [
        `${existing.roles.length} roles for ${existing.companyName}${existing.basedOn ? `, researched from ${existing.basedOn}` : ""}.`,
        `Departments: ${departments.join(", ")}`,
        `Locations: ${[...new Set(existing.roles.map((r) => `${r.city}, ${r.country}`))].join(" · ")}`,
        `Saved ${new Date(existing.generatedAt).toLocaleString()}.`,
      ].join("\n");
    },
  });

  const setJobData = betaZodTool({
    name: "set_job_data",
    description:
      "Replace the preview's sample jobs with roles that fit this company, so filters and listings show something recognisable. " +
      howToGather +
      " Gather facts only — titles, departments, cities, employment type, seniority. Job description prose is the company's copyright: never paste it here. Every summary is one sentence you write yourself from the facts. The preview must be set to 'Researched data' to show them.",
    inputSchema: z.object({
      companyName: z.string().describe("whose roles these are"),
      basedOn: z
        .string()
        .describe(
          "the careers page URL you actually read, exactly as the research tool returned it — this is shown to the administrator as the provenance of the data. Only say 'general knowledge of the sector' when research genuinely found nothing.",
        ),
      roles: z
        .array(
          z.object({
            title: z.string().describe("the role title, e.g. 'Registered Nurse, Paediatrics'"),
            department: z.string().describe("keep these consistent — they become the Department filter"),
            city: z.string(),
            country: z.string(),
            type: z.string().describe("Full Time, Part Time, Contract, Internship"),
            minExp: z.number().int().min(0).max(40),
            maxExp: z.number().int().min(0).max(50),
            skills: z.array(z.string()).max(8).describe("these become the Skills filter"),
            summary: z
              .string()
              .describe("ONE original sentence about the role. Write it yourself — never copy a real posting."),
          }),
        )
        .min(3)
        .max(60)
        .describe("8-20 roles gives filters enough to bite on without being noise"),
    }),
    run: async ({ companyName, basedOn, roles }) => {
      const parsed = z.array(JobSeed).safeParse(roles);
      if (!parsed.success) {
        return `Some roles were malformed: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .slice(0, 6)
          .join("; ")}`;
      }

      // Filters that only ever have one value look broken. Say so rather than
      // letting the admin discover it by clicking.
      const departments = new Set(parsed.data.map((role) => role.department));
      const locations = new Set(parsed.data.map((role) => `${role.city}, ${role.country}`));
      const thin: string[] = [];
      if (departments.size < 2) thin.push("every role is in one department");
      if (locations.size < 2) thin.push("every role is in one location");

      const saved = await dataset.save(projectId, { companyName, basedOn, roles: parsed.data });
      onActivity("set_job_data", `Loaded ${saved.roles.length} ${companyName} roles into the preview`);

      // The studio shows basedOn as provenance. When it is not a page anyone
      // can open, the administrator should hear that from the agent rather
      // than assume these roles were read off the company's own site.
      const unsourced = research.backend !== "off" && !looksLikeSource(basedOn);

      return [
        `Saved ${saved.roles.length} roles for ${companyName}.`,
        `Departments: ${[...departments].join(", ")}`,
        `Locations: ${[...locations].join(" · ")}`,
        thin.length > 0 ? `Note — the filters will look thin because ${thin.join(" and ")}.` : null,
        unsourced
          ? `These are recorded as "${basedOn}" rather than a page you read. Tell the administrator they are representative rather than their actual openings.`
          : null,
        `Tell the administrator to switch the preview's data source to "Researched" to see them.`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  return [getJobData, setJobData];
}
