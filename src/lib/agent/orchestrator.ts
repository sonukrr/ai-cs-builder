import Anthropic from "@anthropic-ai/sdk";
import { anthropic, anthropicOffice, describeApiError, MODEL, OFFICE_MODEL } from "./client";
import { systemPrompt } from "./prompt";
import { buildTools } from "./tools";
import { buildResearchTools } from "./research-tools";
import { researchStatus } from "@/lib/providers/research";
import { store } from "@/lib/store/store";

/**
 * The single orchestrator.
 *
 * Uses the SDK's tool runner rather than a hand-written loop: the loop itself
 * carries no logic worth owning here, and every guard rail that matters — the
 * registry check, the blueprint validation, the protected-branch refusal —
 * already lives inside the tools, where it applies no matter how the loop is
 * driven.
 */

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "activity"; tool: string; summary: string }
  | { type: "done"; blueprintChanged: boolean }
  | { type: "error"; message: string };

export interface RunInput {
  projectId: string;
  message: string;
  /** What the admin has selected in the preview, if anything. */
  selection?: { pageId?: string; sectionId?: string };
  /** Aborts the in-flight model call when the admin stops the turn. */
  signal?: AbortSignal;
}

/**
 * Whatever web access this deployment has, expressed as tools.
 *
 * Tavily when a key is configured, because its results come back *into this
 * process*: the dataset tools can quote the URL a role came from, so a
 * researched preview is checkable. Otherwise Anthropic's server-side search,
 * which runs inside the model's turn and informs the answer without ever
 * handing the page text back here.
 *
 * Never both. Two search tools with overlapping descriptions make the model
 * deliberate about which to call instead of calling one.
 */
function researchTools(onActivity: (tool: string, summary: string) => void) {
  switch (researchStatus().backend) {
    case "tavily":
      return buildResearchTools({ onActivity });
    case "builtin":
      return [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 }];
    default:
      return [];
  }
}

/**
 * Whether a failed call is the specific case worth falling over to the office
 * key for: the personal key has run out of quota (or Astra reports the same
 * for the office key on a later attempt, harmlessly re-checked here too).
 *
 * Deliberately narrow — an auth failure, a bad request, or a genuine bug
 * should surface as an error rather than silently retry against a different
 * provider and obscure what actually went wrong.
 */
function isQuotaOrAuthError(error: unknown): boolean {
  return error instanceof Anthropic.RateLimitError;
}

/**
 * Runs one turn, yielding events as they happen.
 *
 * The caller streams these to the browser; nothing here knows about HTTP.
 */
export async function* runAgent(input: RunInput): AsyncGenerator<AgentEvent> {
  const { projectId, message, selection, signal } = input;

  const stopped = () => Boolean(signal?.aborted);

  // Buffer activity from tool closures, which run inside the SDK and cannot
  // yield from this generator directly.
  const pending: AgentEvent[] = [];
  const onActivity = (tool: string, summary: string) => {
    pending.push({ type: "activity", tool, summary });
  };
  const tools = buildTools({ projectId, onActivity });

  const history = await store.getConversation(projectId);
  const versionBefore = (await store.getProject(projectId))?.currentVersion ?? 0;

  const messages: Anthropic.Beta.BetaMessageParam[] = history
    // Keep the window bounded; the blueprint, not the transcript, is the state.
    .slice(-20)
    .map((turn) => ({ role: turn.role, content: turn.content }));

  const selectionNote = selection?.sectionId
    ? `\n\n[The administrator currently has the "${selection.sectionId}" section selected${selection.pageId ? ` on the "${selection.pageId}" page` : ""}.]`
    : selection?.pageId
      ? `\n\n[The administrator is currently viewing the "${selection.pageId}" page.]`
      : "";

  messages.push({ role: "user", content: message + selectionNote });

  await store.appendTurn(projectId, {
    role: "user",
    content: message,
    at: new Date().toISOString(),
  });

  let assistantText = "";
  const activity: { tool: string; summary: string }[] = [];

  // Personal key first, office/Astra key as a fallback. The switch only
  // happens before anything has reached the browser for this turn — once a
  // token has streamed out under one client, retrying under the other would
  // mean re-running (and potentially re-executing tools for) a turn the
  // administrator has already partly seen, so a failure past that point is
  // just reported instead.
  const clients: { build: () => Anthropic; model: string }[] = [
    { build: anthropic, model: MODEL },
    { build: anthropicOffice, model: OFFICE_MODEL },
  ];

  let streamedAnything = false;

  for (let attempt = 0; attempt < clients.length; attempt += 1) {
    const { build, model } = clients[attempt];
    const isLastAttempt = attempt === clients.length - 1;

    try {
      const runner = build().beta.messages.toolRunner(
        {
          model,
          max_tokens: 32000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          system: systemPrompt(),
          tools: [...tools, ...researchTools(onActivity)],
          messages,
          stream: true,
          max_iterations: 16,
        },
        // Passing the signal cancels the underlying HTTP request the moment the
        // admin hits Stop, rather than only after the current model call returns.
        { signal },
      );

      for await (const stream of runner) {
        // Stop between iterations too, so a multi-tool turn ends promptly.
        if (stopped()) break;
        // Text arrives token by token so the studio feels responsive during the
        // long tool-heavy turns that an import produces.
        const deltas: string[] = [];
        stream.on("text", (delta) => deltas.push(delta));

        const finalMessage = await stream.finalMessage();

        for (const delta of deltas) {
          streamedAnything = true;
          assistantText += delta;
          yield { type: "text", text: delta };
        }

        while (pending.length > 0) {
          streamedAnything = true;
          const event = pending.shift()!;
          if (event.type === "activity") activity.push({ tool: event.tool, summary: event.summary });
          yield event;
        }

        // A server-side tool can pause a turn mid-flight, and the runner does not
        // resume it on its own, so a paused turn would otherwise end the answer
        // silently. Only the built-in web_search path can land here — a
        // client-side tool call stops the turn with tool_use, which the runner
        // already handles — but the guard costs nothing and one of the two paths
        // is always live.
        if (finalMessage.stop_reason === "pause_turn") {
          runner.pushMessages({ role: "assistant", content: finalMessage.content });
        }

        if (finalMessage.stop_reason === "refusal") {
          yield {
            type: "error",
            message: "The model declined this request. Try rephrasing what you want to change.",
          };
          break;
        }
      }

      break; // This attempt ran to completion — don't fall through to the next client.
    } catch (error) {
      // A stop is a deliberate cancellation, not a failure: keep whatever text
      // streamed so far and fall through to persist it, without a red error,
      // and never fail over to the other client for a stop.
      const aborted = stopped() || (error instanceof Error && error.name === "AbortError");
      if (aborted) break;

      const shouldFailOver = !streamedAnything && !isLastAttempt && isQuotaOrAuthError(error);
      if (shouldFailOver) continue;

      const detail = describeApiError(error);
      yield { type: "error", message: detail };
      assistantText ||= `Something went wrong: ${detail}`;
      break;
    }
  }

  // Drain anything a tool recorded after the last stream ended.
  while (pending.length > 0) {
    const event = pending.shift()!;
    if (event.type === "activity") activity.push({ tool: event.tool, summary: event.summary });
    yield event;
  }

  if (assistantText.trim()) {
    await store.appendTurn(projectId, {
      role: "assistant",
      content: assistantText,
      at: new Date().toISOString(),
      activity,
    });
  }

  const versionAfter = (await store.getProject(projectId))?.currentVersion ?? 0;
  yield { type: "done", blueprintChanged: versionAfter !== versionBefore };
}
