#!/usr/bin/env node
/**
 * Regenerates src/lib/registry/registry.json from the real published
 * `zm-careers-lib` package.
 *
 * The mechanical half (Angular selector, class name, @Input / @Output names) is
 * extracted from the compiled `.d.ts` ɵɵComponentDeclaration signatures, which
 * are authoritative. The library's README example markup is stale — it shows
 * `<zm-search>` where the compiled selector is `<lib-zm-search>` — so we never
 * read selectors from prose.
 *
 * The editorial half (friendly name shown to admins, category, capabilities,
 * prop docs) lives in OVERLAY below and is merged in by class name. A component
 * that appears in the package but not in OVERLAY is emitted with status
 * "unreviewed" so the agent will not offer it until a human classifies it.
 *
 *   node scripts/build-registry.mjs [--version 2.8.3]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "lib", "registry", "registry.json");
const PACKAGE = "zm-careers-lib";

/**
 * Editorial metadata, keyed by Angular class name.
 *
 * `name` is what a company administrator sees. Internal React/Angular component
 * names are never surfaced in the admin UI (04-component-registry.md).
 */
const OVERLAY = {
  SearchComponent: {
    id: "job-search",
    name: "Search Jobs",
    blurb: "A keyword search box candidates use to find open roles.",
    category: "functional",
    capabilities: ["keyword-search", "search-button", "results-count"],
    status: "approved",
    propDocs: {
      placeholder: "Placeholder text inside the search box.",
      label: "Field label shown above or inside the box.",
      showSearchButton: "Show an explicit Search button next to the field.",
      showSearchIconInside: "Render the magnifier inside the input instead.",
      themeName: "Named theme variant applied by the library.",
      appearance: "Material form-field appearance: fill | outline.",
      searchKeyword: "Pre-filled search term on first load.",
    },
    defaults: { placeholder: "Search jobs", showSearchButton: true },
  },
  JobsListComponent: {
    id: "job-listing",
    name: "Browse Jobs",
    blurb: "The list of open roles, with an apply action on each card.",
    category: "functional",
    capabilities: ["job-list", "apply-cta", "show-more", "skill-chips"],
    status: "approved",
    propDocs: {
      applyBtnText: "Label on each card's apply button.",
      chipsViewForSkills: "Render required skills as chips.",
      showMoreBtn: "Show a 'load more' button under the list.",
      cardClickable: "Make the whole card open the job, not just the title.",
    },
    defaults: { applyBtnText: "Apply", cardClickable: true },
  },
  JobsListEsComponent: {
    id: "job-listing-elasticsearch",
    name: "Browse Jobs (Elasticsearch)",
    blurb: "Job list backed by Elasticsearch, for large job volumes.",
    category: "functional",
    capabilities: ["job-list", "elasticsearch", "geo-location", "apply-cta"],
    status: "approved",
    propDocs: {
      applyBtnText: "Label on each card's apply button.",
      cardClickable: "Make the whole card open the job.",
      userGeoLocation: "Bias results toward the candidate's location.",
      departmentName: "Restrict the list to one department.",
    },
    defaults: { applyBtnText: "Apply" },
  },
  JobComponent: {
    id: "job-card",
    name: "Job Card",
    blurb: "A single job summary card. Usually composed inside a job list.",
    category: "functional",
    capabilities: ["job-summary", "apply-cta"],
    status: "approved",
    composedBy: ["job-listing"],
    propDocs: {
      job: "The job record to render.",
      applyBtnText: "Label on the apply button.",
      chipsViewForSkills: "Render required skills as chips.",
    },
    defaults: {},
  },
  JobEsComponent: {
    id: "job-card-elasticsearch",
    name: "Job Card (Elasticsearch)",
    blurb: "Single job card for Elasticsearch-backed listings.",
    category: "functional",
    capabilities: ["job-summary", "apply-cta"],
    status: "approved",
    composedBy: ["job-listing-elasticsearch"],
    propDocs: {},
    defaults: {},
  },
  FacetsComponent: {
    id: "job-filters",
    name: "Filter Jobs",
    blurb: "Faceted filters — department, location, experience and more.",
    category: "functional",
    capabilities: ["faceted-filters", "clear-all", "mobile-popup", "horizontal-layout"],
    status: "approved",
    propDocs: {
      label: "Heading above the filter panel.",
      isHorizontal: "Lay filters out in a horizontal bar instead of a sidebar.",
      isPopupRequired: "Open filters in a modal (recommended on mobile).",
      isClearAll: "Show a 'clear all filters' action.",
      width: "Fixed width for the filter rail.",
      config: "Which facet groups to show, supplied by tenant configuration.",
    },
    defaults: { label: "Filters", isClearAll: true },
  },
  FilterChipsComponent: {
    id: "filter-chips",
    name: "Applied Filters",
    blurb: "Chips showing the filters a candidate currently has applied.",
    category: "functional",
    capabilities: ["active-filter-display", "remove-filter"],
    status: "approved",
    propDocs: {},
    defaults: {},
  },
  PaginationComponent: {
    id: "pagination",
    name: "Page Through Results",
    blurb: "Pagination controls under a job list.",
    category: "functional",
    capabilities: ["pagination", "material-style", "bootstrap-style"],
    status: "approved",
    propDocs: {
      currentPage: "Page to start on.",
      materialPagination: "Use the Material paginator style.",
      bootstrapPagination: "Use the Bootstrap paginator style.",
    },
    defaults: { currentPage: 1, materialPagination: true },
  },
  JobViewComponent: {
    id: "job-details",
    name: "Job Details",
    blurb: "The full job description page.",
    category: "functional",
    capabilities: ["job-detail", "requisition-fields"],
    status: "approved",
    propDocs: {
      customReqPossition: "Where custom requisition fields appear in the layout.",
    },
    defaults: {},
  },
  JobApplyComponent: {
    id: "job-apply",
    name: "Apply for a Job",
    blurb: "The application form, including resume parsing and screening questions.",
    category: "functional",
    capabilities: [
      "application-form",
      "resume-parsing",
      "screening-questions",
      "terms-and-conditions",
      "recaptcha",
    ],
    status: "approved",
    propDocs: {
      twoColumnsView: "Lay the form out in two columns.",
      isTncRequired: "Require the candidate to accept terms and conditions.",
      searchBarPlaceholder: "Placeholder in the job picker inside the form.",
    },
    defaults: { isTncRequired: true },
  },
  CustomApplyComponent: {
    id: "custom-apply",
    name: "Apply (Custom Fields)",
    blurb: "Application form driven entirely by tenant-configured fields.",
    category: "functional",
    capabilities: ["application-form", "custom-fields", "resume-upload"],
    status: "approved",
    propDocs: {
      jobs: "The jobs a candidate may pick from.",
      searchBarPlaceholder: "Placeholder in the job picker.",
    },
    defaults: {},
  },
  UploadResumeComponent: {
    id: "resume-upload",
    name: "Upload Resume",
    blurb: "Standalone resume drop zone that parses the file into a profile.",
    category: "functional",
    capabilities: ["resume-upload", "resume-parsing"],
    status: "approved",
    propDocs: { themeName: "Named theme variant applied by the library." },
    defaults: {},
  },
  ApplyConfirmationComponent: {
    id: "apply-confirmation",
    name: "Application Confirmation",
    blurb: "The thank-you state shown after a candidate submits an application.",
    category: "functional",
    capabilities: ["confirmation-message"],
    status: "approved",
    propDocs: { message: "Confirmation copy shown to the candidate." },
    defaults: { message: "Thanks — we've received your application." },
  },
  JobRecommendationComponent: {
    id: "job-recommendations",
    name: "Recommended Jobs",
    blurb: "Roles suggested to the candidate, in a row or a grid.",
    category: "functional",
    capabilities: ["recommendations", "horizontal-carousel", "apply-cta"],
    status: "approved",
    propDocs: {
      limit: "How many recommendations to show.",
      horizontalView: "Lay recommendations out horizontally.",
      applyBtnText: "Label on each apply button.",
    },
    defaults: { limit: 6, horizontalView: true },
  },
  RecommendedJobsComponent: {
    id: "recommended-jobs-panel",
    name: "Recommended Jobs Panel",
    blurb: "The results panel rendered by Find Your Spot.",
    category: "functional",
    capabilities: ["recommendations"],
    status: "approved",
    composedBy: ["find-your-spot"],
    propDocs: {},
    defaults: {},
  },
  FindYourSpotComponent: {
    id: "find-your-spot",
    name: "Find Your Spot",
    blurb: "Guided discovery — a candidate uploads a resume and gets matched roles.",
    category: "functional",
    capabilities: ["guided-discovery", "resume-matching", "recommendations"],
    status: "approved",
    propDocs: {
      titleText: "Headline above the guided flow.",
      descriptionText: "Supporting copy under the headline.",
      companyId: "Tenant identifier used to fetch matches.",
    },
    defaults: { titleText: "Find your spot" },
  },
  InitialComponent: {
    id: "tenant-init",
    name: "Tenant Bootstrap",
    blurb: "Resolves the tenant ID before other components load.",
    category: "infrastructure",
    capabilities: ["tenant-resolution"],
    // Infrastructure: required on every site, never offered in the admin catalog.
    status: "internal",
    propDocs: {},
    defaults: {},
  },
};

function extractComponents(libDir) {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".component.d.ts")) files.push(full);
    }
  })(libDir);

  const out = [];
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    const re =
      /ɵɵComponentDeclaration<\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*[^,]+,\s*(\{[\s\S]*?\}|never)\s*,\s*(\{[\s\S]*?\}|never)\s*,/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const [, className, selector, inputsRaw, outputsRaw] = m;
      out.push({
        className,
        selector,
        inputs: [...inputsRaw.matchAll(/"(\w+)":/g)].map((x) => x[1]),
        outputs: [...outputsRaw.matchAll(/"(\w+)":/g)].map((x) => x[1]),
      });
    }
  }
  return out;
}

function main() {
  const versionArg = process.argv.indexOf("--version");
  const spec = versionArg > -1 ? `${PACKAGE}@${process.argv[versionArg + 1]}` : `${PACKAGE}@latest`;

  const work = mkdtempSync(path.join(tmpdir(), "zmlib-"));
  console.log(`Fetching ${spec} into ${work}`);
  const packed = execFileSync("npm", ["pack", spec, "--silent"], { cwd: work })
    .toString()
    .trim()
    .split("\n")
    .pop();
  execFileSync("tar", ["-xzf", packed], { cwd: work });

  const pkgDir = path.join(work, "package");
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const found = extractComponents(path.join(pkgDir, "lib"));

  const components = found.map((c) => {
    const meta = OVERLAY[c.className];
    if (!meta) {
      console.warn(`  ! ${c.className} has no editorial overlay — emitting as unreviewed`);
    }
    const propDocs = meta?.propDocs ?? {};
    return {
      id: meta?.id ?? c.className.replace(/Component$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
      name: meta?.name ?? c.className.replace(/Component$/, ""),
      blurb: meta?.blurb ?? "",
      category: meta?.category ?? "functional",
      status: meta?.status ?? "unreviewed",
      package: PACKAGE,
      packageVersion: pkgJson.version,
      framework: "angular",
      className: c.className,
      selector: c.selector,
      capabilities: meta?.capabilities ?? [],
      composedBy: meta?.composedBy ?? [],
      // Every supported prop, with the subset we have written docs for annotated.
      props: Object.fromEntries(
        c.inputs.map((input) => [
          input,
          { documented: Boolean(propDocs[input]), description: propDocs[input] ?? "" },
        ]),
      ),
      events: c.outputs,
      defaults: meta?.defaults ?? {},
    };
  });

  const registry = {
    $generatedBy: "scripts/build-registry.mjs",
    $source: `${PACKAGE}@${pkgJson.version}`,
    $generatedAt: new Date().toISOString().slice(0, 10),
    $note:
      "Selectors and props are extracted from the compiled .d.ts declarations, " +
      "which are authoritative. The package README's example markup is stale.",
    package: {
      name: PACKAGE,
      version: pkgJson.version,
      framework: "angular",
      ngModule: "ZmCareerSitesLibModule",
      peerDependencies: pkgJson.peerDependencies ?? {},
    },
    components: components.sort((a, b) => a.id.localeCompare(b.id)),
  };

  writeFileSync(OUT, JSON.stringify(registry, null, 2) + "\n");
  console.log(`Wrote ${components.length} components to ${path.relative(process.cwd(), OUT)}`);
}

main();
