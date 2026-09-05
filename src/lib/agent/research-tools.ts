import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { getResearchProvider } from "@/lib/providers/research";

/**
 * The research tools.
 *
 * These exist only when Tavily is configured; otherwise the orchestrator hands
 * the model Anthropic's server-side `web_search` instead and none of this is
 * built. Never both — two search tools with overlapping descriptions make the
 * model choose instead of work.
 *
 * The reason to prefer these when they are available is that the page text
 * comes back *into this process*. Server-side search happens inside the model's
 * turn: it can inform an answer, but nothing downstream can quote the URL a
 * fact came from. Here the URL is in the tool result, so when the agent loads
 * researched roles into the preview it can say where it got them and an
 * administrator can go and check.
 *
 * Every tool returns a string, including on failure, so a rejected key or a
 * dead URL comes back as something the agent can act on — try another page,
 * tell the administrator what is missing — rather than as an exception that
 * ends the turn.
 */

export interface ResearchToolContext {
  onActivity: (tool: string, summary: string) => void;
}

/** What may be taken from a page, restated wherever the model will read it. */
const COPYRIGHT_RULE =
  "Take facts only: role titles, departments, cities, employment type, seniority, the shape of a hiring plan. Job descriptions and careers-page copy are somebody's copyright — never paste them into the site or into set_job_data. Write every line the site shows yourself.";

/** Enough of a snippet to judge relevance; the full page is one call away. */
const SNIPPET_CHARS = 800;
/** A careers page can be tens of thousands of words. This is the useful part. */
const PAGE_CHARS = 6_000;

function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}\n… [truncated]` : collapsed;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function buildResearchTools(context: ResearchToolContext) {
  const { onActivity } = context;

  const researchWeb = betaZodTool({
    name: "research_web",
    description:
      "Search the live web and get back ranked pages with the passage that matched and the URL it came from. Use it to find what a company actually hires for, where it has offices, how it describes itself — then cite the URL when you tell the administrator where something came from. " +
      COPYRIGHT_RULE +
      " Snippets are short by design: when a page looks like the right one, call read_web_page on its URL.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "a full question, not keywords, e.g. 'open nursing roles at Nuffield Health UK' — this is searched, not pattern-matched",
        ),
      depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe("basic is fast and usually enough; advanced reads deeper, for a careers page or a thin result set"),
      maxResults: z.number().int().min(1).max(20).optional().describe("default 8"),
      topic: z
        .enum(["general", "news"])
        .optional()
        .describe("news only for recent announcements — an expansion, a funding round, a new office"),
      includeDomains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("restrict to these domains, e.g. ['nuffieldhealth.com'] once you know the company's own site"),
      excludeDomains: z.array(z.string()).max(10).optional(),
    }),
    run: async ({ query, depth, maxResults, topic, includeDomains, excludeDomains }) => {
      const provider = getResearchProvider();
      if (!provider.configured) {
        return "Web research is not configured (TAVILY_API_KEY is missing, or ENABLE_RESEARCH=false). Tell the administrator rather than guessing at facts about their company.";
      }

      onActivity("research_web", `Searched the web for “${query}”`);

      try {
        const answer = await provider.search(query, {
          depth: depth ?? "basic",
          maxResults: maxResults ?? 8,
          topic: topic ?? "general",
          includeDomains,
          excludeDomains,
        });

        if (answer.results.length === 0) {
          return `No results for "${query}". Try the company's full legal name, or drop the qualifiers — an over-specified query returns nothing rather than something close.`;
        }

        return [
          answer.answer ? `SUMMARY (a lead, not a source — verify against the results below):\n${answer.answer}\n` : null,
          `${answer.results.length} result(s):`,
          ...answer.results.map(
            (result, index) =>
              `${index + 1}. ${result.title}\n   ${result.url}${
                result.publishedDate ? ` · ${result.publishedDate}` : ""
              } · relevance ${result.score.toFixed(2)}\n   ${clip(result.content, SNIPPET_CHARS).replace(/\n/g, "\n   ")}`,
          ),
          "",
          "A low relevance score usually means a different company with a similar name. Read the URL before you trust the row.",
        ]
          .filter(Boolean)
          .join("\n");
      } catch (error) {
        return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const readWebPage = betaZodTool({
    name: "read_web_page",
    description:
      "Read the full text of pages you already have URLs for — a careers listing, an about page, a location page. This is how you get the actual list of open roles: a search snippet is three sentences, a jobs board is a hundred rows. " +
      COPYRIGHT_RULE,
    inputSchema: z.object({
      urls: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe("URLs exactly as research_web returned them. Do not construct a careers URL by guessing at the path."),
      depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe(
          "advanced for job boards and anything that renders its list in the browser; basic for ordinary text pages",
        ),
    }),
    run: async ({ urls, depth }) => {
      const provider = getResearchProvider();
      if (!provider.configured) {
        return "Web research is not configured (TAVILY_API_KEY is missing, or ENABLE_RESEARCH=false), so pages cannot be read. Say so rather than describing a page you have not seen.";
      }

      onActivity("read_web_page", `Read ${urls.map(hostOf).join(", ")}`);

      try {
        const result = await provider.extract(urls, { depth: depth ?? "basic" });

        if (result.pages.length === 0) {
          return [
            "None of those pages could be read.",
            ...result.failed.map((failure) => `  ${failure.url} — ${failure.error}`),
            "A careers page that fails on basic depth is often JavaScript-rendered: retry with depth 'advanced'. If it still fails, search for the listings on a job board instead.",
          ].join("\n");
        }

        return [
          ...result.pages.map((page) => `--- ${page.url} ---\n${clip(page.content, PAGE_CHARS)}`),
          result.failed.length > 0
            ? `\nCould not read: ${result.failed.map((f) => `${f.url} (${f.error})`).join("; ")}`
            : null,
          "",
          COPYRIGHT_RULE,
        ]
          .filter(Boolean)
          .join("\n\n");
      } catch (error) {
        return `Could not read those pages: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  return [researchWeb, readWebPage];
}
