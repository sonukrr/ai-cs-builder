"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { buildPreviewUrl, previewChannelName } from "@/lib/preview/url";

/**
 * The full, unclipped preview — a plain full-viewport iframe at the Angular
 * preview host, opened from the studio in a new tab.
 *
 * The in-studio panel scales this same host down to fit ~500px of sidebar, so
 * this route exists for exactly what that can't show: the real site at real
 * size. It stays in sync with edits made back in the studio tab via a
 * `BroadcastChannel` — same-origin, same project — rather than polling.
 */
export function FullPreview({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const initialPageId = searchParams.get("page") ?? "";
  const [previewOrigin, setPreviewOrigin] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    (async () => {
      const response = await fetch("/api/preview-config");
      if (!response.ok) return;
      const config = (await response.json()) as { previewOrigin: string };
      setPreviewOrigin(config.previewOrigin);
    })();
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(previewChannelName(projectId));
    channel.onmessage = (event) => {
      if ((event.data as { type?: string })?.type === "reload") setReloadKey((key) => key + 1);
    };
    return () => channel.close();
  }, [projectId]);

  useEffect(() => {
    if (!initialPageId) return;
    frameRef.current?.contentWindow?.postMessage({ type: "preview:page", pageId: initialPageId }, "*");
  }, [initialPageId, previewOrigin, reloadKey]);

  if (!previewOrigin) {
    return (
      <main style={{ display: "grid", placeItems: "center", height: "100vh", fontFamily: "system-ui" }}>
        Loading preview…
      </main>
    );
  }

  const src = buildPreviewUrl({
    previewOrigin,
    projectId,
    studioOrigin: typeof window === "undefined" ? "" : window.location.origin,
    reloadKey,
  });

  return (
    <iframe
      ref={frameRef}
      key={reloadKey}
      src={src}
      title="Full career site preview"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0, background: "#fff" }}
    />
  );
}
