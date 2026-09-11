import type Anthropic from "@anthropic-ai/sdk";

// Astra is a thin passthrough to Bedrock; it is not confirmed to stream, so
// this proxy always calls it non-streaming and, when the caller asked for a
// stream, synthesizes an SSE response from the complete message afterward.
export const runtime = "nodejs";
export const maxDuration = 300;

const ASTRA_URL =
  "http://genai.services.resdex.com/prompt-execute-services/v0/llm/wrapper/messages";

/** This proxy is Astra-Opus-only: every request is forced onto this model/template. */
const ASTRA_MODEL = "global.anthropic.claude-opus-4-6-v1";
const ASTRA_TEMPLATE_CODE = "HACKATHON_ANTHROPIC_OPUS_4.6";

/**
 * The subset of an incoming SDK request body this proxy understands.
 *
 * Shaped after `MessageCreateParamsBase` in
 * `@anthropic-ai/sdk/resources/beta/messages/messages` — i.e. exactly what
 * `anthropic().beta.messages.toolRunner({...})` sends to `/v1/messages?beta=true`.
 * Untyped fields (`model`, `stream`, beta-only knobs) are read loosely below
 * and either overridden or stripped before forwarding to Astra.
 */
interface IncomingBody {
  model?: string;
  max_tokens?: number;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stop_sequences?: unknown;
  metadata?: unknown;
  thinking?: unknown;
  // Beta-only / runner-only fields that do not belong on a stable Anthropic
  // Messages request and are stripped rather than forwarded — see below.
  output_config?: unknown;
  betas?: unknown;
  mcp_servers?: unknown;
  context_management?: unknown;
  container?: unknown;
  [key: string]: unknown;
}

/**
 * Astra's own non-streaming response — the normal Anthropic Messages API
 * response shape (this is also what Bedrock's InvokeModel returns for
 * Claude, since Astra passes it through as-is).
 */
interface AstraMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Anthropic.Beta.BetaContentBlock[];
  model: string;
  stop_reason: Anthropic.Beta.BetaStopReason | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function POST(request: Request) {
  const secretKey = process.env.ASTRA_SECRET_KEY;
  if (!secretKey) {
    return Response.json(
      {
        error:
          "ASTRA_SECRET_KEY is not set. Copy .env.example to .env.local and add the office secret key.",
      },
      { status: 500 },
    );
  }

  let incoming: IncomingBody;
  try {
    incoming = (await request.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const wantsStream = incoming.stream === true;

  // Build the body Astra expects: standard Anthropic Messages API shape,
  // Bedrock-flavored (`anthropic_version`), always non-streaming, and always
  // pinned to the fixed Astra-Opus model — the incoming SDK request's model
  // and stream flag are both intentionally ignored/overridden here.
  //
  // Fields dropped before forwarding, and why:
  //   - `output_config` — a Claude-API-beta-only structured-output/effort
  //     knob that is not part of the stable Messages API shape Bedrock (and
  //     therefore Astra) accepts. Sending it risked an unrecognized-field
  //     rejection, so it is stripped rather than guessed at.
  //   - `betas` — an Anthropic-API SDK/header concept (`anthropic-beta`);
  //     meaningless to a Bedrock passthrough.
  //   - `mcp_servers` / `context_management` / `container` — Claude-API-only
  //     beta surfaces (MCP connector, context editing, code-execution
  //     containers) with no Bedrock equivalent; not used by this app's
  //     orchestrator today, but stripped defensively if ever sent.
  // `thinking` (the runner always sends `{type: "adaptive"}`) IS forwarded —
  // adaptive thinking is supported for Claude on Bedrock.
  const {
    model: _incomingModel,
    stream: _incomingStream,
    output_config: _outputConfig,
    betas: _betas,
    mcp_servers: _mcpServers,
    context_management: _contextManagement,
    container: _container,
    ...forwardable
  } = incoming;

  const astraBody = {
    ...forwardable,
    anthropic_version: "bedrock-2023-05-31",
    model: ASTRA_MODEL,
    stream: false,
  };

  let astraResponse: Response;
  try {
    astraResponse = await fetch(ASTRA_URL, {
      method: "POST",
      headers: {
        AppId: "123",
        SystemId: "123",
        "Content-Type": "application/json",
        secretKey: `${secretKey}#${ASTRA_TEMPLATE_CODE}`,
      },
      body: JSON.stringify(astraBody),
    });
  } catch (error) {
    return Response.json(
      {
        error: `Could not reach Astra at ${ASTRA_URL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 502 },
    );
  }

  if (!astraResponse.ok) {
    return handleAstraError(astraResponse);
  }

  let message: AstraMessageResponse;
  try {
    message = (await astraResponse.json()) as AstraMessageResponse;
  } catch {
    return Response.json(
      { error: "Astra returned a 200 response that was not valid JSON." },
      { status: 502 },
    );
  }

  if (!wantsStream) {
    return Response.json(message);
  }

  return new Response(synthesizeSSE(message), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Astra's documented error responses, translated into a clear message rather
 * than an opaque passthrough.
 *
 * Known shapes:
 *   401 UNAUTHORIZED              — secretKey/templateCode rejected.
 *   400 BAD_REQUEST                — malformed request body.
 *   429 TOKEN_USAGE_LIMIT_REACHED  — office token budget exhausted.
 *   500 UNEXPECTED_ERROR           — general upstream failure. Note: Astra's
 *     Haiku/Sonnet-5 routes are known to sometimes 500 with
 *     `{"error":{"code":"1.UE"}}` as a distinct upstream bug class — not
 *     relevant here since this proxy is Opus-only, but kept in mind so a
 *     future reader doesn't mistake every 500 for the same cause.
 */
async function handleAstraError(astraResponse: Response): Promise<Response> {
  const status = astraResponse.status;
  let bodyText: string;
  try {
    bodyText = await astraResponse.text();
  } catch {
    bodyText = "";
  }

  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code;
  } catch {
    // Not JSON — fall through with the raw text below.
  }

  const messages: Record<number, string> = {
    401: "Astra rejected the request as UNAUTHORIZED. Check ASTRA_SECRET_KEY.",
    400: `Astra rejected the request as BAD_REQUEST${code ? ` (${code})` : ""}.`,
    429: "Astra reports TOKEN_USAGE_LIMIT_REACHED — the office token budget is exhausted.",
    500: `Astra returned UNEXPECTED_ERROR${code ? ` (${code})` : ""}.`,
  };

  const message =
    messages[status] ?? `Astra returned an unexpected ${status} response: ${bodyText}`;

  return Response.json({ error: message, astraStatus: status, astraBody: bodyText }, { status });
}

/**
 * Replays a complete Anthropic-shaped message as a synthesized SSE stream,
 * so the Anthropic SDK's stream parser (`Stream.fromSSEResponse` /
 * `BetaMessageStream`) — which reads the `event:` line, not the JSON `type`
 * field, to decide how to handle each chunk (see
 * `@anthropic-ai/sdk/core/streaming.ts` `_iterSSEMessages` /
 * `SSEDecoder`) — is satisfied exactly as if talking to the real API.
 *
 * This is safe because:
 *   - It replays one already-complete message; nothing is invented — every
 *     field (content, stop_reason, usage) comes straight from Astra's JSON.
 *   - Each content block is emitted as a single delta (the full text, or the
 *     full JSON-stringified tool input in one `input_json_delta`), which the
 *     SDK's accumulator handles fine — deltas are just concatenated, and one
 *     chunk containing everything concatenates to the same result as many.
 *   - Event *names* (the `event: <type>` line) are what the decoder branches
 *     on, so every block below carries the exact event name the real API
 *     would send for that transition.
 */
function synthesizeSSE(message: AstraMessageResponse): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: message.id,
          type: "message",
          role: "assistant",
          model: message.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: 0,
          },
        },
      });

      message.content.forEach((block, index) => {
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: emptyBlockOf(block),
        });

        if (block.type === "text") {
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          });
        } else if (block.type === "tool_use") {
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "thinking") {
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          });
          if (block.signature) {
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: block.signature },
            });
          }
        }
        // Other block types (e.g. server-tool results) are replayed as-is via
        // content_block_start above with no delta needed — the runner's own
        // tools never produce them here, but a stray one won't crash the loop.

        send("content_block_stop", { type: "content_block_stop", index });
      });

      send("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: message.stop_reason,
          stop_sequence: message.stop_sequence,
        },
        usage: {
          output_tokens: message.usage.output_tokens,
        },
      });

      send("message_stop", { type: "message_stop" });

      controller.close();
    },
  });
}

/** The content_block_start payload for a block, before any deltas are applied. */
function emptyBlockOf(block: Anthropic.Beta.BetaContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: "", citations: block.citations ?? null };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: {} };
    case "thinking":
      return { type: "thinking", thinking: "", signature: "" };
    default:
      // Fallback: replay the block whole. There is no delta step for it, but
      // content_block_start + content_block_stop alone is a valid sequence.
      return block as unknown as Record<string, unknown>;
  }
}
