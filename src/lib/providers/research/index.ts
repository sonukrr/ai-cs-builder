import type { ResearchProvider, ResearchStatus } from "./types";
import { NoResearchProvider, TavilyProvider } from "./tavily";

export * from "./types";
export { TavilyProvider } from "./tavily";

/**
 * One decision about web access, made in one place.
 *
 * The orchestrator, the capability manifest and the job-data tool descriptions
 * all have to agree on which research backend is live — the tools the agent is
 * told to call have to be the tools it was actually given. They all read this.
 */

/** Research is on unless a deployment explicitly turns it off. */
export function researchEnabled(): boolean {
  return (process.env.ENABLE_RESEARCH ?? "true").toLowerCase() !== "false";
}

export function getResearchProvider(): ResearchProvider {
  if (!researchEnabled()) return new NoResearchProvider();
  if (process.env.TAVILY_API_KEY) return new TavilyProvider(process.env.TAVILY_API_KEY);
  return new NoResearchProvider();
}

export function researchStatus(): ResearchStatus {
  if (!researchEnabled()) {
    return {
      backend: "off",
      ready: false,
      detail: "Disabled by ENABLE_RESEARCH=false. Nothing in the studio reaches the open web.",
    };
  }

  if (process.env.TAVILY_API_KEY) {
    return {
      backend: "tavily",
      ready: true,
      detail:
        "Tavily search and page extraction. Results come back with the URL they came from, so researched job data is traceable to a page an administrator can open.",
    };
  }

  return {
    backend: "builtin",
    ready: true,
    detail:
      "Anthropic's built-in web search. The agent can look things up, but the page text never reaches the studio, so researched job data rests on what the model read rather than on a citable source. Set TAVILY_API_KEY for that.",
  };
}

/**
 * The research tools that exist right now, named for a tool description.
 *
 * Two backends mean two different tool names, and a description that points at
 * a tool the agent was not given is worse than no description at all.
 */
export function researchToolNames(): string {
  switch (researchStatus().backend) {
    case "tavily":
      return "research_web and read_web_page";
    case "builtin":
      return "web_search";
    default:
      return "";
  }
}
