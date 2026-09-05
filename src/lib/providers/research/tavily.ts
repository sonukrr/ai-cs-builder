import type {
  ExtractResult,
  ResearchAnswer,
  ResearchProvider,
  SearchOptions,
} from "./types";

/**
 * Tavily — a search API built to be read by a model rather than by a person.
 *
 * Chosen over scraping because it returns the passage that answers the query
 * alongside the URL it came from, which is what makes a researched job dataset
 * checkable: every role the agent loads into the preview can be traced back to
 * a page an administrator can open. A raw HTML fetch would give us a careers
 * page as an SPA shell and nothing else.
 *
 * Nothing here is cached. Hiring changes weekly and a research call happens
 * once per conversation at most, so a stale answer would cost more than the
 * request saves.
 */

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

/** Advanced search reads more of each page and is correspondingly slower. */
const SEARCH_TIMEOUT_MS = 30_000;
/** Extract renders the page; a heavy careers site regularly needs this long. */
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Tavily's failures are mostly account state, not bugs, and the difference
 * matters to whoever has to fix it: a rejected key is a .env.local edit, an
 * exhausted plan is a billing page. Both surface as a tool result the agent
 * reads back to the administrator, so they say which one it is.
 */
async function describeFailure(response: Response, operation: string): Promise<string> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 300);
  try {
    // Every documented Tavily error is { "detail": { "error": "…" } }.
    const parsed = JSON.parse(body) as { detail?: { error?: string } | string };
    const inner = typeof parsed.detail === "string" ? parsed.detail : parsed.detail?.error;
    if (inner) detail = inner;
  } catch {
    // Not JSON — a gateway or proxy answered. The raw prefix is the best clue.
  }

  switch (response.status) {
    case 401:
      return "Tavily rejected the API key. Check TAVILY_API_KEY in .env.local (keys begin with `tvly-`) and restart the dev server.";
    case 429:
      return "Tavily is rate limiting this key. Wait a moment before researching again.";
    case 432:
      return `Tavily usage limit reached for this plan: ${detail}`;
    case 433:
      return `Tavily pay-as-you-go limit reached: ${detail}`;
    default:
      return `Tavily ${operation} returned ${response.status}: ${detail}`;
  }
}

export class TavilyProvider implements ResearchProvider {
  readonly name = "tavily" as const;
  readonly configured: boolean;
  private readonly key: string;

  constructor(key: string) {
    this.key = key.trim();
    this.configured = Boolean(this.key);
  }

  private async post(url: string, body: unknown, timeoutMs: number, operation: string): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(await describeFailure(response, operation));
    return response.json();
  }

  async search(query: string, options: SearchOptions): Promise<ResearchAnswer> {
    const data = (await this.post(
      SEARCH_URL,
      {
        query,
        search_depth: options.depth,
        // The documented ceiling is 20; a larger number is a 400, not a clamp.
        max_results: Math.min(Math.max(options.maxResults, 1), 20),
        topic: options.topic,
        include_answer: true,
        // Omitted rather than sent empty: an empty include_domains is fine, but
        // keeping the body minimal keeps the failure surface small.
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
        ...(options.excludeDomains?.length ? { exclude_domains: options.excludeDomains } : {}),
      },
      SEARCH_TIMEOUT_MS,
      "search",
    )) as {
      query?: string;
      answer?: string;
      results?: {
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        published_date?: string;
      }[];
    };

    return {
      query: data.query ?? query,
      answer: data.answer,
      results: (data.results ?? []).map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        content: result.content ?? "",
        score: result.score ?? 0,
        publishedDate: result.published_date,
      })),
    };
  }

  async extract(urls: string[], options: { depth: "basic" | "advanced" }): Promise<ExtractResult> {
    const data = (await this.post(
      EXTRACT_URL,
      {
        // The API takes a string or an array; always sending an array means one
        // response shape to parse.
        urls,
        extract_depth: options.depth,
        format: "markdown",
      },
      EXTRACT_TIMEOUT_MS,
      "extract",
    )) as {
      results?: { url?: string; raw_content?: string }[];
      failed_results?: { url?: string; error?: string }[];
    };

    return {
      pages: (data.results ?? []).map((page) => ({
        url: page.url ?? "",
        content: page.raw_content ?? "",
      })),
      // A dead or paywalled URL comes back here instead of failing the batch,
      // so a four-URL read still returns the three that worked.
      failed: (data.failed_results ?? []).map((failure) => ({
        url: failure.url ?? "",
        error: failure.error ?? "could not be read",
      })),
    };
  }
}

/**
 * Reports itself unconfigured so callers degrade rather than crash.
 *
 * Nothing here should ever run — the orchestrator does not build the research
 * tools when this is the provider — but the tools check `configured` and say
 * what is missing, which is a better failure than a stack trace.
 */
export class NoResearchProvider implements ResearchProvider {
  readonly name = "none" as const;
  readonly configured = false;
  async search(query: string): Promise<ResearchAnswer> {
    return { query, results: [] };
  }
  async extract(): Promise<ExtractResult> {
    return { pages: [], failed: [] };
  }
}
