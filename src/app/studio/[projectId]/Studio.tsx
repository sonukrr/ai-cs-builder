"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PreviewFrame, VIEWPORTS, type ViewportName } from "@/components/preview/PreviewFrame";
import { ComponentCatalog } from "@/components/studio/ComponentCatalog";
import { FidelityReview } from "@/components/studio/FidelityReview";
import { PublishPanel } from "./PublishPanel";
import { StyleEditor } from "./StyleEditor";
import {
  ChatGlyph,
  CloseIcon,
  DesktopIcon,
  ExpandIcon,
  ExternalLinkIcon,
  GridIcon,
  HistoryIcon,
  MobileIcon,
  PageIcon,
  PaletteIcon,
  PlusIcon,
  PreviewGlyph,
  ReloadIcon,
  RowIcon,
  SendIcon,
  SparkMark,
  StopIcon,
  StackIcon,
  TabletIcon,
} from "@/components/studio/icons";
import type { Blueprint, Section } from "@/lib/blueprint/schema";
import type { FidelityReport } from "@/lib/fidelity/types";
import { buildPreviewUrl, previewChannelName } from "@/lib/preview/url";

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
}

/** Sections nest, so anything that looks one up has to walk the whole tree. */
function flattenSections(sections: Section[]): Section[] {
  return sections.flatMap((section) => [section, ...flattenSections(childrenOf(section))]);
}

/**
 * `children` as an array, whatever the store handed back.
 *
 * The API returns saved blueprints as raw JSON without re-parsing them, so the
 * schema's `children: []` default has never been applied to anything written
 * before containers existed — the field is simply absent. Reading it straight
 * threw here, and because this runs during the studio's first render the whole
 * page came down with it, taking the preview iframe with it. The Angular host
 * (`section-host.component.ts`) and the emitter guard the same way.
 */
function childrenOf(section: Section): Section[] {
  return section.children ?? [];
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
  const count = childrenOf(section).length;
  const shape = props.direction === "row" ? "Row" : "Stack";
  return `${shape} · ${count} item${count === 1 ? "" : "s"}`;
}

const LAYOUT_ICON: Record<string, (p: { size?: number }) => React.ReactElement> = {
  row: RowIcon,
  grid: GridIcon,
};

const VIEWPORT_ICON: Record<ViewportName, (p: { size?: number }) => React.ReactElement> = {
  desktop: DesktopIcon,
  tablet: TabletIcon,
  mobile: MobileIcon,
};

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
                {isLayout ? (
                  (() => {
                    const LayoutIcon = LAYOUT_ICON[String(props.direction)] ?? StackIcon;
                    return <LayoutIcon size={11} />;
                  })()
                ) : section.source === "zm-careers-lib" ? (
                  "fn"
                ) : (
                  "—"
                )}
              </span>
              <span
                className="label"
                style={isLayout ? { color: "var(--l-text-2)", fontStyle: "italic" } : undefined}
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
              (childrenOf(section).length > 0 ? (
                <SectionRows
                  sections={childrenOf(section)}
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
  const [showCatalog, setShowCatalog] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  /** Bumped after every change so the preview frame reloads the blueprint. */
  const [previewKey, setPreviewKey] = useState(0);

  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [activity, setActivity] = useState<{ tool: string; summary: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const [fidelity, setFidelity] = useState<FidelityReport | null>(null);
  const [fidelityError, setFidelityError] = useState("");
  const [checking, setChecking] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const kickedOff = useRef(false);
  /** The in-flight agent turn, so Stop can abort the request and model call. */
  const abortRef = useRef<AbortController | null>(null);
  /** The blueprint version the review has already been run for. */
  const fidelityRun = useRef(-1);
  /** Tells any open full-preview tab to reload after a change lands. */
  const previewChannel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(previewChannelName(projectId));
    previewChannel.current = channel;
    return () => {
      channel.close();
      previewChannel.current = null;
    };
  }, [projectId]);

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
    // Any full-preview tab open in another window holds its own copy too.
    previewChannel.current?.postMessage({ type: "reload" });

    return next;
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    (async () => {
      const response = await fetch("/api/preview-config");
      if (!response.ok) return;
      setSettings((await response.json()) as PreviewSettings);
    })();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [streaming, activity, data?.conversation.length]);

  /*
    The fidelity gate. A Figma import lands in "reviewing" and the studio stays
    shut until an administrator has seen the comparison and approved it. Base
    projects have no design to compare against, so they are never gated —
    checked explicitly, because gating one would strand it forever.
  */
  const gated = data?.project.status === "reviewing" && data.project.entryPoint !== "base";
  const reviewVersion = data?.project.currentVersion ?? 0;

  /** Runs the comparison again — a real browser over the preview, so it is slow. */
  const checkFidelity = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/fidelity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not check the site against the design");
      setFidelity(body.report as FidelityReport);
      setFidelityError("");
    } catch (caught) {
      // A report that will not come must not lock the admin out; the review
      // screen falls back to letting them judge the preview by eye.
      setFidelityError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }, [projectId]);

  const loadFidelity = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/fidelity`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not load the fidelity report");
      if (body.report) {
        setFidelity(body.report as FidelityReport);
        setFidelityError("");
        return;
      }
      if (!body.available) throw new Error(body.reason ?? "There is nothing to compare this site to");
      // Nothing stored yet, so the first look at this screen is what runs it.
      await checkFidelity();
    } catch (caught) {
      setFidelity(null);
      setFidelityError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [checkFidelity, projectId]);

  // Re-read on every new version too: fixes sent from the review screen leave
  // the report on screen a version out of date. Guarded by version because the
  // first load can start a capture, which is expensive and runs twice in dev.
  useEffect(() => {
    if (!gated || fidelityRun.current === reviewVersion) return;
    fidelityRun.current = reviewVersion;
    void loadFidelity();
  }, [gated, loadFidelity, reviewVersion]);

  const send = useCallback(
    async (message: string) => {
      if (!message.trim() || busy) return;
      setBusy(true);
      setError("");
      setStreaming("");
      setActivity([]);
      setDraft("");

      const controller = new AbortController();
      abortRef.current = controller;

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
          signal: controller.signal,
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
        // A Stop is a deliberate cancellation, not an error — keep the partial
        // reply the server already persisted and reload quietly.
        if (caught instanceof DOMException && caught.name === "AbortError") {
          await load();
        } else {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        abortRef.current = null;
        setStreaming("");
        setActivity([]);
        setBusy(false);
      }
    },
    [busy, load, pageId, projectId, selectedSectionId],
  );

  /** Aborts the running turn; the server keeps whatever streamed so far. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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

  if (error && !data) {
    return (
      <main className="start">
        <h1>Could not open this project</h1>
        <div className="notice" style={{ borderLeftColor: "var(--l-bad)" }}>{error}</div>
        <p style={{ marginTop: 20 }}>
          <a href="/projects/new">Back to the start</a>
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="start studio-loading">
        <span className="brand-mark">
          <SparkMark size={22} />
        </span>
        <div className="spinner" aria-hidden="true" />
        <p className="loading-text">Loading your site studio…</p>
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

  if (gated) {
    return (
      <FidelityReview
        projectId={projectId}
        projectName={blueprint?.company.name ?? data.project.name}
        report={fidelity}
        loadError={fidelityError}
        checking={checking}
        onRecheck={checkFidelity}
        sending={busy}
        sendError={error}
        // The assistant answers into the same transcript the chat panel uses;
        // the review shows the tail of it so a fix request is not a black box.
        agentReply={
          data.conversation.filter((turn) => turn.role === "assistant").at(-1)?.content ?? ""
        }
        onSendFixes={async (message) => {
          await send(message);
          // The assistant re-runs the check itself, so pick up whatever it left
          // behind rather than showing the report it was asked to fix.
          await loadFidelity();
        }}
        onApproved={() => {
          void load();
        }}
      />
    );
  }

  return (
    <div className="studio">
      {showPublish && (
        <PublishPanel
          projectId={projectId}
          companyName={blueprint?.company.name ?? data.project.name}
          blocking={errors.length}
          onClose={() => setShowPublish(false)}
          onPublished={() => {
            void load();
          }}
        />
      )}

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

      {showStyleEditor && blueprint && (
        <StyleEditor
          projectId={projectId}
          blueprint={blueprint}
          onClose={() => setShowStyleEditor(false)}
          onSaved={() => {
            void load();
            setShowStyleEditor(false);
          }}
        />
      )}

      <header className="topbar">
        <span className="brand-mark">
          <SparkMark size={16} />
        </span>
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
        {data.project.status === "deployed" && <span className="tag tag-good">published</span>}

        <span className="spacer" />

        <button className="btn btn-sm" onClick={() => setShowHistory((v) => !v)}>
          <HistoryIcon size={14} />
          History
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setShowPublish(true)}
          disabled={busy || !blueprint || errors.length > 0}
          title={
            errors.length > 0
              ? "Fix the blocking issues first"
              : "File the request, push the site to GitHub and deploy it"
          }
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
              <PlusIcon size={13} />
              Add
            </button>
          )}
        </div>

        {showHistory ? (
          <div style={{ padding: "8px 0" }}>
            {data.versions.length === 0 && <div className="faint" style={{ padding: "8px 14px" }}>No versions yet.</div>}
            {data.versions.map((version) => (
              <div key={version.version} style={{ padding: "9px 14px", borderBottom: "1px solid var(--l-border-soft)" }}>
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
                <PageIcon size={13} style={{ color: "var(--l-text-4)", flex: "none" }} />
                <strong style={{ color: "var(--l-text)" }}>{page.name}</strong>
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
        <div className="panel-head">
          <span className={`agent-status ${busy ? "is-working" : ""}`}>
            <SparkMark size={12} />
          </span>
          Assistant
          {busy && (
            <span className="faint" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>
              working…
            </span>
          )}
        </div>
        {busy && <div className="agent-progress" aria-hidden="true" />}

        <div className="chat-log" ref={logRef}>
          {data.conversation.length === 0 && !streaming && (
            <div className="empty-state">
              <ChatGlyph size={26} />
              <p>
                Describe what you want to change. Click any part of the preview first and the
                assistant will know what you mean by “this”.
              </p>
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
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
              <span>Thinking…</span>
            </div>
          )}

          {error && (
            <div className="notice" style={{ borderLeftColor: "var(--l-bad)", marginTop: 4 }}>
              {error}
            </div>
          )}
        </div>

        <div className="composer">
          {selectedSection && (
            <div className="selected-chip">
              Editing: {blueprint?.pages.find((p) => p.id === pageId)?.name} → {selectedSection.label}
              <button
                className="btn btn-sm"
                style={{ padding: "0 5px" }}
                onClick={() => setSelectedSectionId("")}
                aria-label="Stop editing this section"
              >
                <CloseIcon size={11} />
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 8,
            }}
          >
            <button
              className="btn btn-sm"
              onClick={stop}
              disabled={!busy}
              title="Stop the assistant"
              style={{ visibility: busy ? "visible" : "hidden" }}
            >
              Stop
              <StopIcon size={13} />
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => send(draft)}
              disabled={busy || !draft.trim()}
            >
              Send
              <SendIcon size={13} />
            </button>
          </div>
        </div>
      </section>

      {/* Right — live preview */}
      <section className="panel panel-preview">
        <div className="panel-head">
          Preview
          {settings && (
            <button
              className="btn btn-sm"
              onClick={() =>
                window.open(
                  `/studio/${projectId}/full-preview?page=${encodeURIComponent(pageId)}`,
                  `full-preview-${projectId}`,
                )
              }
              title="Open the full, unclipped preview in a new tab"
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              <ExternalLinkIcon size={13} />
              Open full preview
            </button>
          )}
          
          <button
            className="btn btn-sm"
            onClick={() => setPreviewKey((key) => key + 1)}
            title="Reload the preview"
            aria-label="Reload the preview"
          >
            <ReloadIcon size={13} />
          </button>
          {blueprint && (
            <button
              className="btn btn-sm"
              onClick={() => setShowStyleEditor(true)}
              title="Make live style edits — colours and company copy"
              style={{ textTransform: "none", letterSpacing: 0 }}
            >
              <PaletteIcon size={13} />
              Edit styles
            </button>
          )}
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
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => window.open(`/preview/${projectId}`, "_blank", "noopener,noreferrer")}
            title="Open the full-page preview in a new tab"
            aria-label="Open full-page preview"
          >
            <ExpandIcon size={13} />
          </button>

          <div className="viewport-switch" role="group" aria-label="Preview viewport">
            {(Object.keys(VIEWPORTS) as ViewportName[]).map((name) => {
              const ViewportIcon = VIEWPORT_ICON[name];
              return (
                <button
                  key={name}
                  type="button"
                  className={`viewport-switch-btn ${viewport === name ? "is-on" : ""}`}
                  onClick={() => setViewport(name)}
                  title={`${VIEWPORTS[name].label} — ${VIEWPORTS[name].width}px`}
                  aria-label={VIEWPORTS[name].label}
                  aria-pressed={viewport === name}
                >
                  <ViewportIcon size={15} />
                </button>
              );
            })}
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="live-indicator" title="The preview always pulls live job data from the Careers API">
            <span className="live-dot" />
            Live Careers API
          </span>
        </div>

        <div className="preview-scroll">
          {blueprint && settings ? (
            <PreviewFrame
              projectId={projectId}
              pageId={pageId}
              viewport={viewport}
              previewOrigin={settings.previewOrigin}
              selectedSectionId={selectedSectionId}
              onSelect={setSelectedSectionId}
              reloadKey={previewKey}
            />
          ) : (
            <div className="empty-state" style={{ alignSelf: "center" }}>
              <PreviewGlyph size={28} className={blueprint ? "is-pulsing" : undefined} />
              <p>{blueprint ? "Starting the preview…" : "The preview appears once there is a site to show."}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
