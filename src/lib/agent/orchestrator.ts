import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, describeApiError, MODEL } from "./client";
import { systemPrompt } from "./prompt";
import { buildTools } from "./tools";
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
}

/** Server-side tools appended when research is enabled. */
function researchTools() {
  if ((process.env.ENABLE_RESEARCH ?? "true").toLowerCase() === "false") return [];
  return [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 }];
}

/**
 * Runs one turn, yielding events as they happen.
 *
 * The caller streams these to the browser; nothing here knows about HTTP.
 */
export async function* runAgent(input: RunInput): AsyncGenerator<AgentEvent> {
  const { projectId, message, selection } = input;

  // Buffer activity from tool closures, which run inside the SDK and cannot
  // yield from this generator directly.
  const pending: AgentEvent[] = [];
  const tools = buildTools({
    projectId,
    onActivity: (tool, summary) => pending.push({ type: "activity", tool, summary }),
  });

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

  try {
    const runner = anthropic().beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: systemPrompt(),
      tools: [...tools, ...researchTools()],
      messages,
      stream: true,
      max_iterations: 16,
    });

    for await (const stream of runner) {
      // Text arrives token by token so the studio feels responsive during the
      // long tool-heavy turns that an import produces.
      const deltas: string[] = [];
      stream.on("text", (delta) => deltas.push(delta));

      const finalMessage = await stream.finalMessage();


      for (const delta of deltas) {
        assistantText += delta;
        yield { type: "text", text: delta };
      }

      while (pending.length > 0) {
        const event = pending.shift()!;
        if (event.type === "activity") activity.push({ tool: event.tool, summary: event.summary });
        yield event;
      }

      // Web search can pause a turn mid-flight; the runner does not resume it
      // on its own, so a paused turn would otherwise end the answer silently.
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
  } catch (error) {
    const detail = describeApiError(error);
    yield { type: "error", message: detail };
    assistantText ||= `Something went wrong: ${detail}`;
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
