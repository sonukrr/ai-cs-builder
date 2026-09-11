/**
 * Reading a JSON response without turning a hiccup into a crash.
 *
 * Every fetch in the studio used to call `await response.json()` directly,
 * which throws `Unexpected end of JSON input` the moment a body is empty — and
 * a body is empty more often than it looks. The dev server recompiling while a
 * request is in flight does it; so does a connection dropped mid-response, a
 * proxy timeout, or a route that died before writing anything. The browser's
 * own message names neither the request nor the status, so an administrator
 * sees a parser error and reasonably concludes the studio is broken.
 *
 * These read the body once, as text, and decide from there. What comes back
 * always says which request failed and what the server actually said, so the
 * next question is "why did that endpoint return nothing" rather than "what is
 * Unexpected end of JSON input".
 */

export interface JsonResult<T> {
  ok: boolean;
  /** 0 when the request never reached the server. */
  status: number;
  data: T | null;
  /** Empty when `ok`. Otherwise a sentence naming the request and the reason. */
  error: string;
}

/** The tail of a non-JSON body, for an error message. Usually an HTML error page. */
function excerpt(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

/**
 * Reads one response.
 *
 * `what` names the thing being fetched, in the administrator's terms — "the
 * project", "the publish preview" — because it is what the error message is
 * built around.
 */
export async function readJson<T>(response: Response, what: string): Promise<JsonResult<T>> {
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: `Could not read ${what}: the connection dropped before the response finished (${
        error instanceof Error ? error.message : String(error)
      }).`,
    };
  }

  if (body.trim() === "") {
    return {
      ok: false,
      status: response.status,
      data: null,
      // The case this module exists for. A 200 with nothing in it is almost
      // always a request that was interrupted rather than an empty answer.
      error: response.ok
        ? `Could not read ${what}: the server returned an empty response. If the studio is running in development this usually means it reloaded mid-request — try again.`
        : `Could not read ${what}: the server returned ${response.status} with an empty response.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: `Could not read ${what}: the server returned ${response.status} and something that is not JSON — ${excerpt(body)}`,
    };
  }

  if (!response.ok) {
    const message = (parsed as { error?: unknown })?.error;
    return {
      ok: false,
      status: response.status,
      data: parsed as T,
      error:
        typeof message === "string" && message.trim()
          ? message
          : `Could not read ${what}: the server returned ${response.status}.`,
    };
  }

  return { ok: true, status: response.status, data: parsed as T, error: "" };
}

/**
 * `fetch` and `readJson` together, with a network failure reported the same way.
 *
 * A GET is retried once when the answer is something that cannot be a real
 * answer — a dropped connection, or a 5xx with an empty body. Those are the
 * signature of a server that went away mid-request rather than a request that
 * was refused: a dev server reloading, a worker restarting, a proxy giving up.
 * Retrying a read is safe, and it turns a blip that used to end an agent turn
 * with "the server returned 500 with an empty response" into a pause nobody
 * notices. Anything with a body is reported as-is, first time: a 404 is an
 * answer, and repeating it would only be slower.
 */
export async function fetchJson<T>(
  url: string,
  what: string,
  init?: RequestInit,
): Promise<JsonResult<T>> {
  const attempt = async (): Promise<JsonResult<T>> => {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: `Could not reach the studio for ${what}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return readJson<T>(response, what);
  };

  const first = await attempt();
  if (first.ok) return first;

  // Only idempotent requests, and only the failures that look transient.
  const method = (init?.method ?? "GET").toUpperCase();
  const worthRetrying = first.status === 0 || (first.status >= 500 && first.data === null);
  if (method !== "GET" || !worthRetrying) return first;

  await new Promise((resolve) => setTimeout(resolve, 600));
  const second = await attempt();
  return second.ok ? second : first;
}
