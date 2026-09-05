/**
 * Runtime configuration for one preview.
 *
 * `zm-careers-lib` is configured through browser storage rather than Angular
 * DI: `ServerApiService` reads `sessionStorage.APIENDPOINTNEW` in its
 * constructor, `DataStoreService` reads `sessionStorage.COMPANYID`, and
 * `CommonService` reads `DOMAIN` / `COMPANYURL`. All of that must be in place
 * *before* Angular bootstraps — see main.ts, which is why this module has no
 * Angular imports.
 *
 * The careers-API identity below is fixed rather than passed in per preview.
 * Seeding these five keys is the whole contract the library needs to run, so
 * plumbing them through the iframe URL only added a way to get them wrong.
 * Only what genuinely varies per preview — which project, which page, sample
 * or live data — still travels in the query string.
 */

/** Everything the library needs to identify the tenant it is running for. */
export const CAREERS = {
  /** Base64 company id — the library decodes it with window.atob. */
  companyId: "MTY4ODE=",
  /**
   * Base64 of `${domain}/manage`, which is exactly what `getCompanyUrl()`
   * computes for itself off localhost. The `/manage` suffix belongs here and
   * only here.
   */
  companyUrl: "dHJpYW56ZGlnaXRhbC5wcmVwcm9kMS5vcGVuaW5ncy5jby9tYW5hZ2U=",
  /**
   * The career site's own host, sent as `domain` on every search — bare, with
   * no path. `/manage` here is not a harmless extra: the search endpoint
   * matches the tenant on this string exactly, answers `200` either way, and
   * returns `data: null` when it does not recognise it, so the job list comes
   * up empty in live mode with nothing on the console to say why.
   */
  domain: "trianzdigital.preprod1.openings.co",
  /** Trailing slash included: the library appends endpoint paths directly. */
  apiEndpoint: "https://apipreprod1.zwayam.com/",
} as const;

/**
 * Where the library's job data comes from.
 *
 * - `sample` — the built-in fixtures. Always works, no credentials.
 * - `custom` — roles the agent researched for this specific company. Same code
 *   path as `sample`; only the rows differ.
 * - `live`  — the real careers API.
 */
export type DataSource = "sample" | "custom" | "live";

/** `sample` and `custom` are both served by the interceptor. */
export function isMocked(source: DataSource): boolean {
  return source !== "live";
}

export interface PreviewConfig {
  /** Which studio project's blueprint to render. */
  projectId: string;
  /** Which page of that blueprint. Empty means the first one. */
  pageId: string;
  /** Where the blueprint is fetched from. */
  studioOrigin: string;
  /** mock: the library runs against fixtures. live: against the real API. */
  source: DataSource;
  /** Fixed tenant identity, exposed so templates can bind it. */
  companyId: string;
  domain: string;
}

/**
 * Where mock mode points the library.
 *
 * Nothing is ever sent here — the interceptor answers first — but it has to be
 * a real, distinctive origin so requests are well formed and so the interceptor
 * can tell library traffic apart from the app's own call to the studio API.
 */
export const MOCK_HOST = "https://mock.local";

export function readConfig(search: string): PreviewConfig {
  const params = new URLSearchParams(search);
  const requested = params.get("source");
  const source: DataSource =
    requested === "live" ? "live" : requested === "custom" ? "custom" : "sample";

  return {
    projectId: params.get("project") ?? "",
    pageId: params.get("page") ?? "",
    studioOrigin: params.get("studio") ?? "http://localhost:3000",
    source,
    companyId: CAREERS.companyId,
    domain: CAREERS.domain,
  };
}

/**
 * Seeds the storage the library reads. Must run before bootstrap.
 *
 * The library has a first-class localhost path: `CommonService.getDomain()` and
 * `getCompanyUrl()` fall back to `sessionStorage.DOMAIN` / `COMPANYURL` when
 * `location.hostname === "localhost"`, and otherwise derive both from the real
 * hostname. That is why the preview must be served from `localhost` rather than
 * `127.0.0.1` — the two are not interchangeable to this check.
 *
 * In mock mode the endpoint is swapped for the sentinel host so the library
 * still builds well-formed requests; the interceptor answers them before they
 * leave the browser, so nothing is actually sent. Everything else is identical
 * in both modes.
 */
export function applyConfig(config: PreviewConfig): void {
  // MOCK_HOST is the sentinel the interceptor matches on; keep them in step.
  const endpoint = isMocked(config.source) ? `${MOCK_HOST}/` : CAREERS.apiEndpoint;

  sessionStorage.setItem("APIENDPOINT", endpoint);
  sessionStorage.setItem("APIENDPOINTNEW", endpoint);
  sessionStorage.setItem("TENANTAPIURL", endpoint.replace(/\/+$/, ""));

  sessionStorage.setItem("COMPANYID", CAREERS.companyId);
  sessionStorage.setItem("COMPANYURL", CAREERS.companyUrl);
  sessionStorage.setItem("DOMAIN", CAREERS.domain);
}
