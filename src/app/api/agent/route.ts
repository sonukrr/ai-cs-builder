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
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        for await (const event of runAgent({
          projectId: body.projectId!,
          message: body.message!,
          selection: body.selection,
        })) {
          send(event);
        }
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
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
