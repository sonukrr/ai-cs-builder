/**
 * Fixture data for the preview, in the API's real response shape.
 *
 * The shape here — an Elasticsearch envelope of `_source` hits, a `facets` map
 * of `{ key, doc_count }` buckets, and a `facetedSearchConfig` describing which
 * facets to render — was taken from a live response so the real library
 * components parse it exactly as they parse production data.
 *
 * The *content* is entirely invented, for a fictional company. Reference sites
 * were used to learn the format, never as a source of data to copy.
 */

export interface JobSeed {
  title: string;
  department: string;
  city: string;
  country: string;
  type: string;
  minExp: number;
  maxExp: number;
  skills: string[];
  summary: string;
}

/**
 * The built-in dataset.
 *
 * Used when the preview is on "Sample data". A project can instead carry a
 * dataset the agent researched for that specific company — same shape, same
 * code path, different rows. See setDataset below.
 */
const DEFAULT_SEEDS: JobSeed[] = [
  { title: "Senior Backend Engineer", department: "Engineering", city: "London", country: "United Kingdom", type: "Full Time", minExp: 5, maxExp: 9, skills: ["Go", "PostgreSQL", "Kafka"], summary: "Own the payments ledger end to end, from schema to settlement." },
  { title: "Staff Site Reliability Engineer", department: "Engineering", city: "Berlin", country: "Germany", type: "Full Time", minExp: 7, maxExp: 12, skills: ["Kubernetes", "Terraform", "Go"], summary: "Keep a platform two million businesses depend on quietly boring." },
  { title: "Product Designer", department: "Design", city: "Remote", country: "United Kingdom", type: "Full Time", minExp: 3, maxExp: 6, skills: ["Figma", "Prototyping", "Design Systems"], summary: "Shape the surfaces candidates and recruiters actually touch." },
  { title: "Design Systems Engineer", department: "Design", city: "London", country: "United Kingdom", type: "Full Time", minExp: 4, maxExp: 8, skills: ["TypeScript", "Angular", "Accessibility"], summary: "Own the component library every product team builds on." },
  { title: "Solutions Engineer", department: "Sales", city: "Berlin", country: "Germany", type: "Full Time", minExp: 3, maxExp: 7, skills: ["Pre-sales", "APIs", "Integrations"], summary: "Turn a hard integration question into a signed customer." },
  { title: "Enterprise Account Executive", department: "Sales", city: "Amsterdam", country: "Netherlands", type: "Full Time", minExp: 6, maxExp: 11, skills: ["Enterprise Sales", "Negotiation"], summary: "Carry the enterprise number across the Benelux region." },
  { title: "Data Analyst", department: "Data", city: "Bengaluru", country: "India", type: "Full Time", minExp: 2, maxExp: 5, skills: ["SQL", "dbt", "Python"], summary: "Answer the questions the leadership team has not thought to ask." },
  { title: "Machine Learning Engineer", department: "Data", city: "Bengaluru", country: "India", type: "Full Time", minExp: 4, maxExp: 8, skills: ["Python", "PyTorch", "MLOps"], summary: "Take matching models from notebook to production traffic." },
  { title: "Technical Recruiter", department: "People", city: "London", country: "United Kingdom", type: "Full Time", minExp: 3, maxExp: 6, skills: ["Sourcing", "Interviewing"], summary: "Hire the engineers who build the thing that helps people hire." },
  { title: "People Operations Partner", department: "People", city: "Remote", country: "Germany", type: "Part Time", minExp: 4, maxExp: 8, skills: ["HR Operations", "Employment Law"], summary: "Make the everyday employee experience genuinely good." },
  { title: "Customer Success Manager", department: "Customer Experience", city: "Amsterdam", country: "Netherlands", type: "Full Time", minExp: 3, maxExp: 6, skills: ["Account Management", "Onboarding"], summary: "Own renewal and expansion for a book of mid-market accounts." },
  { title: "Support Engineer", department: "Customer Experience", city: "Bengaluru", country: "India", type: "Full Time", minExp: 1, maxExp: 4, skills: ["Debugging", "SQL", "Zendesk"], summary: "Be the person who actually finds the root cause." },
  { title: "Engineering Manager, Platform", department: "Engineering", city: "London", country: "United Kingdom", type: "Full Time", minExp: 8, maxExp: 14, skills: ["Leadership", "Distributed Systems"], summary: "Lead the team that everything else is built on top of." },
  { title: "Security Engineer", department: "Engineering", city: "Remote", country: "United Kingdom", type: "Full Time", minExp: 5, maxExp: 10, skills: ["AppSec", "Threat Modelling"], summary: "Find the problems before anybody else does." },
  { title: "Content Designer", department: "Design", city: "Remote", country: "Netherlands", type: "Contract", minExp: 2, maxExp: 6, skills: ["UX Writing", "Content Strategy"], summary: "Make every screen say the true thing in the fewest words." },
];

const DAY = 86_400_000;

function slug(...parts: string[]): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds one hit.
 *
 * The library reads a small subset of `_source` — real responses carry over two
 * hundred fields — so only the fields the components actually touch are
 * populated, plus the identifiers the apply and detail flows need.
 */
function buildHit(seed: JobSeed, index: number) {
  const jobId = 900_000 + index;
  const location = `${seed.city}, ${seed.country}`;

  return {
    _index: "esmapping-v1",
    _type: "_doc",
    _id: String(jobId),
    _score: null,
    sort: [Date.now() - index * DAY],
    _source: {
      id: jobId,
      jobId,
      jobCode: `NW-${1000 + index}`,
      jobTitle: seed.title,
      jobUrl: slug(seed.title, seed.city, String(jobId)),
      departmentId: 17000 + index,
      departmentName: seed.department,
      DepartmentName: seed.department,
      city: seed.city,
      state: seed.city,
      country: seed.country,
      location,
      locationSeparatedbySlash: location,
      // A string, not an array — JobComponent calls .split() on locAgg and
      // skillSet, and the live payload sends both as comma-separated strings
      // even though the neighbouring *List fields are real arrays.
      locAgg: location,
      employeeType: seed.type,
      jobType: seed.type,
      jobTypeFieldDisplayName: seed.type,
      workMode: seed.city === "Remote" ? "Remote" : "Hybrid",
      minYearOfExperience: seed.minExp,
      maxYearOfExperience: seed.maxExp,
      minYrsOfExperience: seed.minExp,
      maxYrsOfExperience: seed.maxExp,
      yrsOfExperience: `${seed.minExp} - ${seed.maxExp} years`,
      experienceUIField: `${seed.minExp} - ${seed.maxExp} years`,
      skillSet: seed.skills.join(", "),
      mandatorySkills: seed.skills,
      jdSkillsKnownList: seed.skills,
      parsed_skills: seed.skills,
      shortDescription: seed.summary,
      shortDescriptionWithoutHtml: seed.summary,
      mediumDescription: `<p>${seed.summary}</p>`,
      mediumDescriptionWithoutHtml: seed.summary,
      metaTitle: seed.title,
      metaDescription: seed.summary,
      responsibility: `<ul><li>${seed.summary}</li><li>Work closely with ${seed.department.toLowerCase()} and the wider team.</li></ul>`,
      qualification: `${seed.minExp}+ years of relevant experience.`,
      status: "Open",
      displayStatus: "Open",
      isCompanyLive: true,
      appliesNotBlocked: true,
      attachResume: true,
      referralEnabled: false,
      positionsRequired: 1 + (index % 3),
      createdDate: Date.now() - (index + 7) * DAY,
      createDate: Date.now() - (index + 7) * DAY,
      modifiedDate: Date.now() - index * DAY,
      jobCreatedDate: Date.now() - (index + 7) * DAY,
      companyId: 16159,
      domain: "northwind.preview.local",
      careerSiteUrl: "https://northwind.preview.local",
      salary: null,
      showSal: false,
      reqFieldsAndValues: null,
      jobSpecificQuestions: [],
      isJobSpecificQuestionsEnabled: false,
    },
  };
}

type Hit = ReturnType<typeof buildHit>;

/** Counts distinct values across a set of roles, the way Elasticsearch would. */
function bucketsFor(seeds: JobSeed[], field: (seed: JobSeed) => string | string[]) {
  const counts = new Map<string, number>();
  for (const seed of seeds) {
    const value = field(seed);
    for (const key of Array.isArray(value) ? value : [value]) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, doc_count]) => ({ key, doc_count }));
}

function facetsFor(seeds: JobSeed[]) {
  return {
    Department: bucketsFor(seeds, (s) => s.department),
    Location: bucketsFor(seeds, (s) => `${s.city}, ${s.country}`),
    Skills: bucketsFor(seeds, (s) => s.skills.map((k) => k.toLowerCase())),
    "Employment Type": bucketsFor(seeds, (s) => s.type),
  };
}

/**
 * The dataset currently backing the preview.
 *
 * Mutable so a project-specific dataset — roles the agent researched for this
 * company — can replace the built-in one without any other code changing. The
 * facets are always derived from whichever roles are loaded, so filtering keeps
 * working on a dataset nobody wrote by hand.
 */
let active: { seeds: JobSeed[]; hits: Hit[]; facets: ReturnType<typeof facetsFor>; label: string } = {
  seeds: DEFAULT_SEEDS,
  hits: DEFAULT_SEEDS.map(buildHit),
  facets: facetsFor(DEFAULT_SEEDS),
  label: "built-in sample data",
};

export function setDataset(seeds: JobSeed[], label: string): void {
  if (seeds.length === 0) return;
  active = { seeds, hits: seeds.map(buildHit), facets: facetsFor(seeds), label };
}

export function datasetLabel(): string {
  return active.label;
}

export function datasetSize(): number {
  return active.seeds.length;
}

/**
 * Rows for `lib-job-recommendation`.
 *
 * The only section whose data does not arrive over HTTP: the component takes
 * its jobs as an `@Input` with no default, so nothing the interceptor answers
 * can reach it — and reading `jobs.length` on undefined threw on every change
 * detection pass, which took the whole section down. In the real site the list
 * comes back from the resume parser after a candidate uploads a CV, so the
 * preview stands in the loaded dataset: the same roles the job list is showing.
 */
export function mockRecommendations(): { jobTitle: string; location: string; jobUrl: string }[] {
  return active.hits.map((hit) => ({
    jobTitle: hit._source.jobTitle,
    location: hit._source.location,
    jobUrl: hit._source.jobUrl,
  }));
}

const DOMAIN = "northwind.preview.local";

/** One entry of `facetedSearchConfig.facets`, in the API's exact field set. */
function facetConfig(fieldName: string, displayName: string) {
  return {
    displayInColumn: false,
    displayInFacetList: true,
    displayInAdvancedSearch: false,
    fieldName,
    displayName,
    type: "keyword",
    nestedPath: null,
    mainAgg: null,
    sortByAlphabeticalOrder: false,
    sortOrder: null,
    subAgg: null,
    scope: [DOMAIN],
    ranges: [],
  };
}

/**
 * The faceted search configuration, mirroring the live payload field for field.
 *
 * Getting this exactly right matters more than it looks. `FacetsComponent`
 * reads `config.range.displayName` unguarded, so omitting `range` — as an
 * earlier version of this fixture did — throws on every change-detection pass
 * and the filter rail renders empty. `facetsMapping` is equally load-bearing:
 * the `facets` response is keyed by display name, and this is what maps those
 * keys back to the field a selection filters on.
 */
const FACETED_SEARCH_CONFIG = {
  companyId: "16159",
  configId: null,
  domain: DOMAIN,
  paginationHowMuch: "10",
  paginationRequired: true,
  sortBasedOnConfigCriteria: "modifiedDate",
  visibleNumberOfPages: "5",
  countLimitForLeadingWildCard: null,
  jobsCountResponse: null,
  facets: [
    facetConfig("departmentName", "Department"),
    facetConfig("locAgg", "Location"),
    facetConfig("skillSet", "Skills"),
    facetConfig("employeeType", "Employment Type"),
  ],
  range: {
    displayInColumn: true,
    displayInFacetList: true,
    displayInAdvancedSearch: true,
    fieldName: null,
    displayName: "By Experience (in Years)",
    type: null,
    nestedPath: null,
    mainAgg: null,
    sortByAlphabeticalOrder: false,
    sortOrder: null,
    subAgg: null,
    scope: [DOMAIN],
    ranges: [
      {
        from: "minYearOfExperience",
        to: "maxYearOfExperience",
        from_as_string: null,
        to_as_string: null,
        key: null,
        doc_count: null,
        rangeName: null,
      },
    ],
  },
  nestedFacets: [],
  facetsMapping: {
    Department: "departmentName",
    Location: "locAgg",
    Skills: "skillSet",
    "Employment Type": "employeeType",
  },
  nestedFacetsMapping: {},
  freeTextfieldsConfig: {
    terms: { string: ["skillSet", "mandatorySkills"] },
    wildcard: { string: ["jobTitle", "locAgg"] },
  },
  booleanSearchConfig: {},
  columnConfig: {},
  bucketsCount: null,
  queryCriteria: {},
  bucketsOrder: null,
  bucketsIconLabel: null,
  appliesconf: null,
  appliesButtonToShow: null,
  projectionFields: null,
  enableTabOnViewDetailsButton: false,
  uiFields: [],
  rankFeaturedJobsOnTop: true,
  fieldsToExclude: [],
};

/** Applies the keyword and facet selections the library sends in `filterCri`. */
function filterHits(filterCri: Record<string, unknown>) {
  const keyword = String(filterCri?.["anyOfTheseWords"] ?? "").trim().toLowerCase();
  let hits = active.hits;

  if (keyword) {
    hits = hits.filter((hit) => {
      const source = hit._source;
      const haystack = [
        source.jobTitle,
        source.departmentName,
        source.location,
        source.shortDescription,
        source.skillSet,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }

  // Facet selections arrive as arrays keyed by the configured field name.
  const selectors: Record<string, (hit: Hit) => string[]> = {
    departmentName: (hit) => [hit._source.departmentName],
    locAgg: (hit) => [hit._source.locAgg],
    skillSet: (hit) => hit._source.skillSet.split(",").map((s) => s.trim()),
    employeeType: (hit) => [hit._source.employeeType],
  };

  for (const [field, select] of Object.entries(selectors)) {
    const raw = filterCri?.[field];
    const chosen = Array.isArray(raw) ? raw.map((v) => String(v).toLowerCase()) : [];
    if (chosen.length === 0) continue;
    hits = hits.filter((hit) => select(hit).some((v) => chosen.includes(String(v).toLowerCase())));
  }

  return hits;
}

/** A search response in the exact envelope the live API returns. */
export function mockSearchResponse(filterCri: Record<string, unknown>) {
  const matched = filterHits(filterCri ?? {});
  const start = Number(filterCri?.["paginationStartNo"] ?? 0) || 0;
  const size = Number(FACETED_SEARCH_CONFIG.paginationHowMuch);
  const page = matched.slice(start, start + size);

  return {
    code: 200,
    type: null,
    message: null,
    exception: null,
    webserviceAPIResponseCode: null,
    data: {
      data: page,
      facets: active.facets,
      totalCount: matched.length,
      hasMoreData: start + size < matched.length,
      facetedSearchConfig: FACETED_SEARCH_CONFIG,
      bucketsData: null,
      campaignInfo: null,
    },
  };
}

export function mockJobResponse(jobUrl: string) {
  const hit = active.hits.find((h) => h._source.jobUrl === jobUrl) ?? active.hits[0];
  return { code: 200, message: null, exception: null, data: hit._source };
}

export function mockTenantResponse() {
  return {
    responseStatus: "SUCCESS",
    responseCode: 200,
    reponseObject: { name: "Preview", tenantGroupId: "G1" },
  };
}

export function mockCompanyConfigResponse() {
  return {
    code: 200,
    message: null,
    exception: null,
    data: {
      companyId: 16159,
      companyName: "Northwind Labs",
      careerSiteConfigurations: { applyEnabled: true, resumeParsingEnabled: true },
    },
  };
}

/** Apply-field config, kept minimal so the form renders without a live tenant. */
export function mockApplyFieldsResponse() {
  return {
    code: 200,
    message: null,
    exception: null,
    data: [
      { fieldName: "firstName", displayName: "First name", mandatory: true, type: "text", order: 1 },
      { fieldName: "lastName", displayName: "Last name", mandatory: true, type: "text", order: 2 },
      { fieldName: "email", displayName: "Email address", mandatory: true, type: "email", order: 3 },
      { fieldName: "mobile", displayName: "Phone", mandatory: false, type: "phone", order: 4 },
    ],
  };
}

export function mockFileConfigResponse() {
  return {
    code: 200,
    data: { supportedFileTypes: ["pdf", "doc", "docx"], maxFileSizeInMB: 5 },
  };
}
