import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { dataset, JobSeed } from "@/lib/store/dataset";

/**
 * Tools for the preview's sample job data.
 *
 * The built-in fixtures are engineering roles in London and Berlin, which makes
 * every demo look like the same company. These let the agent research what a
 * company actually hires for — using the web search it already has — and put
 * *those* roles in the preview instead. A hospital group evaluating their
 * career site should see nursing roles in their own cities.
 *
 * The division of labour matters: the agent gathers with `web_search`, then
 * calls `set_job_data` to persist. This tool does no fetching of its own, so
 * there is exactly one place in the system that reaches the open web.
 *
 * What it gathers is factual — role titles, departments, locations, the shape
 * of a hiring plan. Summaries must be written fresh; job descriptions are
 * somebody's copyright and are never reproduced.
 */

export interface DatasetToolContext {
  projectId: string;
  onActivity: (tool: string, summary: string) => void;
}

export function buildDatasetTools(context: DatasetToolContext) {
  const { projectId, onActivity } = context;

  const getJobData = betaZodTool({
    name: "get_job_data",
    description:
      "Check what sample job data the preview is currently using for this project.",
    inputSchema: z.object({}),
    run: async () => {
      onActivity("get_job_data", "Checked the preview's sample job data");
      const existing = await dataset.get(projectId);
      if (!existing) {
        return "This project has no researched job data, so the preview shows the built-in sample roles (generic engineering, design and sales positions). Offer to research realistic roles for this company if that would make the preview more useful.";
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
      "Replace the preview's sample jobs with roles that fit this company, so filters and listings show something recognisable. Research the company first with web_search, then call this. The preview must be set to 'Researched data' to show them.",
    inputSchema: z.object({
      companyName: z.string().describe("whose roles these are"),
      basedOn: z
        .string()
        .describe("where you researched this — a careers site URL, or 'general knowledge of the sector'"),
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

      return [
        `Saved ${saved.roles.length} roles for ${companyName}.`,
        `Departments: ${[...departments].join(", ")}`,
        `Locations: ${[...locations].join(" · ")}`,
        thin.length > 0 ? `Note — the filters will look thin because ${thin.join(" and ")}.` : null,
        `Tell the administrator to switch the preview's data source to "Researched" to see them.`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  return [getJobData, setJobData];
}
