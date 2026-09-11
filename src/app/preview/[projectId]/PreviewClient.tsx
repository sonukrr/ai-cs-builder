"use client";

import { useCallback, useEffect, useState } from "react";
import { PreviewFrame } from "@/components/preview/PreviewFrame";
import { CustomizePanel, type ThemeColors } from "@/components/preview/CustomizePanel";
import type { Blueprint } from "@/lib/blueprint/schema";

interface PreviewSettings {
  previewOrigin: string;
}

export function PreviewClient({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<PreviewSettings | null>(null);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCustomize, setShowCustomize] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadBlueprint = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}`);
    if (!response.ok) {
      setLoadError(response.status === 404 ? "No such project" : "Could not load this project");
      setLoaded(true);
      return;
    }
    const data = (await response.json()) as { blueprint: Blueprint | null };
    setBlueprint(data.blueprint);
    if (!data.blueprint) setLoadError("This project has no site yet — nothing to preview.");
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    (async () => {
      const response = await fetch("/api/preview-config");
      if (response.ok) setSettings((await response.json()) as PreviewSettings);
    })();
    void loadBlueprint();
  }, [loadBlueprint]);

  const handleApplied = useCallback(() => {
    // The frame reads the blueprint fresh on load, so a real remount (not
    // just re-fetching here) is what shows the saved colors.
    setReloadKey((key) => key + 1);
    void loadBlueprint();
  }, [loadBlueprint]);

  const colors: ThemeColors = blueprint?.company.brand.tokens.colors ?? {};

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff" }}>
      {settings && blueprint ? (
        <PreviewFrame
          projectId={projectId}
          pageId={blueprint.pages[0]?.id ?? ""}
          viewport="desktop"
          previewOrigin={settings.previewOrigin}
          reloadKey={reloadKey}
          fullPage
        />
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
          {loaded ? loadError : "Loading preview…"}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setShowCustomize(true)}
        style={{ position: "fixed", top: 16, right: 16, zIndex: 900 }}
      >
        Customize
      </button>

      <CustomizePanel
        projectId={projectId}
        initialColors={colors}
        open={showCustomize}
        onClose={() => setShowCustomize(false)}
        onApplied={handleApplied}
      />
    </div>
  );
}
