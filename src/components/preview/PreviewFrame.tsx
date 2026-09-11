"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The live preview, rendered by the Angular host in an iframe.
 *
 * This exists to fix a specific bug. The preview used to render inline in the
 * studio's right-hand panel, which is roughly 500px wide. `zm-careers-lib` is
 * responsive and switches to its mobile layout below a breakpoint — and CSS
 * media queries resolve against the *viewport*, not the element — so "desktop"
 * previews came out in the mobile layout. Nothing about picking a wider preset
 * could fix that while the page shared the studio's viewport.
 *
 * An iframe has its own viewport. So the frame is sized to the true device
 * width (1280 / 834 / 390) and then scaled down with a CSS transform to fit the
 * panel. The library sees a genuine 1280px viewport and lays out for desktop;
 * the operator sees it shrunk to fit. Scaling is visual only — it does not
 * affect layout, which is exactly the property we need.
 */

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900, label: "Desktop" },
  tablet: { width: 834, height: 1112, label: "Tablet" },
  mobile: { width: 390, height: 844, label: "Mobile" },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

/**
 * Where the library's job data comes from.
 *
 * `sample` and `custom` are both answered by an interceptor inside the preview
 * host — the same components, the same code path, different rows. `custom` is a
 * dataset the agent researched for this company.
 */
export type DataSource = "sample" | "custom" | "live";

export interface PreviewFrameProps {
  projectId: string;
  pageId: string;
  viewport: ViewportName;
  source: DataSource;
  /** Where the Angular preview host is served from. */
  previewOrigin: string;
  selectedSectionId?: string;
  onSelect?: (sectionId: string) => void;
  /** Bumped by the studio to force a reload after the blueprint changes. */
  reloadKey?: number;
  /**
   * Fills the shell instead of pinning to a device width + scaling down.
   * For the standalone /preview route, which has no side panels to protect
   * layout from — the frame's own viewport can just be the real one.
   */
  fullPage?: boolean;
}

export function PreviewFrame({
  projectId,
  pageId,
  viewport,
  source,
  previewOrigin,
  selectedSectionId,
  onSelect,
  reloadKey = 0,
  fullPage = false,
}: PreviewFrameProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);

  const device = VIEWPORTS[viewport];

  // Only the parameters the preview host reads at boot belong in the URL, and
  // only what genuinely varies per preview: the careers-API identity is fixed
  // in the host itself (preview-app/src/app/preview-config.ts), not passed in.
  // Page and selection are pushed over postMessage instead, so changing either
  // does not reload the frame and lose scroll position.
  const src = `${previewOrigin}/?project=${encodeURIComponent(projectId)}&studio=${encodeURIComponent(
    typeof window === "undefined" ? "" : window.location.origin,
  )}&source=${source}&v=${reloadKey}`;

  // Measure before paint so the frame never flashes at the wrong size.
  useLayoutEffect(() => {
    if (fullPage) return;
    const shell = shellRef.current;
    if (!shell) return;

    const measure = () => {
      const available = shell.clientWidth;
      // Never scale up — a 390px mobile frame should stay 390px in a wide panel.
      setScale(Math.min(1, available / device.width));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [device.width, fullPage]);

  // Selection travels both ways: clicks in the preview select in the studio,
  // and selecting in the structure panel highlights in the preview.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (previewOrigin && event.origin !== new URL(previewOrigin).origin) return;
      const data = event.data as { type?: string; sectionId?: string };
      if (data?.type === "preview:selected" && data.sectionId) onSelect?.(data.sectionId);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect, previewOrigin]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "preview:page", pageId }, "*");
  }, [pageId]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "preview:select", sectionId: selectedSectionId ?? "" },
      "*",
    );
  }, [selectedSectionId]);

  if (fullPage) {
    return (
      <iframe
        ref={frameRef}
        key={`${projectId}-${source}-${reloadKey}`}
        src={src}
        title="Career site preview"
        style={{ width: "100%", height: "100%", border: 0, background: "#fff", display: "block" }}
      />
    );
  }

  return (
    <div ref={shellRef} className="frame-shell">
      <div className="frame-window" style={{ width: device.width * scale }}>
        {/* A real window chrome, not decoration: the dots read as "this is a
            browser", and the label is the one thing the scaled-down preview
            can no longer show for itself — its own width. */}
        <div className="frame-chrome">
          <span className="frame-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="frame-chrome-label">
            {device.label} · {device.width}px
          </span>
        </div>
        {/*
          The wrapper reserves the *scaled* footprint. Without it the unscaled
          frame would still claim its full 1280px of layout space and the panel
          would scroll horizontally.
        */}
        <div style={{ width: device.width * scale, height: device.height * scale }}>
          <iframe
            ref={frameRef}
            key={`${projectId}-${source}-${reloadKey}`}
            src={src}
            title="Career site preview"
            style={{
              width: device.width,
              height: device.height,
              border: 0,
              background: "#fff",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              display: "block",
            }}
          />
        </div>
      </div>
    </div>
  );
}
