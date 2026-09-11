#!/usr/bin/env node
/**
 * End-to-end check of everything that does not need the model.
 *
 * Covers the whole pipeline either side of the one LLM call: the Figma mock
 * backend, the band summarizer that feeds the analysis, then plan -> blueprint
 * -> operations -> validation -> Angular emit -> React emit. Run it before a demo.
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
const { planToBlueprint, repairPlan } = await import("../src/lib/agent/analyze.ts");
const { applyOperations } = await import("../src/lib/blueprint/operations.ts");
const { validateBlueprint, isBuildable } = await import("../src/lib/blueprint/validate.ts");
const { emitAngularSite, usedComponents } = await import("../src/lib/emit/angular.ts");
const { emitReactSite, collectStudioAssets } = await import("../src/lib/emit/react/index.ts");
const { refusedDestination, isGeneratedPath } = await import("../src/lib/providers/github/deploy.ts");
const { emitAngularApp } = await import("../src/lib/emit/angular-app/index.ts");
const { defaultCareerSite } = await import("../src/lib/blueprint/default-site.ts");
const { recommendedTarget } = await import("../src/lib/agent/deploy-tools.ts");
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

console.log("\nDesign images -> sections");
// The importer fetches images band by band, so an image carries the node id of
// the band it was found in. repairPlan joins that to the band each section came
// from, which is what makes a generated site arrive dressed.
const asset = (nodeId, kind, name) => ({
  url: `/api/projects/p/assets/${name}`,
  kind,
  frameId: "1:1",
  frameName: "Home",
  format: kind === "svg" ? "svg" : "png",
  nodeId,
});
const designAssets = [
  asset("1:1", "export", "frame.png"),          // the frame render, never content
  asset("2:11", "raw", "hero.png"),
  asset("2:20", "raw", "amara.png"),
  asset("2:20", "raw", "devi.png"),
  asset("2:20", "raw", "spare.png"),            // one more than there are items
  asset("2:30", "svg", "logo.svg"),
  asset("2:30", "raw", "logo-bitmap.png"),      // a logo wall should prefer the svg
  asset("2:40", "raw", "orphan.png"),           // band became a component
];
const imagePlan = {
  ...plan,
  pages: [
    {
      id: "home", name: "Home", path: "/", figmaFrameId: "1:1",
      sections: [
        { id: "hero", type: "hero", source: "custom", label: "Hero", figmaNodeId: "2:11",
          rationale: "", confidence: 0.9, propsJson: "{}", contentJson: JSON.stringify({ headline: "Build things" }) },
        { id: "stories", type: "employee-stories", source: "custom", label: "Stories", figmaNodeId: "2:20",
          rationale: "", confidence: 0.8, propsJson: "{}", contentJson: JSON.stringify({ items: [{ name: "Amara" }, { name: "Devi" }] }) },
        { id: "logos", type: "logo-wall", source: "custom", label: "Logos", figmaNodeId: "2:30",
          rationale: "", confidence: 0.8, propsJson: "{}", contentJson: JSON.stringify({ items: [{ name: "Acme" }] }) },
        { id: "faq", type: "faq", source: "custom", label: "FAQ", figmaNodeId: "2:50",
          rationale: "", confidence: 0.7, propsJson: "{}", contentJson: JSON.stringify({ items: [{ q: "Why?", a: "Because." }] }) },
        { id: "search", type: "job-search", source: "zm-careers-lib", label: "Search", figmaNodeId: "2:40",
          rationale: "", confidence: 0.9, propsJson: "{}", contentJson: "{}" },
        // The catalog offers custom-html to the analysis, but a replica's
        // markup is written later by set_custom_html — so the analysis emits
        // one with no html, and an empty custom-html section fails validation.
        { id: "bespoke", type: "custom-html", source: "custom", label: "Stakeholder Tabs", figmaNodeId: "2:60",
          rationale: "", confidence: 0.6, propsJson: "{}", contentJson: JSON.stringify({ headline: "For every stakeholder" }) },
        // No css key: the sanitizer supplies one, and the validator demands
        // that stored content already equal its sanitized form.
        { id: "authored", type: "custom-html", source: "custom", label: "Authored Replica", figmaNodeId: "2:70",
          rationale: "", confidence: 0.6, propsJson: "{}", contentJson: JSON.stringify({ html: "<p>real markup</p>" }) },
        { id: "rejected", type: "custom-html", source: "custom", label: "Illegal Replica", figmaNodeId: "2:80",
          rationale: "", confidence: 0.6, propsJson: "{}", contentJson: JSON.stringify({ html: "<form><input name=q></form>" }) },
      ],
    },
  ],
  nav: [{ label: "Home", pageId: "home" }],
};

const repaired = repairPlan(imagePlan, designAssets);
const byId = Object.fromEntries(repaired.plan.pages[0].sections.map((s) => [s.id, s]));

check("hero got the image from its own band", byId.hero?.content.image === "/api/projects/p/assets/hero.png", String(byId.hero?.content.image));
check("hero keeps the copy the model wrote", byId.hero?.content.headline === "Build things");
check("alt is empty, not invented", byId.hero?.content.imageAlt === "");
check("one photo per story item, in order",
  byId.stories?.content.items?.[0]?.photo === "/api/projects/p/assets/amara.png" &&
  byId.stories?.content.items?.[1]?.photo === "/api/projects/p/assets/devi.png");
check("logo wall prefers the vector over the bitmap", byId.logos?.content.items?.[0]?.image === "/api/projects/p/assets/logo.svg", String(byId.logos?.content.items?.[0]?.image));
check("a section type with no image slot is untouched", byId.faq?.content.image === undefined && byId.faq?.content.items?.length === 1);
check("an approved component carries no static image", Object.keys(byId.search?.content ?? {}).length === 0);
check("the frame render is never used as content",
  !JSON.stringify(repaired.plan).includes("frame.png"));
check("leftover image in a band is reported",
  repaired.notes.some((n) => n.includes("Stories") && n.includes("left in the asset library")),
  repaired.notes.find((n) => n.includes("Stories")) ?? "no note");
check("alt text is flagged for review",
  repaired.notes.some((n) => n.includes("empty alt text") && n.includes("Hero")));
check("unplaced images are reported, not lost",
  repaired.notes.some((n) => n.includes("were not placed")),
  repaired.notes.find((n) => n.includes("were not placed")) ?? "no note");

check("an empty custom-html band becomes a text block, not an unapprovable plan",
  byId.bespoke?.type === "rich-text" && byId.bespoke?.content.headline === "For every stakeholder",
  `${byId.bespoke?.type}`);
check("a custom-html section that has markup stays one, in sanitized form",
  byId.authored?.type === "custom-html" && byId.authored?.content.html === "<p>real markup</p>" && byId.authored?.content.css === "",
  `${byId.authored?.type} css=${JSON.stringify(byId.authored?.content.css)}`);
check("markup the sanitizer rejects falls back rather than blocking the plan",
  byId.rejected?.type === "rich-text",
  `${byId.rejected?.type}`);
check("the downgrade is reported to the admin",
  repaired.notes.some((n) => n.includes("Stakeholder Tabs") && n.includes("hand-authored replica")));
check("the repaired plan actually validates",
  isBuildable(validateBlueprint(planToBlueprint(repaired.plan, "smoke-project"))),
  validateBlueprint(planToBlueprint(repaired.plan, "smoke-project")).filter((i) => i.level === "error").map((i) => i.message).join("; ") || "no errors");

// Re-running must not double-fill or overwrite a chosen image.
const again = repairPlan(
  { ...imagePlan, pages: [{ ...imagePlan.pages[0], sections: imagePlan.pages[0].sections.map((s) =>
      s.id === "hero" ? { ...s, contentJson: JSON.stringify({ headline: "Build things", image: "/api/projects/p/assets/chosen.png" }) } : s) }] },
  designAssets,
);
check("an image already chosen is never overwritten",
  again.plan.pages[0].sections.find((s) => s.id === "hero")?.content.image === "/api/projects/p/assets/chosen.png");

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

console.log("\nReact emit (what the deploy agent pushes)");
const react = emitReactSite(moved.blueprint, { studioProjectId: "smoke" });
const paths = react.files.map((f) => f.path);
check("a Next.js app, not a fragment", ["package.json", "tsconfig.json", "app/layout.tsx", "app/globals.css", "app/page.tsx", "lib/site.ts", "lib/content.ts", "blueprint.json"].every((p) => paths.includes(p)), paths.join(", "));
check("one route per page", react.pages.length === moved.blueprint.pages.length, react.pages.map((p) => p.route).join(", "));
const homePage = react.files.find((f) => f.path === "app/page.tsx").content;
check("presentation sections emitted as components", homePage.includes("<Hero") && homePage.includes('from "@/components/sections/Hero"'));
check("only the components a page uses are imported", !homePage.includes("components/sections/Faq"));
// The library is Angular. A React build that pretended otherwise would put a
// search box that does not search in front of a candidate.
check("approved careers components emit as a labelled gap", homePage.includes("<PendingIntegration") && paths.includes("components/library/PendingIntegration.tsx"));
check("the gap is reported, not buried", react.warnings.some((w) => w.includes("cannot run in React")), react.warnings.join(" | "));
check("the gap is documented in the repository", paths.includes("components/library/README.md"));
const css = react.files.find((f) => f.path === "app/globals.css").content;
check("brand tokens in the stylesheet", css.includes("--brand-accent: #7a4de0"));
check("the preview's own section styles are carried over", css.includes(".band.tinted") && css.includes(".hero .hero-bg"));
check("no studio-hosted image URLs survive", !react.files.some((f) => f.encoding === "utf-8" && f.content.includes("/api/projects/")) , "a generated site cannot reach the studio");
check("studio images are collected for copying", Array.isArray(collectStudioAssets(moved.blueprint)));

console.log("\nAngular emit (the target that carries the library)");
check("a site with careers components targets Angular", recommendedTarget(moved.blueprint) === "angular");
const ng = emitAngularApp(moved.blueprint, { studioProjectId: "smoke" });
const ngPaths = ng.files.map((f) => f.path);
check("a complete Angular workspace", ["package.json", "angular.json", "tsconfig.json", "tsconfig.app.json", "src/main.ts", "src/index.html", "src/app/app.module.ts", "src/app/section.component.html", "vercel.json", ".npmrc"].every((p) => ngPaths.includes(p)), ngPaths.join(", "));
const ngPkg = JSON.parse(ng.files.find((f) => f.path === "package.json").content);
check("the approved library is a real dependency", ngPkg.dependencies[registry.package.name] === `^${registry.package.version}`, JSON.stringify(ngPkg.dependencies[registry.package.name]));
const ngModule = ng.files.find((f) => f.path === "src/app/app.module.ts").content;
check("its NgModule is imported", ngModule.includes(registry.package.ngModule) && ngModule.includes(`from "${registry.package.name}"`));
const jobsTpl = ng.files.find((f) => f.path === "src/app/pages/jobs/jobs.component.html").content;
check("pages bind the library's real selectors", jobsTpl.includes("<lib-zm-search") && jobsTpl.includes("<lib-jobs-list"));
check("the components are reported as running, not gapped", ng.libraryComponents.includes("SearchComponent") && ng.libraryComponents.length > 0, ng.libraryComponents.join(", "));
// The library reads its tenant out of storage in service constructors, so the
// seeding has to be in main.ts ahead of bootstrap or every request goes out
// pointed at nothing.
const ngMain = ng.files.find((f) => f.path === "src/main.ts").content;
check("the tenant is seeded before bootstrap", ngMain.indexOf("applyCareersConfig()") < ngMain.indexOf("bootstrapModule"));
const careers = ng.files.find((f) => f.path === "src/app/careers.config.ts").content;
check("every storage key the library reads is seeded", ["APIENDPOINT", "APIENDPOINTNEW", "TENANTAPIURL", "COMPANYID", "COMPANYURL", "DOMAIN"].every((k) => careers.includes(`"${k}"`)));
// The library derives its tenant from location.hostname off localhost, and the
// API answers an unknown domain with 200 and no jobs — so the interceptor that
// pins it is what makes a deployed link show the same roles as the preview.
check("the tenant is pinned by an interceptor", ngPaths.includes("src/app/careers-tenant.interceptor.ts"));
check("the interceptor is registered", ngModule.includes("CareersTenantInterceptor") && ngModule.includes("HTTP_INTERCEPTORS"));
const interceptor = ng.files.find((f) => f.path === "src/app/careers-tenant.interceptor.ts").content;
check("it rewrites domain and companyId", interceptor.includes('body.set("domain"') && interceptor.includes('body.set("companyId"'));
check("the pinning is reported as a note", ng.notes.some((n) => n.includes("pinned to")), ng.notes.join(" | "));
check("no studio-hosted image URLs survive", !ng.files.some((f) => f.encoding === "utf-8" && f.content.includes("/api/projects/")));

console.log("\nThe default career site");
const startSite = defaultCareerSite({ projectId: "smoke", companyName: "Northwind Labs" });
check("it validates with nothing to fix", isBuildable(validateBlueprint(startSite)), validateBlueprint(startSite).map((i) => i.path + ": " + i.message).join("; "));
check("three routable pages", startSite.pages.map((p) => p.path).join(" ") === "/ /jobs /jobs/:jobUrl", startSite.pages.map((p) => p.path).join(" "));
// The parameter name is the library's, not a preference: lib-job-apply reads
// paramMap.get('jobUrl'), so renaming it breaks the apply flow silently.
check("the detail route uses the library's parameter name", startSite.pages[2].path.endsWith("/:jobUrl"));
const homeSections = startSite.pages[0].sections.map((s) => s.type);
check("home is header, hero, testimonials, footer", homeSections.join(",") === "nav,hero,employee-stories,footer", homeSections.join(","));
check("every page carries the header and the footer", startSite.pages.every((p) => p.sections[0].type === "nav" && p.sections.at(-1).type === "footer"));
check("navigation points at real pages", startSite.nav.every((item) => startSite.pages.some((p) => p.id === item.pageId)));
check("the hero CTA points at the jobs page", startSite.pages[0].sections[1].content.ctaPageId === "jobs");
const jobsRow = startSite.pages[1].sections.find((s) => s.source === "layout");
check("filters sit beside the results in a row", jobsRow?.props.direction === "row" && jobsRow.children[0].type === "job-filters", JSON.stringify(jobsRow?.props.direction));
check("the facet column is a sidebar, not a half", jobsRow?.children[0].layout?.basis === "300px");
check("search, filters, listing and detail are all approved components", ["job-search", "job-filters", "job-listing", "job-details"].every((type) => JSON.stringify(startSite).includes(`"type":"${type}"`)));

// A job card emits (jobURL) and navigates nowhere on its own, so the emitted
// page has to bind it — without this, clicking a job does nothing at all.
const startNg = emitAngularApp(startSite, { studioProjectId: "smoke" });
const startJobsTemplate = startNg.files.find((f) => f.path === "src/app/pages/jobs/jobs.component.html").content;
const startJobsComponent = startNg.files.find((f) => f.path === "src/app/pages/jobs/jobs.component.ts").content;
check("the job list's output is bound", startJobsTemplate.includes('(jobURL)="openJob($event)"'));
check("the page navigates to the detail route", startJobsComponent.includes("this.router.navigate(['jobs', slug]"), startJobsComponent.includes("openJob") ? "openJob present" : "no handler");
check("the id is kept as a query parameter", startJobsComponent.includes("queryParams"));

console.log("\nDeploy guard rails");
process.env.BASE_SITE_REPO = "acme/career-site-base";
check("the approved base repo is refused as a destination", Boolean(refusedDestination("https://github.com/ACME/career-site-base.git")), "compared by owner/name, not by string");
check("an ordinary destination is accepted", refusedDestination("acme/careers-site") === null);
check("nonsense is refused", Boolean(refusedDestination("not a repo")));
check("generated paths are recognised", isGeneratedPath("app/page.tsx") && isGeneratedPath("blueprint.json"));
check("hand-written files are left alone", !isGeneratedPath(".github/workflows/deploy.yml") && !isGeneratedPath("LICENSE"));

const outDir = path.join(ROOT, "..", ".data", "smoke");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "jobs.component.html"), jobsTemplate.content);
writeFileSync(path.join(outDir, "design-summary.txt"), rendered);
writeFileSync(path.join(outDir, "react-home-page.tsx"), homePage);
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
