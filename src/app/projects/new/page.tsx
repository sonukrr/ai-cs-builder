import { capabilities } from "@/lib/agent/capabilities";
import { hasApiKey } from "@/lib/agent/client";
import { registry } from "@/lib/registry";
import { StartPoints } from "./StartPoints";

export const dynamic = "force-dynamic";

/**
 * Screen 1 — choose a starting point.
 *
 * The capability strip below the cards is deliberate: an administrator finds
 * out that the base repository has not been configured yet *here*, before
 * committing to a flow, rather than from a failure three screens in.
 */
export default function NewProject() {
  const caps = capabilities();
  const figma = caps.find((c) => c.id === "IMPORT_FIGMA")!;
  const base = caps.find((c) => c.id === "START_FROM_BASE")!;

  return (
    <main className="start">
      <h1>Career Site Studio</h1>
      <p className="start-sub">
        Build your career site by describing it. Functional pieces — job search, filters,
        applications — come from the approved {registry.package.name} library, so what you build is
        what engineering already supports.
      </p>

      <StartPoints figmaState={figma.state} figmaDetail={figma.detail} baseDetail={base.detail} baseState={base.state} />

      {!hasApiKey() && (
        <div className="notice">
          <strong>ANTHROPIC_API_KEY is not set.</strong>{" "}
          <span className="muted">
            Copy <code className="mono">.env.example</code> to <code className="mono">.env.local</code> and add a key —
            the agent cannot run without one.
          </span>
        </div>
      )}

      <div className="cap-grid">
        <div className="faint" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
          Agent capabilities
        </div>
        {caps.map((capability) => (
          <div key={capability.id} className="cap-row">
            <span
              className={`tag ${capability.state === "ready" ? "tag-good" : capability.state === "demo" ? "tag-warn" : "tag-bad"}`}
              style={{ flex: "none", marginTop: 2 }}
            >
              {capability.state === "ready" ? "ready" : capability.state === "demo" ? "demo" : "setup"}
            </span>
            <div>
              <strong>{capability.name}</strong>
              <div className="muted" style={{ fontSize: 13 }}>
                {capability.description}
              </div>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 3 }}>
                {capability.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
