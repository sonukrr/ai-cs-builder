import { runAgent } from "@/lib/agent/orchestrator";
import { store } from "@/lib/store/store";

// The agent turn is long-running and tool-heavy; keep it on the Node runtime.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * One agent turn, streamed to the browser as newline-delimited JSON.
 *
 * NDJSON rather than the EventSource protocol because this is a POST with a
 * body, which EventSource cannot do, and the client reads it with a plain
 * fetch reader.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectId?: string;
    message?: string;
    selection?: { pageId?: string; sectionId?: string };
  };

  if (!body.projectId || !body.message?.trim()) {
    return Response.json({ error: "projectId and message are required" }, { status: 400 });
  }

  const project = await store.getProject(body.projectId);
  if (!project) {
    return Response.json({ error: "No such project" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Once the client hits Stop the request aborts and the stream is torn
      // down, so an enqueue would throw; swallow it rather than crash the turn.
      const send = (event: unknown) => {
        if (request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // Client is gone; nothing left to write to.
        }
      };

      try {
        for await (const event of runAgent({
          projectId: body.projectId!,
          message: body.message!,
          selection: body.selection,
          // Cancels the model call the instant the browser aborts the fetch.
          signal: request.signal,
        })) {
          if (request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the abort; safe to ignore.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
