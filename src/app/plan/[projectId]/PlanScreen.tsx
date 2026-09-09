"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface PlanSection {
  id: string;
  type: string;
  source: "zm-careers-lib" | "custom";
  label: string;
  rationale: string;
  confidence: number;
  figmaNodeId: string;
}

interface Plan {
  companyName: string;
  tagline: string;
  tokens: { primary: string; secondary: string; accent: string; background: string; text: string; headingFont: string };
  pages: { id: string; name: string; path: string; sections: PlanSection[] }[];
  unsupported: { request: string; reason: string }[];
  assumptions: string[];
}

interface ImportResult {
  plan: Plan;
  dropped: { section: string; reason: string }[];
  backend: string;
  fileName: string;
  warnings: string[];
}

/**
 * Screen 2 — the AI Site Plan.
 *
 * This screen exists to make the import auditable. Every section shows what the
 * agent read it as, why, and how sure it was, so an administrator approves a
 * set of decisions rather than a black box. Nothing is built until they do.
 */
export function PlanScreen({ projectId, figmaUrl }: { projectId: string; figmaUrl: string }) {
  const router = useRouter();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [approving, setApproving] = useState(false);
  // React runs effects twice in dev StrictMode; the import is expensive.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/import-figma`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ figmaUrl }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "The import failed");
        setResult(data as ImportResult);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [projectId, figmaUrl]);

  async function approve() {
    setApproving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/plan`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        // The reason is in `issues`, and without it "does not validate" is a
        // dead end: the admin cannot tell which band is at fault or what to
        // ask the agent to fix.
        throw new Error(
          [
            data.error ?? "Could not build the site",
            ...(Array.isArray(data.issues)
              ? data.issues.map(
                  (issue: { path?: string; message?: string }) =>
                    `${issue.path ? `${issue.path}: ` : ""}${issue.message ?? ""}`,
                )
              : []),
          ].join("\n"),
        );
      }
      router.push(`/studio/${projectId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setApproving(false);
    }
  }

  if (error) {
    return (
      <main className="plan">
        <h1>{result ? "Could not build the site" : "Import failed"}</h1>
        <div className="notice" style={{ borderLeftColor: "var(--bad)", whiteSpace: "pre-line" }}>
          {error}
        </div>
        <p style={{ marginTop: 20 }}>
          <a href="/projects/new">Back to the start</a>
        </p>
      </main>
    );
  }

  if (!result) {
    return (
      <main className="plan">
        <h1>Reading the design…</h1>
        <p className="muted" style={{ marginTop: 10 }}>
          Fetching the file, flattening each frame into sections, and working out what each one is.
          This takes a moment on a real design.
        </p>
      </main>
    );
  }

  const { plan } = result;
  const functionalCount = plan.pages.reduce(
    (total, page) => total + page.sections.filter((s) => s.source === "zm-careers-lib").length,
    0,
  );

  return (
    <main className="plan">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1>{plan.companyName}</h1>
        <span className="muted">{plan.tagline}</span>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        From <strong>{result.fileName}</strong> via the {result.backend} backend —{" "}
        {plan.pages.length} page{plan.pages.length === 1 ? "" : "s"}, {functionalCount} approved
        component{functionalCount === 1 ? "" : "s"} mapped.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
        {(["primary", "secondary", "accent", "background", "text"] as const).map((key) => (
          <span key={key} className="tag" title={plan.tokens[key]}>
            <i
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                background: plan.tokens[key],
                border: "1px solid var(--border)",
                display: "inline-block",
              }}
            />
            {key}
          </span>
        ))}
        <span className="tag">{plan.tokens.headingFont}</span>
      </div>

      {plan.pages.map((page) => (
        <section key={page.id} className="plan-page">
          <header>
            <strong>{page.name}</strong>
            <span className="mono faint">{page.path}</span>
          </header>
          {page.sections.map((section) => (
            <div key={section.id} className="plan-section">
              <span
                className={`tag ${section.source === "zm-careers-lib" ? "tag-fn" : "tag-static"}`}
                style={{ padding: "2px 4px", justifySelf: "center" }}
                title={section.source === "zm-careers-lib" ? "Approved functional component" : "Content section"}
              >
                {section.source === "zm-careers-lib" ? "fn" : "—"}
              </span>
              <div>
                <div>{section.label}</div>
                <div className="plan-why">{section.rationale}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="faint mono">{Math.round(section.confidence * 100)}%</span>
                <div className="conf">
                  <i
                    style={{
                      width: `${Math.round(section.confidence * 100)}%`,
                      background:
                        section.confidence >= 0.7 ? "var(--good)" : section.confidence >= 0.45 ? "var(--warn)" : "var(--bad)",
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}

      {plan.unsupported.length > 0 && (
        <div className="notice">
          <strong>The design implies functionality the library does not have</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {plan.unsupported.map((item, index) => (
              <li key={index} className="muted">
                {item.request} — <span className="faint">{item.reason}</span>
              </li>
            ))}
          </ul>
          <div className="faint" style={{ marginTop: 8, fontSize: 12.5 }}>
            These are recorded on the project rather than built. Everything else proceeds normally.
          </div>
        </div>
      )}

      {plan.assumptions.length > 0 && (
        <div className="notice">
          <strong>Worth checking</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {plan.assumptions.map((assumption, index) => (
              <li key={index} className="muted">
                {assumption}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.dropped.length > 0 && (
        <div className="notice">
          <strong>Dropped during validation</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {result.dropped.map((item, index) => (
              <li key={index} className="muted">
                {item.section} — <span className="faint">{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="notice">
          {result.warnings.map((warning, index) => (
            <div key={index} className="muted">
              {warning}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 26 }}>
        <button className="btn btn-primary" onClick={approve} disabled={approving}>
          {approving ? "Building…" : "Approve and build"}
        </button>
        <a className="btn" href={`/studio/${projectId}`}>
          Edit the plan in the studio
        </a>
      </div>
    </main>
  );
}
