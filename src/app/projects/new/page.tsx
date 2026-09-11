import { capabilities } from "@/lib/agent/capabilities";
import { hasApiKey } from "@/lib/agent/client";
import { registry } from "@/lib/registry";
import { StartPoints } from "./StartPoints";
import {
  BrandMark,
  SparkleIcon,
  BoltIcon,
  ShieldIcon,
  CheckIcon,
  CAPABILITY_ICONS,
} from "./icons";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  ready: "Ready",
  demo: "Demo",
  "needs-config": "Setup",
};

/**
 * Screen 1 — the Careersite Builder landing.
 *
 * A modern AI-product landing that still carries the honest state the studio
 * depends on: the two entry points (Figma import, Start from base) advertise
 * their real capability state, and the agent-capability grid is rendered
 * straight from `capabilities()`, so an administrator sees what this deployment
 * can actually do *here*, before committing to a flow.
 */
export default function NewProject() {
  const caps = capabilities();
  const figma = caps.find((c) => c.id === "IMPORT_FIGMA")!;
  const base = caps.find((c) => c.id === "START_FROM_BASE")!;
  const readyCount = caps.filter((c) => c.state === "ready").length;
  const approvedComponents = registry.components.filter((c) => c.status === "approved").length;

  return (
    <div className="landing">
      <div className="l-aurora" aria-hidden="true" />

      <header className="l-header">
        <div className="l-header-inner">
          <a className="l-brand" href="/projects/new">
            <span className="l-brand-mark">
              <BrandMark size={20} />
            </span>
            <span className="l-brand-name">
              Career Site <span className="l-brand-accent">Studio</span>
            </span>
          </a>
          <nav className="l-nav">
            <a href="#capabilities">Capabilities</a>
            <a href="#start">How it works</a>
            <a
              href="https://github.com/sonukrr/ai-cs-builder"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
          <div className="l-header-actions">
            <span className="l-status-dot">
              <i /> {readyCount} agents ready
            </span>
            <a href="#start" className="l-btn l-btn--primary l-btn--sm">
              Start building
            </a>
          </div>
        </div>
      </header>

      <main className="l-main">
        {/* Hero */}
        <section className="l-hero">
          <span className="l-eyebrow">
            <SparkleIcon size={14} /> AI-powered Careersite Studio
          </span>
          <h1 className="l-hero-title">
            Build better career sites
            <br />
            with <span className="l-grad">AI agents.</span>
          </h1>
          <p className="l-hero-sub">
            Create, customize, and launch modern career experiences faster. Intelligent agents
            work alongside you — reading your design, wiring approved functionality, and shipping a
            site that&apos;s built on what engineering already supports.
          </p>
          <div className="l-hero-cta">
            <a href="#start" className="l-btn l-btn--primary l-btn--lg">
              <SparkleIcon size={17} /> Start building
            </a>
            <a href="#capabilities" className="l-btn l-btn--ghost l-btn--lg">
              Explore agent capabilities
            </a>
          </div>
          <ul className="l-hero-trust">
            <li>
              <CheckIcon size={15} /> {approvedComponents} approved components
            </li>
            <li>
              <ShieldIcon size={15} /> Never ships unsupported functionality
            </li>
            <li>
              <BoltIcon size={15} /> Live preview &amp; one-click publish
            </li>
          </ul>
        </section>

        {/* Two entry points */}
        <section className="l-section" id="start">
          <div className="l-section-head">
            <h2 className="l-section-title">Choose how you begin</h2>
            <p className="l-section-sub">
              Two intentional starting points. Both converge on the same blueprint, then the agents
              take it from there.
            </p>
          </div>
          <StartPoints
            figmaState={figma.state}
            figmaDetail={figma.detail}
            baseDetail={base.detail}
            baseState={base.state}
          />

          {!hasApiKey() && (
            <div className="l-notice">
              <strong>ANTHROPIC_API_KEY is not set.</strong>{" "}
              <span>
                Copy <code>.env.example</code> to <code>.env.local</code> and add a key — the agent
                cannot run without one.
              </span>
            </div>
          )}
        </section>

        {/* Agent capabilities */}
        <section className="l-section" id="capabilities">
          <div className="l-section-head">
            <span className="l-eyebrow l-eyebrow--soft">
              <SparkleIcon size={14} /> Agent Capabilities
            </span>
            <h2 className="l-section-title">A team of agents, not just a builder</h2>
            <p className="l-section-sub">
              Each capability is a purpose-built agent working on your site. This deployment lights
              up exactly what it can do — no empty promises.
            </p>
          </div>

          <div className="l-cap-grid">
            {caps.map((capability) => {
              const CapIcon = CAPABILITY_ICONS[capability.id] ?? SparkleIcon;
              return (
                <article key={capability.id} className="l-cap-card">
                  <div className="l-cap-top">
                    <span className="l-cap-icon">
                      <CapIcon size={20} />
                    </span>
                    <span className={`l-pill l-pill--${capability.state === "needs-config" ? "setup" : capability.state}`}>
                      <i /> {STATE_LABEL[capability.state]}
                    </span>
                  </div>
                  <h3 className="l-cap-name">{capability.name}</h3>
                  <p className="l-cap-desc">{capability.description}</p>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="l-footer">
        <div className="l-footer-inner">
          <div className="l-footer-brand">
            <a className="l-brand" href="/projects/new">
              <span className="l-brand-mark">
                <BrandMark size={18} />
              </span>
              <span className="l-brand-name">
                Career Site <span className="l-brand-accent">Studio</span>
              </span>
            </a>
            <p className="l-footer-tagline">
              An AI-powered Careersite Builder where intelligent agents help you design, build,
              optimize, and launch career sites.
            </p>
          </div>
          <div className="l-footer-cols">
            <div className="l-footer-col">
              <h4>Product</h4>
              <a href="#start">Get started</a>
              <a href="#capabilities">Capabilities</a>
              <a href="#start">Import Figma</a>
            </div>
            <div className="l-footer-col">
              <h4>Resources</h4>
              <a href="https://github.com/sonukrr/ai-cs-builder" target="_blank" rel="noreferrer">
                Documentation
              </a>
              <a href="https://github.com/sonukrr/ai-cs-builder" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </div>
            <div className="l-footer-col">
              <h4>Legal</h4>
              <a href="#">Privacy</a>
              <a href="#">Terms</a>
            </div>
          </div>
        </div>
        <div className="l-footer-bottom">
          <span>© {new Date().getFullYear()} Career Site Studio. All rights reserved.</span>
          <span className="l-footer-lib">
            Designed &amp; developed by Sonu, Sanjeevi, Akash &amp; Dhareesh
          </span>
        </div>
      </footer>
    </div>
  );
}
