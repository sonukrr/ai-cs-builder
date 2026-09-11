import Anthropic from "@anthropic-ai/sdk";

/** The orchestrator model. One model, one place to change it. */
export const MODEL = "claude-opus-5";

/**
 * The model name sent when calling through the office/Astra path.
 *
 * The astra-proxy route ignores whatever `model` it receives and always
 * forwards `global.anthropic.claude-opus-4-6-v1` — Astra's pool has no exact
 * match for `claude-opus-5` itself. This constant only has to be *a* valid
 * string for the SDK request; it plays no part in which model actually runs.
 */
export const OFFICE_MODEL = "global.anthropic.claude-opus-4-6-v1";

let cached: Anthropic | null = null;
let cachedOffice: Anthropic | null = null;

/**
 * The shared Anthropic client.
 *
 * Constructed lazily so that importing agent code in a route that never calls
 * the model (the capability probe, for instance) does not require a key.
 *
 * An API key created at the organization level rather than inside a workspace
 * has no workspace of its own, and every request from it is rejected until one
 * is named. ANTHROPIC_WORKSPACE_ID supplies that as a default header; a
 * workspace-scoped key needs nothing and the header stays absent.
 */
export function anthropic(): Anthropic {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add a key.",
      );
    }

    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    cached = new Anthropic({
      ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
    });
  }
  return cached;
}

/**
 * The office/team client: same `Anthropic` SDK surface (so `toolRunner` keeps
 * working completely unmodified), but pointed at this app's own
 * `/api/astra-proxy` route instead of api.anthropic.com. That route is the
 * one that actually knows about Astra, the office secret key, and the
 * Bedrock-shaped request Astra expects — none of that belongs in the client
 * construction here.
 *
 * `baseURL` needs an absolute origin because this runs server-side (a Next.js
 * route handler calling another route handler in the same app has no
 * relative-URL concept the way browser `fetch` does). There's no existing
 * "own base URL" helper in this codebase to reuse — the one precedent
 * (`STUDIO_ORIGIN` in `src/lib/fidelity/capture.ts`) is a different app
 * (the preview host) reachable at a different origin — so this follows the
 * same pattern: an env var with a localhost fallback for dev.
 *
 * `apiKey` is a required non-empty string for the SDK constructor, but this
 * proxy path never reads it: Astra's secretKey is read server-side inside the
 * proxy route from ASTRA_SECRET_KEY, never from the SDK client. The SDK does
 * still send whatever `apiKey` is given here as an `x-api-key` header on every
 * request — harmless, since it only reaches this app's own proxy route (which
 * ignores it), never Astra or Anthropic.
 */
export function anthropicOffice(): Anthropic {
  if (!cachedOffice) {
    const baseOrigin = process.env.APP_BASE_URL?.trim() || "http://localhost:3000";
    cachedOffice = new Anthropic({
      apiKey: "astra-proxy-unused",
      baseURL: `${baseOrigin}/api/astra-proxy`,
    });
  }
  return cachedOffice;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Turns an API failure into something an administrator can act on.
 *
 * The raw messages name headers and scopes that mean nothing to someone who is
 * here to edit a career site, so the few that are really configuration mistakes
 * get translated into the setting to change.
 */
export function describeApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("ASTRA_SECRET_KEY")) {
    return "ASTRA_SECRET_KEY is not set. Add the office secret key to .env.local and restart the dev server.";
  }
  if (message.includes("anthropic-workspace-id")) {
    return (
      "This Anthropic API key is not scoped to a workspace. Add ANTHROPIC_WORKSPACE_ID to " +
      ".env.local (the id is in the Console URL at console.anthropic.com/settings/workspaces/<id>), " +
      "or create a key inside a workspace, then restart the dev server."
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY (or ASTRA_SECRET_KEY) in .env.local.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited or out of quota. Both the personal and office keys are unavailable right now — wait a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API (or the Astra office endpoint). Check your network connection.";
  }
  return message;
}
