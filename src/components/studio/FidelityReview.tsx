"use client";

import { useState } from "react";
import type { BandComparison, FidelityReport, TokenComparison } from "@/lib/fidelity/types";

/**
 * Screen 2b — the design fidelity review.
 *
 * A sibling of the plan screen: evidence first, then a human decision. The plan
 * screen makes the *reading* of the design auditable; this one makes the
 * *building* of it auditable, and the studio stays shut until an administrator
 * says the built site is the design.
 *
 * It is deliberately not a threshold. The preview runs the approved component
 * library, so the built page can be right and still look nothing like the
 * drawing — only a person can tell those two cases apart.
 */

interface VerdictStyle {
  /** What the row says it is, in the reviewer's words rather than the type's. */
  label: string;
  tag: string;
  /** Left rail: red for the ones that block, amber for the ones to look at. */
  rail: string;
  meaning: string;
}

const VERDICTS: Record<BandComparison["verdict"], VerdictStyle> = {
  matched: {
    label: "matched",
    tag: "tag-good",
    rail: "",
    meaning: "A section was built for this band.",
  },
  "low-confidence": {
    label: "unsure",
    tag: "tag-warn",
    rail: "is-watch",
    meaning: "Built, but the analysis was not confident this is the right component. Worth a look.",
  },
  unbuilt: {
    label: "unbuilt",
    tag: "tag-warn",
    rail: "is-watch",
    meaning: "Matched to a section the preview does not render yet, so it is missing from the shot.",
  },
  missing: {
    label: "missing",
    tag: "tag-bad",
    rail: "is-blocking",
    meaning: "The design has this band and the built page has nothing for it.",
  },
  extra: {
    label: "extra",
    tag: "tag-bad",
    rail: "is-blocking",
    meaning: "The built page has this section and no band in the design accounts for it.",
  },
};

const BLOCKING: BandComparison["verdict"][] = ["missing", "extra"];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function barColour(value: number): string {
  return value >= 0.7 ? "var(--l-good)" : value >= 0.45 ? "var(--l-warn)" : "var(--l-bad)";
}

/** Token values are mostly colours; a swatch reads faster than a hex string. */
function TokenValue({ value }: { value: string }) {
  const isColour = /^#[0-9a-f]{3,8}$/i.test(value.trim());
  return (
    <span className="mono">
      {isColour && <i className="swatch" style={{ background: value }} />}
      {value || <span className="faint">not set</span>}
    </span>
  );
}

/**
 * The message the "send fixes" button hands the assistant. It names the bands
 * rather than describing the screen, so the agent can act on it without the
 * admin retyping anything.
 */
function fixMessage(report: FidelityReport): string {
  const missing = report.bands.filter((band) => band.verdict === "missing");
  const extra = report.bands.filter((band) => band.verdict === "extra");
  const watch = report.bands.filter(
    (band) => band.verdict === "low-confidence" || band.verdict === "unbuilt",
  );
  const badTokens = report.tokens.filter((token) => !token.match);
  const blocking = missing.length + extra.length;

  const lines: string[] = [
    blocking > 0
      ? "The fidelity check against the imported design found differences I want fixed before I approve the site."
      : "The fidelity check against the imported design flagged a few things I want you to look at before I approve the site.",
    "",
  ];

  for (const band of missing) {
    lines.push(
      `- Missing: the design band “${band.designName}”${band.ref ? ` (Figma node ${band.ref})` : ""} has no section on the page. Read that band and build the section it should be, at position ${band.designIndex + 1} in the design order.`,
    );
  }
  for (const band of extra) {
    lines.push(
      `- Extra: the section “${band.sectionLabel || band.sectionId}” is on the page but nothing in the design asks for it. Check it against the design and remove it if it does not belong.`,
    );
  }
  for (const token of badTokens) {
    lines.push(
      `- Token: ${token.name} is ${token.built || "unset"} on the site but ${token.design} in the design.`,
    );
  }
  if (watch.length > 0) {
    lines.push(
      "",
      `Worth a second look, not blocking: ${watch
        .map((band) => `“${band.designName}” → ${band.sectionLabel || band.sectionId}`)
        .join(", ")}.`,
    );
  }

  lines.push("", "Leave everything else as it is, then re-run the fidelity check.");
  return lines.join("\n");
}

function BandRow({ band }: { band: BandComparison }) {
  const verdict = VERDICTS[band.verdict];
  const moved =
    band.designIndex >= 0 && band.builtIndex >= 0 && band.designIndex !== band.builtIndex;

  return (
    <div className={`fidelity-band ${verdict.rail}`}>
      <span className={`tag ${verdict.tag}`} title={verdict.meaning}>
        {verdict.label}
      </span>

      <div>
        <div>
          {band.designName || <span className="faint">unnamed band</span>}
          {band.designHeightPx > 0 && (
            <span className="faint mono"> {Math.round(band.designHeightPx)}px</span>
          )}
          <span className="faint"> → </span>
          {band.sectionLabel || <span className="faint">nothing built</span>}
        </div>
        <div className="fidelity-note">{verdict.meaning}</div>
        {moved && (
          <div className="fidelity-note">
            Order differs — {band.designIndex + 1} in the design, {band.builtIndex + 1} on the page.
          </div>
        )}
        {band.notes.map((note, index) => (
          <div key={index} className="fidelity-note">
            {note}
          </div>
        ))}
      </div>

      <div style={{ textAlign: "right", minWidth: 62 }}>
        {typeof band.confidence === "number" ? (
          <>
            <span className="faint mono">{percent(band.confidence)}</span>
            <div className="conf">
              <i
                style={{
                  width: percent(band.confidence),
                  background: barColour(band.confidence),
                }}
              />
            </div>
            <div className="fidelity-col">read</div>
          </>
        ) : (
          <span className="faint mono">—</span>
        )}
      </div>

      <div style={{ textAlign: "right", minWidth: 62 }}>
        {typeof band.visualScore === "number" ? (
          <>
            <span className="faint mono">{percent(band.visualScore)}</span>
            <div className="conf">
              <i
                style={{
                  width: percent(band.visualScore),
                  background: barColour(band.visualScore),
                }}
              />
            </div>
            <div className="fidelity-col">visual</div>
          </>
        ) : (
          <span className="faint mono">—</span>
        )}
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: TokenComparison }) {
  return (
    <div className={`fidelity-token ${token.match ? "" : "is-off"}`}>
      <span>{token.name}</span>
      <TokenValue value={token.design} />
      <TokenValue value={token.built} />
      <span className={`tag ${token.match ? "tag-good" : "tag-bad"}`}>
        {token.match ? "same" : "differs"}
      </span>
    </div>
  );
}

export function FidelityReview({
  projectId,
  projectName,
  report,
  loadError,
  checking,
  onRecheck,
  sending,
  sendError,
  agentReply,
  onSendFixes,
  onApproved,
}: {
  projectId: string;
  projectName: string;
  report: FidelityReport | null;
  loadError: string;
  checking: boolean;
  onRecheck: () => Promise<void> | void;
  sending: boolean;
  sendError: string;
  agentReply: string;
  onSendFixes: (message: string) => Promise<void> | void;
  onApproved: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const [failure, setFailure] = useState("");
  const [sentFixes, setSentFixes] = useState(false);

  async function approve() {
    setApproving(true);
    setFailure("");
    try {
      const response = await fetch(`/api/projects/${projectId}/fidelity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not record the approval");

      // The studio reloads the project and the gate lifts, so leave the button
      // in its working state rather than flashing back to idle.
      onApproved();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : String(caught));
      setApproving(false);
    }
  }

  async function sendFixes() {
    if (!report) return;
    setSentFixes(true);
    await onSendFixes(fixMessage(report));
  }

  if (!report) {
    return (
      <main className="fidelity">
        <h1>{loadError ? "The check could not be run" : "Checking the build against the design…"}</h1>
        {loadError ? (
          <>
            <div className="notice" style={{ borderLeftColor: "var(--l-bad)" }}>{loadError}</div>
            <p className="muted" style={{ marginTop: 12 }}>
              The check is evidence, not a lock. Run it again if that was a passing problem, or open
              the studio and compare against the design by eye in the preview.
            </p>
            {failure && (
              <div className="notice" style={{ borderLeftColor: "var(--l-bad)" }}>{failure}</div>
            )}
            <div className="fidelity-actions">
              <button className="btn btn-primary" onClick={approve} disabled={approving || checking}>
                {approving ? "Opening the studio…" : "Approve and start editing"}
              </button>
              <button className="btn" onClick={() => onRecheck()} disabled={checking || approving}>
                {checking ? "Checking…" : "Run the check again"}
              </button>
            </div>
          </>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            Rendering the built page, matching each section back to the band it came from, and
            comparing the two. This takes a moment.
          </p>
        )}
      </main>
    );
  }

  const blocking = report.bands.filter((band) => BLOCKING.includes(band.verdict));
  const watch = report.bands.filter(
    (band) => band.verdict === "low-confidence" || band.verdict === "unbuilt",
  );
  const badTokens = report.tokens.filter((token) => !token.match);
  const captured = !report.capture.unavailable;

  return (
    <main className="fidelity">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1>Does the site match the design?</h1>
        <span className="muted">{projectName}</span>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        {report.summary.matched} of {report.summary.total} bands built from the design
        {badTokens.length > 0 && `, ${badTokens.length} token${badTokens.length === 1 ? "" : "s"} off`}
        {blocking.length > 0
          ? `, ${blocking.length} difference${blocking.length === 1 ? "" : "s"} that should be fixed first`
          : ", nothing blocking"}
        . Version {report.version} · checked {new Date(report.generatedAt).toLocaleString()}.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <span className="tag tag-good">{report.summary.matched} matched</span>
        {blocking.length > 0 && <span className="tag tag-bad">{blocking.length} blocking</span>}
        {watch.length > 0 && <span className="tag tag-warn">{watch.length} to look at</span>}
      </div>

      {report.capture.unavailable ? (
        <div className="notice">
          <strong>No screenshots this time</strong>
          <div className="muted" style={{ marginTop: 6 }}>{report.capture.unavailable}</div>
          <div className="faint" style={{ marginTop: 8, fontSize: 12.5 }}>
            Everything below is still exact — the bands, the order and the tokens are compared from
            the design and the blueprint, not from the pictures. Only the visual score is missing.
          </div>
        </div>
      ) : (
        <>
          <div className="fidelity-shots">
            <figure className="fidelity-shot">
              <header>
                <strong>The design</strong>
                <span className="faint mono">Figma {report.frameId}</span>
              </header>
              <div className="shot-body">
                {report.capture.designImageUrl ? (
                  <img src={report.capture.designImageUrl} alt="The imported Figma design" />
                ) : (
                  <span className="faint" style={{ padding: 24 }}>The design frame did not render.</span>
                )}
              </div>
            </figure>

            <figure className="fidelity-shot">
              <header>
                <strong>The built preview</strong>
                <span className="faint mono">{report.capture.viewportWidth}px</span>
              </header>
              <div className="shot-body">
                {report.capture.previewImageUrl ? (
                  <img src={report.capture.previewImageUrl} alt="The built career site preview" />
                ) : (
                  <span className="faint" style={{ padding: 24 }}>The preview did not render.</span>
                )}
              </div>
            </figure>
          </div>
          <div className="faint" style={{ marginTop: 8, fontSize: 12.5 }}>
            Captured {new Date(report.capture.capturedAt).toLocaleString()} at{" "}
            {report.capture.viewportWidth}px wide.
          </div>
        </>
      )}

      {captured && (
        <div className="notice">
          <strong>Read the visual score as evidence, not a mark</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            The preview renders the real approved component library. A library component brings its
            own markup, spacing and typography, so it will never match a bespoke design pixel for
            pixel — where an approved component replaced a hand-drawn one, a low visual score is the
            expected result, not a fault. The score tells you where to look; whether the built page
            is right is your call. That is why this screen ends in your decision instead of a pass
            mark.
          </div>
        </div>
      )}

      <section className="plan-page">
        <header>
          <strong>Band by band</strong>
          <span className="faint">every frame in the design, and what it became</span>
        </header>
        {report.bands.length === 0 ? (
          <div className="faint" style={{ padding: "14px 16px" }}>
            The design had no bands to compare.
          </div>
        ) : (
          report.bands.map((band, index) => <BandRow key={`${band.ref}-${index}`} band={band} />)
        )}
      </section>

      <section className="plan-page">
        <header>
          <strong>Tokens</strong>
          <span className="faint">design value against what the site uses</span>
        </header>
        {report.tokens.length === 0 ? (
          <div className="faint" style={{ padding: "14px 16px" }}>
            The design carried no tokens to compare.
          </div>
        ) : (
          <>
            <div className="fidelity-token is-head">
              <span>Token</span>
              <span>In the design</span>
              <span>Built</span>
              <span />
            </div>
            {report.tokens.map((token) => (
              <TokenRow key={token.name} token={token} />
            ))}
          </>
        )}
      </section>

      {sentFixes && (
        <div className="notice">
          {sending ? (
            <div className="activity">
              <span className="dot" />
              <span>The assistant is working through the fixes…</span>
            </div>
          ) : (
            <>
              <strong>The assistant has the list</strong>
              {agentReply && (
                <div className="turn-assistant" style={{ marginTop: 6 }}>{agentReply}</div>
              )}
              <div className="faint" style={{ marginTop: 8, fontSize: 12.5 }}>
                This report refreshes once it has rebuilt and re-checked. You can still approve as
                it stands.
              </div>
            </>
          )}
        </div>
      )}

      {(failure || sendError) && (
        <div className="notice" style={{ borderLeftColor: "var(--l-bad)" }}>{failure || sendError}</div>
      )}

      <div className="fidelity-actions">
        {blocking.length > 0 ? (
          <>
            <button className="btn btn-primary" onClick={sendFixes} disabled={sending || approving || checking}>
              {sending ? "Sending…" : `Send ${blocking.length} fix${blocking.length === 1 ? "" : "es"} to the agent`}
            </button>
            <button className="btn" onClick={approve} disabled={approving || sending || checking}>
              {approving ? "Opening the studio…" : "Approve anyway and start editing"}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={approve} disabled={approving || sending || checking}>
              {approving ? "Opening the studio…" : "Approve and start editing"}
            </button>
            <button
              className="btn"
              onClick={sendFixes}
              disabled={sending || approving || checking || watch.length + badTokens.length === 0}
              title={
                watch.length + badTokens.length === 0
                  ? "Nothing is flagged for the agent to fix"
                  : "Hand the flagged bands to the assistant"
              }
            >
              {sending ? "Sending…" : "Send fixes to the agent"}
            </button>
          </>
        )}
        <button className="btn" onClick={() => onRecheck()} disabled={checking || approving || sending}>
          {checking ? "Checking…" : "Run the check again"}
        </button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          Approving unlocks editing. Nothing is published either way.
        </span>
      </div>
    </main>
  );
}
