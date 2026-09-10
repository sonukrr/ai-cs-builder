"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deployment, DeployTarget, DeployTargetKind } from "@/lib/blueprint/schema";

/**
 * Publishing, as a panel rather than a button.
 *
 * "Request publishing" used to file a request and say nothing more. What an
 * administrator actually wants at that moment is to put the site on the
 * internet, and what they need before doing it is the two facts a button cannot
 * carry: where it is going, and what will not work when it arrives.
 *
 * So this screen is built around the second one. The generated file list is
 * interesting; the warnings are the point. A React build cannot host the
 * approved Angular careers components, which means the deployed site will not
 * search or accept applications until someone integrates them — and the only
 * honest place to say that is here, before the publish, next to the button.
 *
 * The publish itself streams. It takes minutes, most of it a Vercel build, and
 * a spinner for three minutes is indistinguishable from a hang.
 */

interface PreviewFile {
  path: string;
  bytes: number;
}

interface DeployPreview {
  version: number;
  /** The target this preview was generated for. */
  kind: DeployTargetKind;
  /** The target the blueprint needs, whatever is selected. */
  recommended: DeployTargetKind;
  files: PreviewFile[];
  pages: { id: string; route: string; file: string }[];
  warnings: string[];
  notes: string[];
  pendingComponents: string[];
  /** Approved components the Angular target renders for real. */
  libraryComponents: string[];
  suggestedRepoName: string;
}

/**
 * The destination's state, from the server.
 *
 * `canWrite` is the one that matters and the one nothing else reveals: GitHub
 * reports a repository's permissions as the *user's* role, so a token missing
 * `contents=write` looks fine until something tries to push.
 */
interface Destination {
  repo: string;
  exists: boolean;
  canWrite: boolean | null;
  detail: string;
}

interface ProviderStatus {
  github: { backend: string; ready: boolean; detail: string };
  vercel: { ready: boolean; detail: string };
}

interface DeployState {
  target: DeployTarget | null;
  deployments: Deployment[];
  providers: ProviderStatus;
  preview: DeployPreview | null;
  issues: { level: string; path: string; message: string }[];
}

type DeployEvent =
  | { type: "text"; text: string }
  | { type: "activity"; tool: string; summary: string }
  | { type: "deployment"; deployment: Deployment }
  | { type: "done"; deployment: Deployment }
  | { type: "error"; message: string };

interface Props {
  projectId: string;
  companyName: string;
  /** Blocking validation issues; publishing is impossible while there are any. */
  blocking: number;
  onClose: () => void;
  /** Called when a publish finishes, so the studio can reload the project. */
  onPublished: () => void;
}

/** A repository reference we are willing to send: owner/name, or a GitHub URL. */
function looksLikeRepo(value: string): boolean {
  const trimmed = value.trim().replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return true;
  return /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(trimmed);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function PublishPanel({ projectId, companyName, blocking, onClose, onPublished }: Props) {
  const [state, setState] = useState<DeployState | null>(null);
  const [loadError, setLoadError] = useState("");

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [vercelProject, setVercelProject] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [allowNonEmpty, setAllowNonEmpty] = useState(false);
  const [notes, setNotes] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  /** Empty until chosen, so the server's recommendation wins on first load. */
  const [kind, setKind] = useState<DeployTargetKind | "">("");
  /** What the destination looks like: exists, empty, and writable by the token. */
  const [destination, setDestination] = useState<Destination | null>(null);
  const [checking, setChecking] = useState(false);

  const [publishing, setPublishing] = useState(false);
  const [activity, setActivity] = useState<{ tool: string; summary: string }[]>([]);
  const [report, setReport] = useState("");
  /**
   * The deployment as the agent updates it. Set from the `deployment` event as
   * well as from `done`, so a URL appears on screen as soon as there is one —
   * a publish takes minutes and the link is what everyone is waiting for.
   */
  const [result, setResult] = useState<Deployment | null>(null);
  const [error, setError] = useState("");

  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy${kind ? `?target=${kind}` : ""}`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not work out what would be published");
      const next = body as DeployState;
      setState(next);
      if (next.target) {
        setRepo(next.target.repo);
        setBranch(next.target.branch || "main");
        setVercelProject(next.target.vercelProject);
        setPrivate(next.target.private);
      }
      // Adopt whatever the server generated, so the radio matches the preview.
      if (next.preview) setKind(next.preview.kind);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [kind, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A stored destination is checked without waiting for the field to be
  // touched: its token may have been fine last month and not today.
  useEffect(() => {
    if (state?.target?.repo) void checkDestination();
    // Only when the stored target first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.target?.repo]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [activity, report]);

  const checkDestination = useCallback(async () => {
    const candidate = repo.trim();
    if (!looksLikeRepo(candidate)) {
      setDestination(null);
      return;
    }

    setChecking(true);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/deploy?check=${encodeURIComponent(candidate)}`,
      );
      const body = await response.json();
      setDestination(response.ok ? (body.destination as Destination) : null);
    } catch {
      // A failed check is not a failed publish; the publish reports for itself.
      setDestination(null);
    } finally {
      setChecking(false);
    }
  }, [projectId, repo]);

  async function publish() {
    if (publishing) return;
    if (missingRepo) {
      setError(
        repo.trim()
          ? `"${repo.trim()}" does not look like a GitHub repository. Give it as owner/name, or as a github.com URL.`
          : "Give the GitHub repository the site should be published to — owner/name, or a github.com URL.",
      );
      return;
    }

    setPublishing(true);
    setError("");
    setReport("");
    setActivity([]);
    setResult(null);

    try {
      /*
        The publish request is filed first, and the deployment carries its id.
        The governance trail from 07-base-site-flow.md does not stop being
        useful because publishing now really publishes — it is what ties a live
        URL back to a version and the person who asked for it.
      */
      let publishRequestId = "";
      const filed = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const filedBody = await filed.json().catch(() => ({}));
      if (filed.ok) publishRequestId = filedBody.request?.id ?? "";
      else if (filed.status === 422) {
        throw new Error(
          `The site does not validate: ${(filedBody.issues ?? [])
            .map((issue: { message: string }) => issue.message)
            .join("; ")}`,
        );
      }

      const response = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: repo.trim(),
          branch: branch.trim() || "main",
          target: kind || undefined,
          vercelProject: vercelProject.trim(),
          private: isPrivate,
          allowNonEmpty,
          notes: notes.trim(),
          publishRequestId,
        }),
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "The deploy agent is unavailable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // NDJSON, one event per line, with the incomplete tail held back.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as DeployEvent;

          if (event.type === "text") setReport((current) => current + event.text);
          else if (event.type === "activity")
            setActivity((current) => [...current, { tool: event.tool, summary: event.summary }]);
          else if (event.type === "error") setError(event.message);
          else if (event.type === "deployment") setResult(event.deployment);
          else if (event.type === "done") setResult(event.deployment);
        }
      }

      await load();
      onPublished();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPublishing(false);
    }
  }

  const preview = state?.preview;
  const providers = state?.providers;
  /*
    Deliberately only disabled while a publish is running. A disabled button
    with no explanation reads as a broken feature; anything actually wrong —
    no repository, a blueprint that does not validate — is said in words, and
    the publish itself is allowed to try and report what happened.
  */
  const missingRepo = !looksLikeRepo(repo);

  return (
    <div className="catalog-backdrop" onClick={publishing ? undefined : onClose}>
      <div className="catalog publish" onClick={(event) => event.stopPropagation()}>
        <div className="catalog-head">
          <div>
            <strong>Publish {companyName}</strong>
            <div className="faint" style={{ fontSize: 12.5 }}>
              {preview
                ? `Version ${preview.version} — ${preview.kind === "angular" ? "Angular" : "Next.js"}, ${
                    preview.files.length
                  } files, ${preview.pages.length} route${preview.pages.length === 1 ? "" : "s"}`
                : "Working out what would be published…"}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onClose} disabled={publishing}>
            {publishing ? "Publishing…" : "Close"}
          </button>
        </div>

        <div className="catalog-body">
          {loadError && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)" }}>
              {loadError}
            </div>
          )}

          {blocking > 0 && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)" }}>
              {blocking} blocking issue{blocking === 1 ? "" : "s"} in the site. Publishing anyway
              will build whatever the blueprint currently describes — the deploy agent reports what
              it could and could not generate.
            </div>
          )}

          {state?.issues && state.issues.length > 0 && (
            <div className="notice">
              {state.issues.map((issue) => issue.message).join(" · ")}
            </div>
          )}

          {preview && preview.libraryComponents.length > 0 && (
            <div className="notice" style={{ borderLeftColor: "var(--good)" }}>
              <strong>{preview.libraryComponents.length} approved careers components run for real</strong>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
                {preview.libraryComponents.join(", ")}
              </div>
            </div>
          )}

          {/* What will not work. Above the button, deliberately. */}
          {preview && preview.warnings.length > 0 && (
            <div className="publish-warnings">
              <strong>Before you publish</strong>
              <ul>
                {preview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {!publishing && (
            <>
              {/*
                The target, first, because it decides whether the deployed site
                can search and accept applications at all — and the answer is a
                property of the blueprint rather than a preference. The other
                option stays selectable, with what it costs written next to it.
              */}
              {preview && (
                <div className="publish-section">
                  <div className="publish-label">What gets built</div>
                  <label className="publish-check">
                    <input
                      type="radio"
                      name="publish-target"
                      checked={preview.kind === "angular"}
                      onChange={() => setKind("angular")}
                    />
                    <span>
                      <strong>Angular</strong> — installs the approved careers library, so job
                      search, listings, filters and the application flow are the real components.
                      {preview.recommended === "angular"
                        ? " This site needs it."
                        : " Not needed here: this site has no careers components."}
                    </span>
                  </label>
                  <label className="publish-check">
                    <input
                      type="radio"
                      name="publish-target"
                      checked={preview.kind === "react"}
                      onChange={() => setKind("react")}
                    />
                    <span>
                      <strong>React (Next.js)</strong> — the careers library is Angular, so
                      anything functional ships as a labelled gap.
                      {preview.recommended === "angular"
                        ? " Candidates could not search or apply."
                        : " Fine for this site."}
                    </span>
                  </label>
                </div>
              )}

              <div className="publish-section">
                <label className="publish-label" htmlFor="publish-repo">
                  GitHub repository
                </label>
                <input
                  id="publish-repo"
                  className="field"
                  value={repo}
                  onChange={(event) => {
                    setRepo(event.target.value);
                    setDestination(null);
                  }}
                  onBlur={() => void checkDestination()}
                  placeholder="acme-inc/careers-site"
                  spellCheck={false}
                  autoFocus
                />
                {checking && (
                  <div className="faint" style={{ fontSize: 12 }}>
                    Checking the destination…
                  </div>
                )}
                {destination && (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color:
                        destination.canWrite === false ? "var(--bad)" : "var(--text-dim)",
                    }}
                  >
                    {destination.canWrite === false ? "✗ " : "✓ "}
                    {destination.detail}
                  </div>
                )}
                <div className="faint" style={{ fontSize: 12 }}>
                  {missingRepo ? "Required — " : ""}owner/name, or a github.com URL. The studio
                  creates it if it does not exist.
                  {preview ? ` Suggested name: ${preview.suggestedRepoName}.` : ""}
                </div>
              </div>

              <div className="publish-row">
                <div className="publish-section">
                  <label className="publish-label" htmlFor="publish-branch">
                    Branch
                  </label>
                  <input
                    id="publish-branch"
                    className="field"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder="main"
                    spellCheck={false}
                  />
                </div>
                <div className="publish-section">
                  <label className="publish-label" htmlFor="publish-vercel">
                    Vercel project
                  </label>
                  <input
                    id="publish-vercel"
                    className="field"
                    value={vercelProject}
                    onChange={(event) => setVercelProject(event.target.value)}
                    placeholder="from the company name"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="publish-section">
                <label className="publish-check">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(event) => setPrivate(event.target.checked)}
                  />
                  <span>Create it as a private repository, if the studio has to create it</span>
                </label>
                <label className="publish-check">
                  <input
                    type="checkbox"
                    checked={allowNonEmpty}
                    onChange={(event) => setAllowNonEmpty(event.target.checked)}
                  />
                  <span>
                    Publish over whatever is already in this repository. Needed only when it holds
                    files this studio did not generate — the publish stops and asks otherwise.
                  </span>
                </label>
              </div>

              <div className="publish-section">
                <label className="publish-label" htmlFor="publish-notes">
                  Notes for the record (optional)
                </label>
                <textarea
                  id="publish-notes"
                  className="field"
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Why this is going out, anything the reviewer should know"
                />
              </div>

              {providers && (
                <div className="publish-status">
                  <div>
                    <span className={`tag ${providers.github.ready ? "tag-good" : "tag-warn"}`}>
                      GitHub · {providers.github.backend}
                    </span>
                    <span className="faint">{providers.github.detail}</span>
                  </div>
                  <div>
                    <span className={`tag ${providers.vercel.ready ? "tag-good" : "tag-warn"}`}>
                      Vercel
                    </span>
                    <span className="faint">{providers.vercel.detail}</span>
                  </div>
                </div>
              )}

              {preview && (
                <div className="publish-section">
                  <button className="btn btn-sm" onClick={() => setShowFiles((value) => !value)}>
                    {showFiles ? "Hide" : "Show"} the {preview.files.length} files
                  </button>
                  {showFiles && (
                    <div className="publish-files">
                      {preview.files.map((file) => (
                        <div key={file.path}>
                          <span className="mono">{file.path}</span>
                          <span className="faint">{kb(file.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {preview.notes.length > 0 && (
                    <details className="publish-notes">
                      <summary className="faint">{preview.notes.length} build notes</summary>
                      <ul>
                        {preview.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </>
          )}

          {(publishing || report || activity.length > 0) && (
            <div className="publish-log" ref={logRef}>
              {activity.map((entry, index) => (
                <div key={index} className="activity">
                  <span className="dot" />
                  <span>{entry.summary}</span>
                </div>
              ))}
              {publishing && activity.length === 0 && (
                <div className="activity">
                  <span className="dot" />
                  <span>Handing the site to the deploy agent…</span>
                </div>
              )}
              {report && <div className="turn-assistant">{report}</div>}
            </div>
          )}

          {error && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)" }}>
              {error}
            </div>
          )}

          {result && (
            <div
              className="notice"
              style={{
                borderLeftColor:
                  result.status === "running"
                    ? "var(--accent)"
                    : result.status === "succeeded"
                      ? "var(--good)"
                      : "var(--bad)",
              }}
            >
              <strong>
                {result.status === "running"
                  ? result.url
                    ? "Deploying — this link goes live when the build finishes."
                    : "Publishing…"
                  : result.status === "succeeded"
                    ? result.url
                      ? "Published."
                      : "Pushed, not deployed."
                    : "The publish failed."}
              </strong>

              {/* The URL in full, as the largest thing here. */}
              {result.url ? (
                <div style={{ marginTop: 8 }}>
                  <a
                    className="publish-live-url mono"
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {result.url}
                  </a>
                </div>
              ) : null}

              <div style={{ marginTop: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
                {result.commitUrl && (
                  <a href={result.commitUrl} target="_blank" rel="noopener noreferrer">
                    View the commit
                  </a>
                )}
                {result.inspectorUrl && (
                  <a href={result.inspectorUrl} target="_blank" rel="noopener noreferrer">
                    Vercel build log
                  </a>
                )}
                {/* Useful even when the deployment never got started. */}
                {result.repo && (
                  <a
                    href={`https://github.com/${result.repo}/tree/${result.branch}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {result.repo}
                  </a>
                )}
              </div>
              {result.warnings.length > 0 && (
                <ul style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                  {result.warnings.map((warning, index) => (
                    <li key={index} style={{ fontSize: 12.5 }}>
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state && state.deployments.length > 0 && !publishing && (
            <div className="publish-section">
              <div className="publish-label">Previous publishes</div>
              {state.deployments.slice(0, 4).map((deployment) => (
                <div key={deployment.id} className="publish-history">
                  <span className={`tag ${deployment.status === "succeeded" ? "tag-good" : "tag-bad"}`}>
                    v{deployment.version}
                  </span>
                  <span className="faint mono">{deployment.repo}</span>
                  {deployment.url ? (
                    <a href={deployment.url} target="_blank" rel="noopener noreferrer">
                      {deployment.url.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    <span className="faint">no live URL</span>
                  )}
                  <span className="faint" style={{ marginLeft: "auto", fontSize: 11.5 }}>
                    {new Date(deployment.startedAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="catalog-foot">
          <span className="faint" style={{ fontSize: 12 }}>
            {publishing
              ? "Generating, pushing and building. This takes a few minutes."
              : "The site is generated from the current version, pushed to GitHub, then deployed to Vercel."}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={publish} disabled={publishing}>
            {publishing ? "Publishing…" : result ? "Publish again" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}
