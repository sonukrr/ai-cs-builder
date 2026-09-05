/**
 * Web research for the agent.
 *
 * Two operations, because they answer different questions: `search` finds the
 * pages worth reading, `extract` reads one of them properly. A careers page is
 * the case that needs both — search finds it, extract is what actually lists
 * the open roles, because a search snippet is three sentences and a job board
 * is a hundred rows.
 *
 * Behind an interface because the studio has two backends for this and they are
 * not equivalent: Tavily returns page text this process can read, parse and
 * quote a URL for, while Anthropic's server-side `web_search` searches inside
 * the model's turn and never hands the text to us. Everything that needs the
 * *content* — filling the researched job dataset — goes through here.
 *
 * What may be gathered is factual: role titles, departments, the cities a
 * company hires in, the shape of a hiring plan. Prose is not. Job descriptions
 * and careers-page copy are somebody's copyright, and the site is written fresh
 * from the facts rather than assembled out of what was read.
 */

/** One ranked hit. `content` is Tavily's extract of the page, not the page. */
export interface ResearchResult {
  title: string;
  url: string;
  /** The relevant passage(s) Tavily pulled out, already trimmed to the query. */
  content: string;
  /** 0-1 relevance. Low scores are usually the wrong company entirely. */
  score: number;
  /** Only present for `news` searches. */
  publishedDate?: string;
}

export interface ResearchAnswer {
  query: string;
  /**
   * Tavily's own one-paragraph synthesis, when asked for. A lead worth
   * following, never a citation — the URLs in `results` are the evidence.
   */
  answer?: string;
  results: ResearchResult[];
}

export interface ExtractedPage {
  url: string;
  /** Markdown of the page body. Can be very long; callers trim. */
  content: string;
}

/** Extract reports per-URL failure rather than failing the batch. */
export interface ExtractFailure {
  url: string;
  error: string;
}

export interface ExtractResult {
  pages: ExtractedPage[];
  failed: ExtractFailure[];
}

export interface SearchOptions {
  /** `advanced` costs more and reads deeper; worth it for a careers page. */
  depth: "basic" | "advanced";
  maxResults: number;
  topic: "general" | "news";
  /** Narrow to a company's own domain when the company is already known. */
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ResearchProvider {
  readonly name: "tavily" | "none";
  readonly configured: boolean;
  search(query: string, options: SearchOptions): Promise<ResearchAnswer>;
  extract(urls: string[], options: { depth: "basic" | "advanced" }): Promise<ExtractResult>;
}

/** Which backend the deployment will actually use, and whether it is on. */
export interface ResearchStatus {
  /**
   * `tavily` — real search whose text this process can read.
   * `builtin` — Anthropic's server-side web search, no page text returned.
   * `off`     — ENABLE_RESEARCH=false; nothing reaches the open web.
   */
  backend: "tavily" | "builtin" | "off";
  ready: boolean;
  detail: string;
}
