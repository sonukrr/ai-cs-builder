#!/usr/bin/env node
/**
 * End-to-end check of everything that does not need the model.
 *
 * Covers the whole pipeline either side of the one LLM call: the Figma mock
 * backend, the band summarizer that feeds the analysis, then plan -> blueprint
 * -> operations -> validation -> Angular emit. Run it before a demo.
 *
 *   node --experimental-strip-types scripts/smoke.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, "..", "src");

// Minimal loader so the sources' "@/..." aliases and their extensionless
// relative imports resolve the way the bundler resolves them.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", ".json"];

      export async function resolve(specifier, context, next) {
        const base = specifier.startsWith("@/")
          ? ${JSON.stringify(pathToFileURL(SRC + "/").href)} + specifier.slice(2)
          : specifier;

        const needsProbe = specifier.startsWith("@/") || specifier.startsWith(".");
        if (needsProbe) {
          let lastError;
          for (const suffix of SUFFIXES) {
            try {
              const resolved = await next(base + suffix, context);
              // The bundler infers this from resolveJsonModule; Node requires
              // the attribute explicitly.
              if (resolved.url.endsWith(".json")) {
                return { ...resolved, importAttributes: { type: "json" } };
              }
              return resolved;
            } catch (error) { lastError = error; }
          }
          throw lastError;
        }
        return next(specifier, context);
      }
    `),
  import.meta.url,
);

let failures = 0;
function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

const { FigmaMockProvider } = await import("../src/lib/providers/figma/mock.ts");
const { summarizeDesign, renderSummary } = await import("../src/lib/providers/figma/summarize.ts");
const { planToBlueprint } = await import("../src/lib/agent/analyze.ts");
const { applyOperations } = await import("../src/lib/blueprint/operations.ts");
const { validateBlueprint, isBuildable } = await import("../src/lib/blueprint/validate.ts");
const { emitAngularSite, usedComponents } = await import("../src/lib/emit/angular.ts");
const { registry, catalog, searchRegistry } = await import("../src/lib/registry/index.ts");

console.log(`\nRegistry — ${registry.package.name}@${registry.package.version} (${registry.package.framework})`);
check("components extracted", registry.components.length >= 15, `${registry.components.length} components`);
check("catalog excludes internals and sub-components", catalog().every((c) => c.status === "approved" && c.composedBy.length === 0), `${catalog().length} offerable`);
check("selectors came from the compiled .d.ts", registry.components.find((c) => c.id === "job-search")?.selector === "lib-zm-search");
check("search finds resume upload", searchRegistry("upload a CV")[0]?.id === "resume-upload", searchRegistry("upload a CV").map((c) => c.id).join(", "));
check("search finds filtering", searchRegistry("filter jobs by location").some((c) => c.id === "job-filters"));

console.log("\nFigma import (mock backend)");
const design = await new FigmaMockProvider().fetchDesign("demo");
check("frames parsed", design.frames.length === 3, `${design.frames.length} frames`);
check("palette derived from usage", design.styles.colors.length > 0, design.styles.colors.map((c) => c.hex).join(" "));
check("type ramp derived", design.styles.text.length > 0, `${design.styles.text.length} styles`);

const summary = summarizeDesign(design);
const home = summary.frames[0];
check("home flattened into bands", home.bands.length >= 7, `${home.bands.length} bands`);
check("hero band keeps its headline", home.bands.some((b) => b.text.some((t) => t.includes("Build what the world runs on"))));
check("search band reads as input-like", home.bands.some((b) => b.counts.inputLike > 0 && b.text.some((t) => /Search roles/i.test(t))));
check("stories band shows repeated groups", home.bands.some((b) => b.counts.repeatedGroups >= 2 && b.text.some((t) => t.includes("Amara"))));
const jobs = summary.frames[1];
check("jobs frame has a filter rail", jobs.bands.some((b) => b.text.includes("Department") && b.text.includes("Location")));

const rendered = renderSummary(summary);
check("summary renders for the model", rendered.length > 800 && rendered.includes("FRAME"), `${rendered.length} chars`);

console.log("\nPlan -> blueprint");
// A plan shaped exactly like the analyzer's output, so this exercises the same
// code path without spending a model call.
const plan = {
  companyName: "Northwind Labs",
  tagline: "Build what the world runs on",
  tokens: {
    primary: "#0f2a4a", secondary: "#5b6672", accent: "#e2483d",
    background: "#ffffff", text: "#101418",
    headingFont: "Söhne", bodyFont: "Söhne",
    radius: 8, spacing: 8, buttonStyle: "solid",
  },
  nav: [{ label: "Open Roles", pageId: "jobs" }],
  unsupported: [{ request: "Salary benchmarking widget", reason: "no approved component provides it" }],
  assumptions: ["Treated 'Group 47' as a value-props section"],
  pages: [
    {
      id: "home", name: "Home", path: "/", figmaFrameId: "1:1",
      sections: [
        { id: "home-nav", type: "nav", source: "custom", label: "Navigation", figmaNodeId: "1:2", rationale: "top bar with links", confidence: 0.95, props: {}, content: {} },
        { id: "home-hero", type: "hero", source: "custom", label: "Hero Banner", figmaNodeId: "1:3", rationale: "tall first band, one headline, a CTA", confidence: 0.92, props: {}, content: { headline: "Build what the world runs on", subhead: "Hiring across nine countries.", ctaLabel: "See open roles" } },
        { id: "home-search", type: "job-search", source: "zm-careers-lib", label: "Search Jobs", figmaNodeId: "1:4", rationale: "wide input with a jobs placeholder", confidence: 0.88, props: { placeholder: "Search roles by title or keyword", showSearchButton: true }, content: {} },
        { id: "home-stories", type: "employee-stories", source: "custom", label: "Employee Stories", figmaNodeId: "1:5", rationale: "repeated cards with names, roles and quotes", confidence: 0.84, props: {}, content: { headline: "Meet the team", items: [{ name: "Amara Osei", role: "Staff Engineer", quote: "I stayed for the people." }] } },
        { id: "home-benefits", type: "benefits", source: "custom", label: "Benefits", figmaNodeId: "1:6", rationale: "four short perk blocks", confidence: 0.8, props: {}, content: { headline: "Benefits", items: [{ title: "Health cover", body: "From day one." }] } },
        { id: "home-footer", type: "footer", source: "custom", label: "Footer", figmaNodeId: "1:7", rationale: "dark band with link columns", confidence: 0.93, props: {}, content: {} },
      ],
    },
    {
      id: "jobs", name: "Open Roles", path: "/jobs", figmaFrameId: "2:1",
      sections: [
        { id: "jobs-search", type: "job-search", source: "zm-careers-lib", label: "Search Jobs", figmaNodeId: "2:2", rationale: "search input above results", confidence: 0.9, props: { placeholder: "Search roles" }, content: {} },
        { id: "jobs-filters", type: "job-filters", source: "zm-careers-lib", label: "Filter Jobs", figmaNodeId: "2:3", rationale: "rail of Department / Location / Experience", confidence: 0.91, props: { label: "Filter", isClearAll: true }, content: {} },
        { id: "jobs-list", type: "job-listing", source: "zm-careers-lib", label: "Browse Jobs", figmaNodeId: "2:4", rationale: "repeated rows with role, location and apply", confidence: 0.94, props: { applyBtnText: "Apply" }, content: {} },
        { id: "jobs-pager", type: "pagination", source: "zm-careers-lib", label: "Page Through Results", figmaNodeId: "2:5", rationale: "numbers and a Next", confidence: 0.87, props: {}, content: {} },
      ],
    },
  ],
};

const blueprint = planToBlueprint(plan, "smoke-project");
check("blueprint built", blueprint.pages.length === 2 && blueprint.pages[0].sections.length === 6);
check("theme carried across", blueprint.company.brand.tokens.colors.primary === "#0f2a4a");
check("provenance kept on sections", blueprint.pages[0].sections[1].origin?.confidence === 0.92);
check("unsupported request recorded, not built", blueprint.unsupportedRequests.length === 1);
check("blueprint validates", isBuildable(validateBlueprint(blueprint)), JSON.stringify(validateBlueprint(blueprint).filter((i) => i.level === "error")));

console.log("\nGuard rails");
const bogusComponent = applyOperations(blueprint, [
  { op: "add_section", pageId: "home", id: "salary-tool", type: "salary-benchmarking", source: "zm-careers-lib", label: "Salary Benchmarking", props: {}, content: {} },
]);
check("invented component refused", bogusComponent.rejected.length === 1, bogusComponent.rejected[0]?.reason);

const bogusProp = applyOperations(blueprint, [
  { op: "update_section", sectionId: "home-search", props: { enableTelepathy: true } },
]);
check("unsupported prop refused", bogusProp.rejected.length === 1, bogusProp.rejected[0]?.reason);

const functionalCustom = applyOperations(blueprint, [
  { op: "add_section", pageId: "home", id: "fake-search", type: "hero", source: "custom", label: "Fake", props: {}, content: {} },
]);
const forcedFunctional = structuredClone(functionalCustom.blueprint);
forcedFunctional.pages[0].sections.at(-1).category = "functional";
check("custom section cannot claim to be functional", !isBuildable(validateBlueprint(forcedFunctional)));

console.log("\nConversational edit");
const moved = applyOperations(blueprint, [
  { op: "move_section", sectionId: "home-stories", beforeSectionId: "home-search" },
  // index 5 puts it above the footer. Appending would leave it below, which is
  // wrong on any real site — the kind of thing the agent flags on review.
  { op: "add_section", pageId: "home", id: "home-upload", type: "resume-upload", source: "zm-careers-lib", label: "", props: {}, content: {}, index: 5 },
  { op: "update_theme", tokens: { colors: { accent: "#7a4de0" } } },
]);
check("all three edits applied", moved.rejected.length === 0, moved.rejected.map((r) => r.reason).join("; "));
check("section reordered", moved.blueprint.pages[0].sections.findIndex((s) => s.id === "home-stories") < moved.blueprint.pages[0].sections.findIndex((s) => s.id === "home-search"));
check("label defaulted from the registry", moved.blueprint.pages[0].sections.find((s) => s.id === "home-upload")?.label === "Upload Resume");
check("theme updated", moved.blueprint.company.brand.tokens.colors.accent === "#7a4de0");
check("change summary is per-operation", moved.changes.length === 3, moved.changes.join(" | "));
check("edited blueprint still validates", isBuildable(validateBlueprint(moved.blueprint)));

console.log("\nAngular emit");
const files = emitAngularSite(moved.blueprint);
const jobsTemplate = files.find((f) => f.path === "src/app/pages/jobs/jobs.component.html");
// Two files per page (template + component), plus routes, theme, site config
// and the blueprint itself.
check("a template and component per page, plus the four site files", files.length === 2 * 2 + 4, files.map((f) => f.path).join(", "));
check("real library selectors emitted", jobsTemplate.content.includes("<lib-zm-search") && jobsTemplate.content.includes("<lib-jobs-list") && jobsTemplate.content.includes("<lib-facets"));
check("props bound onto the real inputs", jobsTemplate.content.includes('applyBtnText="Apply"') && jobsTemplate.content.includes('label="Filter"'));
check("used components reported for the build", usedComponents(moved.blueprint).includes("SearchComponent"), usedComponents(moved.blueprint).join(", "));

const outDir = path.join(ROOT, "..", ".data", "smoke");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "jobs.component.html"), jobsTemplate.content);
writeFileSync(path.join(outDir, "design-summary.txt"), rendered);
console.log(`\nWrote sample output to .data/smoke/`);

// `--seed` leaves the demo site in the store as a real project, so the studio
// and the preview can be opened and clicked through with no API key. Useful for
// showing the UI before wiring up credentials.
if (process.argv.includes("--seed")) {
  const { store } = await import("../src/lib/store/store.ts");
  const project = await store.createProject({ name: "Northwind Labs", entryPoint: "figma", sourceRef: "demo" });
  await store.saveVersion(project.id, {
    blueprint: { ...moved.blueprint, projectId: project.id },
    summary: "Created the site from the imported design",
  });
  // "reviewing", not "ready": a Figma import now lands in the design fidelity
  // review, and seeding straight past it would mean the one stage that gates
  // the studio is the one stage the demo never shows.
  await store.updateProject(project.id, { status: "reviewing" });
  console.log(`\nSeeded a demo project, waiting on its design fidelity review. Open:\n  http://localhost:3000/studio/${project.id}\n`);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
