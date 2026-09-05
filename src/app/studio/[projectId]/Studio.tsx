"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  PreviewFrame,
  VIEWPORTS,
  type DataSource,
  type ViewportName,
} from "@/components/preview/PreviewFrame";
import { ComponentCatalog } from "@/components/studio/ComponentCatalog";
import type { Blueprint, Section } from "@/lib/blueprint/schema";

/**
 * Screen 3 — the Career Site Studio.
 *
 * Three panels, as 08-admin-ui.md specifies: structure on the left,
 * conversation in the middle, live preview on the right. The point of the
 * arrangement is that the conversation is never the only way to work — you can
 * see the whole site, click any part of it, and the click becomes context the
 * assistant already has.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  at: string;
  activity?: { tool: string; summary: string }[];
}

interface Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}

interface ProjectData {
  project: { id: string; name: string; status: string; currentVersion: number; entryPoint: string };
  blueprint: Blueprint | null;
  issues: Issue[];
  versions: { version: number; createdAt: string; summary: string }[];
  conversation: Turn[];
}

interface PreviewSettings {
  previewOrigin: string;
  defaultSource: DataSource;
  /** Live mode needs no per-project setup: the host carries the tenant identity. */
  liveReady: boolean;
}

/** Sections nest, so anything that looks one up has to walk the whole tree. */
function flattenSections(sections: Section[]): Section[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}

/**
 * A layout container is structure, not content, so its row says what shape it
 * is rather than what it says.
 */
function layoutSummary(section: Section): string {
  const props = section.props as Record<string, unknown>;
  if (props.direction === "grid") {
    const columns = typeof props.columns === "number" ? props.columns : 2;
    return `Grid · ${columns} column${columns === 1 ? "" : "s"}`;
  }
  const count = section.children.length;
  const shape = props.direction === "row" ? "Row" : "Stack";
  return `${shape} · ${count} item${count === 1 ? "" : "s"}`;
}

const LAYOUT_GLYPH: Record<string, string> = { row: "⇉", grid: "▦" };

/**
 * The structure panel's rows, one level of nesting per call.
 *
 * Deliberately a list and not a canvas: rearranging is the assistant's job, and
 * this panel only has to make the nesting legible and every node selectable —
 * containers included, since they carry settings of their own to edit.
 */
function SectionRows({
  sections,
  depth,
  selectedSectionId,
  onSelect,
}: {
  sections: Section[];
  depth: number;
  selectedSectionId: string;
  onSelect: (sectionId: string) => void;
}) {
  return (
    <>
      {sections.map((section) => {
        const isLayout = section.source === "layout";
        const props = section.props as Record<string, unknown>;
        return (
          <Fragment key={section.id}>
            <button
              className={`section-row ${section.id === selectedSectionId ? "is-selected" : ""}`}
              onClick={() => onSelect(section.id)}
              // The class already sets the base 22px; nesting adds to it so a
              // top-level row still lines up under the page name.
              style={{ paddingLeft: 22 + depth * 14 }}
            >
              <span
                className={`tag ${isLayout ? "" : section.source === "zm-careers-lib" ? "tag-fn" : "tag-static"}`}
                style={{ padding: "1px 5px" }}
              >
                {isLayout
                  ? LAYOUT_GLYPH[String(props.direction)] ?? "⇣"
                  : section.source === "zm-careers-lib"
                    ? "fn"
                    : "—"}
              </span>
              <span
                className="label"
                style={isLayout ? { color: "var(--text-dim)", fontStyle: "italic" } : undefined}
              >
                {section.label || (isLayout ? "Layout" : section.type)}
              </span>
              {isLayout && (
                <span className="faint" style={{ fontSize: 11 }}>
                  {layoutSummary(section)}
                </span>
              )}
              {!section.visible && (
                <span className="faint" style={{ fontSize: 11 }}>
                  hidden
                </span>
              )}
            </button>

            {isLayout &&
              (section.children.length > 0 ? (
                <SectionRows
                  sections={section.children}
                  depth={depth + 1}
                  selectedSectionId={selectedSectionId}
                  onSelect={onSelect}
                />
              ) : (
                <div className="faint" style={{ padding: "3px 14px", paddingLeft: 36 + depth * 14, fontSize: 12 }}>
                  nothing in here yet
                </div>
              ))}
          </Fragment>
        );
      })}
    </>
  );
}

const SUGGESTIONS = [
  "Add job filters to the jobs page",
  "Move employee stories above benefits",
  "Add resume upload",
  "Make the brand colour warmer",
  "Add a hiring process section",
];

export function Studio({ projectId, startFromBase }: { projectId: string; startFromBase: boolean }) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [pageId, setPageId] = useState<string>("");
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [viewport, setViewport] = useState<ViewportName>("desktop");
  const [settings, setSettings] = useState<PreviewSettings | null>(null);
  const [source, setSource] = useState<DataSource>("sample");
  const [hasDataset, setHasDataset] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  /** Bumped after every change so the preview frame reloads the blueprint. */
  const [previewKey, setPreviewKey] = useState(0);

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [activity, setActivity] = useState<{ tool: string; summary: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const kickedOff = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}`);
    if (!response.ok) {
      setError((await response.json()).error ?? "Could not load the project");
      return null;
    }
    const next = (await response.json()) as ProjectData;
    setData(next);
    setPageId((current) => current || next.blueprint?.pages[0]?.id || "");
    // The preview holds its own copy of the blueprint; tell it to refetch.
    setPreviewKey((key) => key + 1);

    // The agent may have researched job data during the turn, which enables a
    // data source that was not offered a moment ago.
    fetch(`/api/projects/${projectId}/dataset`)
      .then((response) => (response.ok ? response.json() : { dataset: null }))
      .then((body) => setHasDataset(Boolean(body.dataset?.roles?.length)))
      .catch(() => setHasDataset(false));

    return next;
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const response = await fetch("/api/preview-config");
      if (!response.ok) return;
      const config = (await response.json()) as PreviewSettings;
      setSettings(config);
      // Never open on a source that cannot serve anything yet.
      setSource(config.defaultSource === "live" && !config.liveReady ? "sample" : config.defaultSource);
    })();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [streaming, activity, data?.conversation.length]);

  const send = useCallback(
    async (message: string) => {
      if (!message.trim() || busy) return;
      setBusy(true);
      setError("");
      setStreaming("");
      setActivity([]);
      setDraft("");

      // Show the user's turn immediately; the server persists its own copy.
      setData((current) =>
        current
          ? {
              ...current,
              conversation: [
                ...current.conversation,
                { role: "user", content: message, at: new Date().toISOString() },
              ],
            }
          : current,
      );

      try {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            message,
            selection: { pageId, sectionId: selectedSectionId || undefined },
          }),
        });

        if (!response.ok || !response.body) {
          throw new Error((await response.json().catch(() => ({}))).error ?? "The assistant is unavailable");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let changed = false;

        // NDJSON: one event per line, with the tail held back until complete.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as
              | { type: "text"; text: string }
              | { type: "activity"; tool: string; summary: string }
              | { type: "done"; blueprintChanged: boolean }
              | { type: "error"; message: string };

            if (event.type === "text") setStreaming((current) => current + event.text);
            else if (event.type === "activity")
              setActivity((current) => [...current, { tool: event.tool, summary: event.summary }]);
            else if (event.type === "error") setError(event.message);
            else if (event.type === "done") changed = event.blueprintChanged;
          }
        }

        // Reload either way — the transcript lives on the server, and the
        // blueprint may have changed under us.
        void changed;
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setStreaming("");
        setActivity([]);
        setBusy(false);
      }
    },
    [busy, load, pageId, projectId, selectedSectionId],
  );

  // Starting from base kicks the conversation off so the admin lands in a
  // dialogue rather than an empty box.
  useEffect(() => {
    if (!startFromBase || kickedOff.current || !data || data.blueprint || data.conversation.length > 0) return;
    kickedOff.current = true;
    void send(
      "I want to start from the approved base career site. Read it, then ask me what you need to know about my company to customise it.",
    );
  }, [data, send, startFromBase]);

  async function revert(version: number) {
    await fetch(`/api/projects/${projectId}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    await load();
  }

  async function requestPublish() {
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error + (result.issues ? `: ${result.issues.map((i: Issue) => i.message).join("; ")}` : ""));
      } else {
        await load();
        setError("");
      }
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <main className="start">
        <h1>Could not open this project</h1>
        <div className="notice" style={{ borderLeftColor: "var(--bad)" }}>{error}</div>
        <p style={{ marginTop: 20 }}>
          <a href="/projects/new">Back to the start</a>
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="start">
        <h1 className="muted">Loading…</h1>
      </main>
    );
  }

  const { blueprint } = data;
  const errors = data.issues.filter((i) => i.level === "error");
  const warnings = data.issues.filter((i) => i.level === "warning");
  const selectedSection = blueprint?.pages
    .flatMap((page) => flattenSections(page.sections))
    .find((section) => section.id === selectedSectionId);

  const currentPage = blueprint?.pages.find((page) => page.id === pageId) ?? blueprint?.pages[0];

  return (
    <div className="studio">
      {showCatalog && currentPage && (
        <ComponentCatalog
          projectId={projectId}
          pageId={currentPage.id}
          pageName={currentPage.name}
          onClose={() => setShowCatalog(false)}
          onAdded={() => {
            void load();
            setShowCatalog(false);
          }}
        />
      )}

      <header className="topbar">
        <h1>{blueprint?.company.name ?? data.project.name}</h1>
        {data.project.currentVersion > 0 && (
          <span className="tag">v{data.project.currentVersion}</span>
        )}
        {errors.length > 0 && <span className="tag tag-bad">{errors.length} blocking</span>}
        {errors.length === 0 && warnings.length > 0 && (
          <span className="tag tag-warn" title={warnings.map((w) => w.message).join("\n")}>
            {warnings.length} warning{warnings.length === 1 ? "" : "s"}
          </span>
        )}
        {data.project.status === "publish-requested" && <span className="tag tag-good">publish requested</span>}

        <span className="spacer" />

        <button className="btn btn-sm" onClick={() => setShowHistory((v) => !v)}>
          History
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={requestPublish}
          disabled={busy || !blueprint || errors.length > 0}
          title={errors.length > 0 ? "Fix the blocking issues first" : "File a request for review"}
        >
          Request publishing
        </button>
      </header>

      {/* Left — site structure */}
      <aside className="panel">
        <div className="panel-head">
          Site structure
          <span style={{ flex: 1 }} />
          {blueprint && !showHistory && (
            <button
              className="btn btn-sm"
              onClick={() => setShowCatalog(true)}
              title="Browse everything you can add to this page"
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              + Add
            </button>
          )}
        </div>

        {showHistory ? (
          <div style={{ padding: "8px 0" }}>
            {data.versions.length === 0 && <div className="faint" style={{ padding: "8px 14px" }}>No versions yet.</div>}
            {data.versions.map((version) => (
              <div key={version.version} style={{ padding: "9px 14px", borderBottom: "1px solid var(--border-soft)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className="mono faint">v{version.version}</span>
                  {version.version !== data.project.currentVersion && (
                    <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => revert(version.version)}>
                      Restore
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, marginTop: 3 }}>{version.summary}</div>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  {new Date(version.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : !blueprint ? (
          <div className="faint" style={{ padding: 14, fontSize: 13 }}>
            No site yet. Describe what you want, or import a design.
          </div>
        ) : (
          blueprint.pages.map((page) => (
            <div key={page.id} className="page-group">
              <div className="page-name">
                <strong style={{ color: "var(--text)" }}>{page.name}</strong>
                <span className="mono faint">{page.path}</span>
              </div>
              <SectionRows
                sections={page.sections}
                depth={0}
                selectedSectionId={selectedSectionId}
                onSelect={(sectionId) => {
                  setPageId(page.id);
                  setSelectedSectionId(sectionId);
                }}
              />
              {page.sections.length === 0 && (
                <div className="faint" style={{ padding: "4px 22px", fontSize: 12.5 }}>
                  no sections
                </div>
              )}
            </div>
          ))
        )}
      </aside>

      {/* Centre — the assistant */}
      <section className="panel panel-chat">
        <div className="panel-head">Assistant</div>

        <div className="chat-log" ref={logRef}>
          {data.conversation.length === 0 && !streaming && (
            <div className="faint" style={{ fontSize: 13.5 }}>
              Describe what you want to change. Click any part of the preview first and the
              assistant will know what you mean by “this”.
            </div>
          )}

          {data.conversation.map((turn, index) =>
            turn.role === "user" ? (
              <div key={index} className="turn-user">
                {turn.content}
              </div>
            ) : (
              <div key={index}>
                {turn.activity?.map((entry, i) => (
                  <div key={i} className="activity">
                    <span className="dot" />
                    <span>{entry.summary}</span>
                  </div>
                ))}
                <div className="turn-assistant">{turn.content}</div>
              </div>
            ),
          )}

          {activity.map((entry, index) => (
            <div key={`live-${index}`} className="activity">
              <span className="dot" />
              <span>{entry.summary}</span>
            </div>
          ))}
          {streaming && <div className="turn-assistant">{streaming}</div>}
          {busy && !streaming && activity.length === 0 && (
            <div className="activity">
              <span className="dot" />
              <span>Thinking…</span>
            </div>
          )}

          {error && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)", marginTop: 4 }}>
              {error}
            </div>
          )}
        </div>

        <div className="composer">
          {selectedSection && (
            <div className="selected-chip">
              Editing: {blueprint?.pages.find((p) => p.id === pageId)?.name} → {selectedSection.label}
              <button className="btn btn-sm" style={{ padding: "0 5px" }} onClick={() => setSelectedSectionId("")}>
                ×
              </button>
            </div>
          )}

          {data.conversation.length === 0 && (
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} className="btn btn-sm" onClick={() => send(suggestion)} disabled={busy}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            placeholder={busy ? "Working…" : "Describe a change…"}
            disabled={busy}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => send(draft)} disabled={busy || !draft.trim()}>
              Send
            </button>
          </div>
        </div>
      </section>

      {/* Right — live preview */}
      <section className="panel panel-preview">
        <div className="panel-head">
          Preview
          <span className="spacer" style={{ flex: 1 }} />
          {blueprint && blueprint.pages.length > 1 && (
            <select
              className="btn btn-sm"
              value={pageId}
              onChange={(event) => {
                setPageId(event.target.value);
                setSelectedSectionId("");
              }}
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              {blueprint.pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.name}
                </option>
              ))}
            </select>
          )}
          {(Object.keys(VIEWPORTS) as ViewportName[]).map((name) => (
            <button
              key={name}
              className="btn btn-sm"
              onClick={() => setViewport(name)}
              title={`${VIEWPORTS[name].label} — ${VIEWPORTS[name].width}px`}
              style={{ borderColor: viewport === name ? "var(--accent)" : undefined }}
            >
              {name[0].toUpperCase()}
            </button>
          ))}

          {/*
            The connector switch. All three run the same library components
            against the same code path — only where the rows come from differs,
            which is what makes the sample modes a fair preview.
          */}
          <select
            className="btn btn-sm"
            value={source}
            onChange={(event) => setSource(event.target.value as DataSource)}
            title="Where the job listings and filters get their data"
            style={{
              textTransform: "none",
              letterSpacing: 0,
              borderColor: source === "live" ? "var(--good)" : undefined,
            }}
          >
            <option value="sample">Sample data</option>
            <option value="custom" disabled={!hasDataset}>
              {hasDataset ? "Researched data" : "Researched data (ask the assistant)"}
            </option>
            <option value="live" disabled={!settings?.liveReady}>
              {settings?.liveReady ? "Live careers API" : "Live API (needs setup)"}
            </option>
          </select>
        </div>

        <div className="preview-scroll">
          {blueprint && settings ? (
            <PreviewFrame
              projectId={projectId}
              pageId={pageId}
              viewport={viewport}
              source={source}
              previewOrigin={settings.previewOrigin}
              selectedSectionId={selectedSectionId}
              onSelect={setSelectedSectionId}
              reloadKey={previewKey}
            />
          ) : (
            <div className="faint" style={{ alignSelf: "center", fontSize: 13.5 }}>
              {blueprint ? "Starting the preview…" : "The preview appears once there is a site to show."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
