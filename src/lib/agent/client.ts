import Anthropic from "@anthropic-ai/sdk";

/** The orchestrator model. One model, one place to change it. */
export const MODEL = "claude-opus-5";

let cached: Anthropic | null = null;

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

  if (message.includes("anthropic-workspace-id")) {
    return (
      "This Anthropic API key is not scoped to a workspace. Add ANTHROPIC_WORKSPACE_ID to " +
      ".env.local (the id is in the Console URL at console.anthropic.com/settings/workspaces/<id>), " +
      "or create a key inside a workspace, then restart the dev server."
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.local.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API. Wait a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API. Check your network connection.";
  }
  return message;
}
