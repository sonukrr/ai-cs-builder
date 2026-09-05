"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CapabilityState } from "@/lib/agent/capabilities";

interface Props {
  figmaState: CapabilityState;
  figmaDetail: string;
  baseState: CapabilityState;
  baseDetail: string;
}

/** The two entry points from 08-admin-ui.md, each creating a project then routing on. */
export function StartPoints({ figmaState, figmaDetail, baseState, baseDetail }: Props) {
  const router = useRouter();
  const [figmaUrl, setFigmaUrl] = useState("");
  const [busy, setBusy] = useState<"figma" | "base" | null>(null);
  const [error, setError] = useState("");

  async function createProject(entryPoint: "figma" | "base", sourceRef: string) {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Untitled site", entryPoint, sourceRef }),
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "Could not create the project");
    return (await response.json()).project as { id: string };
  }

  async function startFigma() {
    setBusy("figma");
    setError("");
    try {
      const project = await createProject("figma", figmaUrl);

      // The import is the slow part — analysis of a real file takes a while —
      // so it runs on the plan screen where there is somewhere to show progress.
      const params = figmaUrl ? `?figma=${encodeURIComponent(figmaUrl)}` : "?figma=demo";
      router.push(`/plan/${project.id}${params}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  }

  async function startBase() {
    setBusy("base");
    setError("");
    try {
      const project = await createProject("base", "");
      router.push(`/studio/${project.id}?start=base`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  }

  return (
    <>
      <div className="cards">
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2>Import an existing Figma design</h2>
            {figmaState === "demo" && <span className="tag tag-warn">demo</span>}
          </div>
          <p>
            Paste a Figma file link. The agent reads the design section by section, maps anything
            functional onto an approved component, and shows you a plan before it builds anything.
          </p>
          <input
            className="field"
            placeholder="https://www.figma.com/design/…"
            value={figmaUrl}
            onChange={(event) => setFigmaUrl(event.target.value)}
            spellCheck={false}
          />
          <div className="faint" style={{ fontSize: 12.5 }}>{figmaDetail}</div>
          <button className="btn btn-primary" onClick={startFigma} disabled={busy !== null}>
            {busy === "figma" ? "Starting…" : figmaState === "demo" && !figmaUrl ? "Import the demo design" : "Import design"}
          </button>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2>Start from the base site</h2>
            {baseState === "demo" && <span className="tag tag-warn">demo</span>}
            {baseState === "needs-config" && <span className="tag tag-bad">setup</span>}
          </div>
          <p>
            Begin from the approved career-site foundation and customise it — brand, pages, copy and
            the functionality you need — by describing what you want.
          </p>
          <div className="faint" style={{ fontSize: 12.5 }}>{baseDetail}</div>
          <button className="btn" onClick={startBase} disabled={busy !== null || baseState === "needs-config"}>
            {busy === "base" ? "Starting…" : "Start from base"}
          </button>
        </div>
      </div>

      {error && (
        <div className="notice" style={{ borderLeftColor: "var(--bad)" }}>
          {error}
        </div>
      )}
    </>
  );
}
