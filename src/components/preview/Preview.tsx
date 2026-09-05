"use client";

import type { CSSProperties } from "react";
import type { Blueprint, Section } from "@/lib/blueprint/schema";

/**
 * The in-studio preview renderer.
 *
 * One of two renderers over the blueprint. This one is React and runs inside
 * the studio for immediate feedback; src/lib/emit/angular.ts produces the
 * Angular that the real `zm-careers-lib` components run in.
 *
 * Functional sections therefore render as faithful *stand-ins* here — the same
 * layout, the same settings applied, sample data — because the real components
 * are Angular and need a live tenant API. That is a deliberate boundary, not a
 * shortcut: the preview is for judging structure, hierarchy and brand, and the
 * emitted Angular is what actually ships. Each stand-in is labelled so nobody
 * mistakes sample jobs for their own.
 */

interface Props {
  blueprint: Blueprint;
  pageId: string;
  selectedSectionId?: string;
  onSelect?: (sectionId: string) => void;
}

function themeVars(blueprint: Blueprint): CSSProperties {
  const t = blueprint.company.brand.tokens;
  return {
    ["--p" as string]: t.colors.primary,
    ["--s" as string]: t.colors.secondary,
    ["--a" as string]: t.colors.accent ?? t.colors.primary,
    ["--bg" as string]: t.colors.background,
    ["--fg" as string]: t.colors.text,
    ["--surface" as string]: t.colors.surface ?? "#f5f6f8",
    ["--muted" as string]: t.colors.muted ?? "#6b7280",
    ["--r" as string]: `${t.radius}px`,
    ["--sp" as string]: `${t.spacing}px`,
    ["--fh" as string]: `${t.fonts.heading}, system-ui, sans-serif`,
    ["--fb" as string]: `${t.fonts.body}, system-ui, sans-serif`,
    background: t.colors.background,
    color: t.colors.text,
    fontFamily: `${t.fonts.body}, system-ui, sans-serif`,
  };
}

function buttonStyle(blueprint: Blueprint): CSSProperties {
  const t = blueprint.company.brand.tokens;
  const base: CSSProperties = {
    display: "inline-block",
    padding: "12px 22px",
    fontWeight: 600,
    fontSize: 15,
    border: "1.5px solid var(--a)",
    cursor: "default",
  };
  switch (t.buttonStyle) {
    case "outline":
      return { ...base, background: "transparent", color: "var(--a)", borderRadius: "var(--r)" };
    case "pill":
      return { ...base, background: "var(--a)", color: "#fff", borderRadius: 999 };
    case "square":
      return { ...base, background: "var(--a)", color: "#fff", borderRadius: 0 };
    default:
      return { ...base, background: "var(--a)", color: "#fff", borderRadius: "var(--r)" };
  }
}

const str = (content: Record<string, unknown>, key: string, fallback = ""): string => {
  const value = content[key];
  return typeof value === "string" && value.trim() ? value : fallback;
};

const list = (content: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const value = content[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
};

const wrap: CSSProperties = { maxWidth: 1080, margin: "0 auto", padding: "0 32px" };
const h2: CSSProperties = { fontFamily: "var(--fh)", fontSize: 30, margin: "0 0 8px", letterSpacing: "-0.02em" };
const sub: CSSProperties = { color: "var(--muted)", margin: 0, fontSize: 15.5 };
const grid = (columns: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
  gap: 20,
  marginTop: 28,
});

/** A visible marker on preview stand-ins for Angular library components. */
function StandInBadge({ label }: { label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "#4b5563",
        background: "rgba(255,255,255,0.86)",
        border: "1px solid #d7dbe0",
        borderRadius: 4,
        padding: "2px 6px",
      }}
      title={`${label} is an approved component from zm-careers-lib. This is a preview stand-in — the real component renders live jobs in the built site.`}
    >
      {label} · preview
    </div>
  );
}

const SAMPLE_JOBS = [
  { title: "Senior Backend Engineer", meta: "Engineering · London · Full time" },
  { title: "Product Designer", meta: "Design · Remote · Full time" },
  { title: "Solutions Engineer", meta: "Sales · Berlin · Full time" },
];

function FunctionalSection({ section, blueprint }: { section: Section; blueprint: Blueprint }) {
  const props = section.props as Record<string, unknown>;
  const btn = buttonStyle(blueprint);

  switch (section.type) {
    case "job-search":
      return (
        <div style={{ ...wrap, padding: "36px 32px" }}>
          <div style={{ display: "flex", gap: 10, maxWidth: 640 }}>
            <div
              style={{
                flex: 1,
                border: "1.5px solid #d7dbe0",
                borderRadius: "var(--r)",
                padding: "13px 16px",
                color: "var(--muted)",
                background: "#fff",
              }}
            >
              {str(props as Record<string, unknown>, "placeholder", "Search jobs")}
            </div>
            {props.showSearchButton !== false && <span style={btn}>Search</span>}
          </div>
        </div>
      );

    case "job-listing":
    case "job-listing-elasticsearch":
      return (
        <div style={{ ...wrap, padding: "28px 32px" }}>
          {SAMPLE_JOBS.map((job) => (
            <div
              key={job.title}
              style={{
                border: "1px solid #e4e7ea",
                borderRadius: "var(--r)",
                padding: 20,
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 16,
                background: "#fff",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--fh)", fontWeight: 600, fontSize: 17 }}>{job.title}</div>
                <div style={{ color: "var(--muted)", fontSize: 14, marginTop: 3 }}>{job.meta}</div>
              </div>
              <span style={{ ...btn, padding: "9px 18px", fontSize: 14 }}>
                {str(props, "applyBtnText", "Apply")}
              </span>
            </div>
          ))}
        </div>
      );

    case "job-filters":
      return (
        <div style={{ ...wrap, padding: "28px 32px" }}>
          <div style={{ fontFamily: "var(--fh)", fontWeight: 600, marginBottom: 14 }}>
            {str(props, "label", "Filters")}
          </div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            {["Department", "Location", "Experience"].map((facet) => (
              <div key={facet}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 7 }}>{facet}</div>
                {["Any", "Option", "Option"].map((option, index) => (
                  <div key={index} style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 4 }}>
                    ☐ {option}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );

    case "pagination":
      return (
        <div style={{ ...wrap, padding: "20px 32px", display: "flex", gap: 8, justifyContent: "center" }}>
          {["1", "2", "3", "›"].map((page, index) => (
            <span
              key={page}
              style={{
                minWidth: 34,
                textAlign: "center",
                padding: "6px 0",
                borderRadius: "var(--r)",
                border: "1px solid #e4e7ea",
                background: index === 0 ? "var(--a)" : "#fff",
                color: index === 0 ? "#fff" : "var(--fg)",
                fontSize: 14,
              }}
            >
              {page}
            </span>
          ))}
        </div>
      );

    case "resume-upload":
      return (
        <div style={{ ...wrap, padding: "32px" }}>
          <div
            style={{
              border: "2px dashed #cfd5dc",
              borderRadius: "var(--r)",
              padding: 44,
              textAlign: "center",
              color: "var(--muted)",
              background: "var(--surface)",
            }}
          >
            Drag your CV here, or browse files
          </div>
        </div>
      );

    case "job-apply":
    case "custom-apply":
      return (
        <div style={{ ...wrap, padding: "36px 32px", maxWidth: 720 }}>
          <div
            style={{
              border: "2px dashed #cfd5dc",
              borderRadius: "var(--r)",
              padding: 30,
              textAlign: "center",
              color: "var(--muted)",
              background: "var(--surface)",
              marginBottom: 18,
            }}
          >
            Upload your CV — we will fill in what we can
          </div>
          {["Full name", "Email address", "Phone"].map((label) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 5 }}>{label}</div>
              <div style={{ border: "1.5px solid #d7dbe0", borderRadius: "var(--r)", height: 44, background: "#fff" }} />
            </div>
          ))}
          {props.isTncRequired !== false && (
            <div style={{ color: "var(--muted)", fontSize: 13.5, margin: "14px 0" }}>
              ☐ I accept the terms and conditions
            </div>
          )}
          <span style={btn}>Submit application</span>
        </div>
      );

    case "job-details":
      return (
        <div style={{ ...wrap, padding: "36px 32px", maxWidth: 780 }}>
          <h2 style={h2}>Senior Backend Engineer</h2>
          <p style={sub}>Engineering · London · Full time</p>
          <div style={{ marginTop: 22, color: "var(--muted)", fontSize: 15, lineHeight: 1.7 }}>
            The full job description, requirements and requisition fields render here from your job
            system.
          </div>
          <div style={{ marginTop: 22 }}>
            <span style={btn}>Apply for this role</span>
          </div>
        </div>
      );

    case "job-recommendations":
      return (
        <div style={{ ...wrap, padding: "36px 32px" }}>
          <h2 style={h2}>Recommended for you</h2>
          <div style={grid(3)}>
            {SAMPLE_JOBS.map((job) => (
              <div key={job.title} style={{ border: "1px solid #e4e7ea", borderRadius: "var(--r)", padding: 18, background: "#fff" }}>
                <div style={{ fontFamily: "var(--fh)", fontWeight: 600 }}>{job.title}</div>
                <div style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 4 }}>{job.meta}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case "find-your-spot":
      return (
        <div style={{ ...wrap, padding: "56px 32px", textAlign: "center", background: "var(--surface)" }}>
          <h2 style={{ ...h2, fontSize: 34 }}>{str(props, "titleText", "Find your spot")}</h2>
          <p style={{ ...sub, maxWidth: 560, margin: "0 auto" }}>
            {str(props, "descriptionText", "Upload your CV and we will match you to the roles that fit.")}
          </p>
          <div style={{ marginTop: 22 }}>
            <span style={btn}>Upload CV</span>
          </div>
        </div>
      );

    case "filter-chips":
      return (
        <div style={{ ...wrap, padding: "12px 32px", display: "flex", gap: 8 }}>
          {["Engineering ×", "London ×"].map((chip) => (
            <span
              key={chip}
              style={{
                fontSize: 13,
                padding: "5px 11px",
                borderRadius: 999,
                background: "var(--surface)",
                border: "1px solid #e4e7ea",
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      );

    case "apply-confirmation":
      return (
        <div style={{ ...wrap, padding: "72px 32px", textAlign: "center" }}>
          <h2 style={h2}>{str(props, "message", "Thanks — we've received your application.")}</h2>
        </div>
      );

    default:
      return (
        <div style={{ ...wrap, padding: "28px 32px", color: "var(--muted)" }}>
          {section.label} renders here in the built site.
        </div>
      );
  }
}

function StaticSection({ section, blueprint }: { section: Section; blueprint: Blueprint }) {
  const content = section.content as Record<string, unknown>;
  const btn = buttonStyle(blueprint);
  const items = list(content, "items");

  switch (section.type) {
    case "nav":
      return (
        <div style={{ borderBottom: "1px solid #e4e7ea", background: "#fff" }}>
          <div style={{ ...wrap, display: "flex", alignItems: "center", gap: 26, height: 68 }}>
            <div style={{ fontFamily: "var(--fh)", fontWeight: 700, fontSize: 17 }}>
              {blueprint.company.name}
            </div>
            <div style={{ flex: 1 }} />
            {blueprint.nav.map((item) => (
              <span key={item.label} style={{ fontSize: 14.5, color: "var(--fg)" }}>
                {item.label}
              </span>
            ))}
          </div>
        </div>
      );

    case "hero":
      return (
        <div style={{ background: "var(--p)", color: "#fff", padding: "88px 0" }}>
          <div style={{ ...wrap, textAlign: str(content, "alignment") === "center" ? "center" : "left" }}>
            <h1 style={{ fontFamily: "var(--fh)", fontSize: 52, margin: 0, letterSpacing: "-0.03em", lineHeight: 1.08 }}>
              {str(content, "headline", `Careers at ${blueprint.company.name}`)}
            </h1>
            <p style={{ fontSize: 18.5, opacity: 0.86, marginTop: 16, maxWidth: 620, marginLeft: str(content, "alignment") === "center" ? "auto" : 0, marginRight: str(content, "alignment") === "center" ? "auto" : 0 }}>
              {str(content, "subhead", blueprint.company.tagline)}
            </p>
            {str(content, "ctaLabel") && (
              <div style={{ marginTop: 28 }}>
                <span style={btn}>{str(content, "ctaLabel")}</span>
              </div>
            )}
          </div>
        </div>
      );

    case "value-props":
    case "benefits":
      return (
        <div style={{ ...wrap, padding: "64px 32px" }}>
          <h2 style={h2}>{str(content, "headline", section.label)}</h2>
          <div style={grid(Math.min(Math.max(items.length || 3, 2), 4))}>
            {(items.length > 0 ? items : [{}, {}, {}]).map((item, index) => (
              <div key={index}>
                <div style={{ fontFamily: "var(--fh)", fontWeight: 600, fontSize: 17, marginBottom: 6 }}>
                  {str(item, "title", "Benefit")}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 14.5 }}>{str(item, "body")}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case "employee-stories":
      return (
        <div style={{ background: "var(--surface)", padding: "64px 0" }}>
          <div style={wrap}>
            <h2 style={h2}>{str(content, "headline", "Meet the team")}</h2>
            <div style={grid(Math.min(Math.max(items.length || 2, 2), 3))}>
              {(items.length > 0 ? items : [{}, {}]).map((item, index) => (
                <div key={index} style={{ background: "#fff", borderRadius: "var(--r)", padding: 22 }}>
                  <div style={{ height: 150, borderRadius: "var(--r)", background: "#dde1e6", marginBottom: 14 }} />
                  <div style={{ fontFamily: "var(--fh)", fontWeight: 600 }}>{str(item, "name", "Team member")}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13.5 }}>{str(item, "role")}</div>
                  <p style={{ fontSize: 14.5, marginTop: 10, marginBottom: 0 }}>{str(item, "quote")}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case "testimonials":
      return (
        <div style={{ ...wrap, padding: "64px 32px" }}>
          <h2 style={h2}>{str(content, "headline", section.label)}</h2>
          <div style={grid(Math.min(Math.max(items.length || 2, 1), 3))}>
            {(items.length > 0 ? items : [{}, {}]).map((item, index) => (
              <blockquote key={index} style={{ margin: 0, borderLeft: "3px solid var(--a)", paddingLeft: 16 }}>
                <p style={{ fontSize: 16, margin: 0 }}>{str(item, "quote")}</p>
                <footer style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 8 }}>
                  {str(item, "author")} {str(item, "role") && `· ${str(item, "role")}`}
                </footer>
              </blockquote>
            ))}
          </div>
        </div>
      );

    case "stats":
      return (
        <div style={{ ...wrap, padding: "56px 32px" }}>
          <div style={grid(Math.min(Math.max(items.length || 4, 2), 4))}>
            {(items.length > 0 ? items : [{}, {}, {}, {}]).map((item, index) => (
              <div key={index}>
                <div style={{ fontFamily: "var(--fh)", fontSize: 38, fontWeight: 700, color: "var(--a)" }}>
                  {str(item, "value", "—")}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 14 }}>{str(item, "label")}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case "culture":
      return (
        <div style={{ ...wrap, padding: "64px 32px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, alignItems: "center" }}>
          <div>
            <h2 style={h2}>{str(content, "headline", section.label)}</h2>
            <p style={{ ...sub, marginTop: 12 }}>{str(content, "body")}</p>
          </div>
          <div style={{ height: 280, borderRadius: "var(--r)", background: "var(--surface)" }} />
        </div>
      );

    case "teams":
    case "locations":
    case "logo-wall":
      return (
        <div style={{ ...wrap, padding: "56px 32px" }}>
          <h2 style={h2}>{str(content, "headline", section.label)}</h2>
          <div style={grid(Math.min(Math.max(items.length || 3, 2), 4))}>
            {(items.length > 0 ? items : [{}, {}, {}]).map((item, index) => (
              <div key={index} style={{ border: "1px solid #e4e7ea", borderRadius: "var(--r)", padding: 18 }}>
                <div style={{ fontFamily: "var(--fh)", fontWeight: 600 }}>
                  {str(item, "name") || str(item, "city") || "Item"}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 4 }}>
                  {str(item, "body") || str(item, "country")}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case "process":
    case "faq":
      return (
        <div style={{ ...wrap, padding: "56px 32px", maxWidth: 760 }}>
          <h2 style={h2}>{str(content, "headline", section.label)}</h2>
          <div style={{ marginTop: 22 }}>
            {(items.length > 0 ? items : [{}, {}, {}]).map((item, index) => (
              <div key={index} style={{ borderTop: "1px solid #e4e7ea", padding: "16px 0" }}>
                <div style={{ fontFamily: "var(--fh)", fontWeight: 600 }}>
                  {str(item, "title") || str(item, "question") || `Step ${index + 1}`}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 14.5, marginTop: 5 }}>
                  {str(item, "body") || str(item, "answer")}
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case "cta":
      return (
        <div style={{ background: "var(--a)", color: "#fff", padding: "64px 0", textAlign: "center" }}>
          <div style={wrap}>
            <h2 style={{ ...h2, fontSize: 36, color: "#fff" }}>{str(content, "headline", "Ready when you are")}</h2>
            <p style={{ opacity: 0.88, margin: "10px 0 0" }}>{str(content, "body")}</p>
            {str(content, "ctaLabel") && (
              <div style={{ marginTop: 24 }}>
                <span style={{ ...btn, background: "#fff", color: "var(--a)", borderColor: "#fff" }}>
                  {str(content, "ctaLabel")}
                </span>
              </div>
            )}
          </div>
        </div>
      );

    case "media":
      return (
        <div style={{ ...wrap, padding: "40px 32px" }}>
          <div style={{ height: 340, borderRadius: "var(--r)", background: "var(--surface)" }} />
          {str(content, "caption") && (
            <div style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 10 }}>{str(content, "caption")}</div>
          )}
        </div>
      );

    case "footer":
      return (
        <div style={{ background: "var(--p)", color: "#fff", padding: "48px 0 32px" }}>
          <div style={{ ...wrap, display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "var(--fh)", fontWeight: 700 }}>{blueprint.company.name}</div>
            <div style={{ display: "flex", gap: 22, opacity: 0.8, fontSize: 14 }}>
              {blueprint.nav.map((item) => (
                <span key={item.label}>{item.label}</span>
              ))}
            </div>
          </div>
          <div style={{ ...wrap, opacity: 0.55, fontSize: 12.5, marginTop: 26 }}>
            {str(content, "legal", `© ${new Date().getFullYear()} ${blueprint.company.name}`)}
          </div>
        </div>
      );

    default:
      return (
        <div style={{ ...wrap, padding: "48px 32px", maxWidth: 760 }}>
          {str(content, "headline") && <h2 style={h2}>{str(content, "headline")}</h2>}
          <p style={{ ...sub, whiteSpace: "pre-wrap" }}>{str(content, "body", section.label)}</p>
        </div>
      );
  }
}

export function Preview({ blueprint, pageId, selectedSectionId, onSelect }: Props) {
  const page = blueprint.pages.find((p) => p.id === pageId) ?? blueprint.pages[0];
  if (!page) return null;

  return (
    <div style={themeVars(blueprint)}>
      {page.sections
        .filter((section) => section.visible)
        .map((section) => {
          const isSelected = section.id === selectedSectionId;
          return (
            <div
              key={section.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(section.id);
              }}
              style={{
                position: "relative",
                cursor: onSelect ? "pointer" : "default",
                outline: isSelected ? "2px solid #5b8cff" : "none",
                outlineOffset: -2,
              }}
              title={`${section.label} — click to edit`}
            >
              {section.source === "zm-careers-lib" ? (
                <>
                  <StandInBadge label={section.label} />
                  <FunctionalSection section={section} blueprint={blueprint} />
                </>
              ) : (
                <StaticSection section={section} blueprint={blueprint} />
              )}
            </div>
          );
        })}
      {page.sections.length === 0 && (
        <div style={{ padding: 72, textAlign: "center", color: "#9aa5b4" }}>
          This page has no sections yet. Ask the assistant to add one.
        </div>
      )}
    </div>
  );
}
