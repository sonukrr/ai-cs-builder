"use client";

import { useRouter } from "next/navigation";
import { readJson } from "@/lib/client/json";
import { useState } from "react";
import type { CapabilityState } from "@/lib/agent/capabilities";
import { ImportIcon, LayersIcon, ArrowRightIcon, GlobeIcon } from "./icons";

interface Props {
  figmaState: CapabilityState;
  figmaDetail: string;
  baseState: CapabilityState;
  baseDetail: string;
  webState: CapabilityState;
  webDetail: string;
}

/** The entry points from 08-admin-ui.md, each creating a project then routing on. */
export function StartPoints({
  figmaState,
  figmaDetail,
  baseState,
  baseDetail,
  webState,
  webDetail,
}: Props) {
  const router = useRouter();
  const [figmaUrl, setFigmaUrl] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [busy, setBusy] = useState<"figma" | "base" | "url" | null>(null);
  const [error, setError] = useState("");

  async function createProject(entryPoint: "figma" | "base" | "url", sourceRef: string) {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Untitled site", entryPoint, sourceRef }),
    });
    const result = await readJson<{ project: { id: string } }>(response, "the new project");
    if (!result.ok || !result.data?.project) throw new Error(result.error);
    return result.data.project;
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

  /**
   * Rebuilding a page the administrator already has.
   *
   * Straight to the studio rather than via the plan screen: there is no plan to
   * approve, because the page *is* the plan. The reading and the rebuilding
   * both happen in the conversation, where each band can be shown as it lands.
   */
  async function startFromUrl() {
    const url = siteUrl.trim();
    if (!url) {
      setError("Give the address of the careers page you want rebuilt.");
      return;
    }

    setBusy("url");
    setError("");
    try {
      const project = await createProject("url", /^https?:\/\//i.test(url) ? url : `https://${url}`);
      router.push(`/studio/${project.id}?start=url`);
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
      <div className="l-entry-cards">
        <section className="l-entry l-entry--base">
          <div className="l-entry-top">
            <span className="l-entry-icon l-entry-icon--alt">
              <LayersIcon size={22} />
            </span>
            {baseState === "demo" && <span className="l-pill l-pill--demo">Demo</span>}
            {baseState === "needs-config" && <span className="l-pill l-pill--setup">Setup</span>}
          </div>
          <h3 className="l-entry-title">Start from the base site</h3>
          <p className="l-entry-desc">
            Start with the approved career-site foundation and customise it using AI agents — brand,
            pages, copy and the functionality you need — just by describing what you want.
          </p>
          <p className="l-entry-note">{baseDetail}</p>
          <button
            className="l-btn l-btn--ghost l-entry-cta"
            onClick={startBase}
            disabled={busy !== null || baseState === "needs-config"}
          >
            {busy === "base" ? "Starting…" : "Start from base"}
            <ArrowRightIcon size={16} />
          </button>
        </section>

        <section className="l-entry l-entry--figma">
          <div className="l-entry-top">
            <span className="l-entry-icon">
              <ImportIcon size={22} />
            </span>
            {figmaState === "demo" && <span className="l-pill l-pill--demo">Demo</span>}
          </div>
          <h3 className="l-entry-title">Import an existing Figma design</h3>
          <p className="l-entry-desc">
            Bring an existing design into the Careersite Builder. The agent reads it section by
            section, maps anything functional onto an approved component, and shows you a plan
            before it builds a working career site.
          </p>
          <input
            className="l-input"
            placeholder="https://www.figma.com/design/…"
            value={figmaUrl}
            onChange={(event) => setFigmaUrl(event.target.value)}
            spellCheck={false}
          />
          <p className="l-entry-note">{figmaDetail}</p>
          <button
            className="l-btn l-btn--primary l-entry-cta"
            onClick={startFigma}
            disabled={busy !== null}
          >
            {busy === "figma"
              ? "Starting…"
              : figmaState === "demo" && !figmaUrl
                ? "Import the demo design"
                : "Import design"}
            <ArrowRightIcon size={16} />
          </button>
        </section>

        <section className="l-entry l-entry--url">
          <div className="l-entry-top">
            <span className="l-entry-icon">
              <GlobeIcon size={22} />
            </span>
            {webState === "needs-config" && <span className="l-pill l-pill--setup">Setup</span>}
          </div>
          <h3 className="l-entry-title">Rebuild your existing careers site</h3>
          <p className="l-entry-desc">
            Give the agent the address of a careers page you already have. It opens the page in a
            real browser, reads it band by band, copies every image into your project, and rebuilds
            it — structure, layout, copy, styling and animations — with the approved components
            wherever something is functional.
          </p>
          <input
            className="l-input"
            placeholder="https://careers.yourcompany.com"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void startFromUrl();
            }}
            spellCheck={false}
          />
          <p className="l-entry-note">{webDetail}</p>
          <button
            className="l-btn l-btn--primary l-entry-cta"
            onClick={startFromUrl}
            disabled={busy !== null || webState === "needs-config"}
          >
            {busy === "url" ? "Reading the page…" : "Rebuild from URL"}
            <ArrowRightIcon size={16} />
          </button>
        </section>
      </div>

      {error && <div className="l-error">{error}</div>}
    </>
  );
}
