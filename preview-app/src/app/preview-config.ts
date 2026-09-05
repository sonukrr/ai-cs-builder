/**
 * Runtime configuration for one preview, read from the iframe's query string.
 *
 * `zm-careers-lib` is configured through browser storage rather than Angular
 * DI: `ServerApiService` reads `sessionStorage.APIENDPOINTNEW` in its
 * constructor, `DataStoreService` reads `sessionStorage.COMPANYID`, and
 * `EndpointsService.returnTenantHeader()` reads `localStorage.tenantId` on
 * every call. All of that must therefore be in place *before* Angular
 * bootstraps — see main.ts, which is why this module has no Angular imports.
 */

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
  /** API host for live mode. */
  apiHost: string;
  /** TenantGroupId header value. */
  tenantId: string;
  /** Base64-encoded company id — the library decodes it with window.atob. */
  companyId: string;
  /** The career site's own domain, sent as `domain` on every search. */
  domain: string;
}

const DEFAULT_API_HOST = "https://apipreprod1.zwayam.com";

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
    apiHost: (params.get("api") ?? DEFAULT_API_HOST).replace(/\/+$/, ""),
    tenantId: params.get("tenant") ?? "",
    companyId: params.get("company") ?? "",
    domain: params.get("domain") ?? "",
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
 * In mock mode the host is still a syntactically valid URL so the library
 * builds well-formed requests; the interceptor answers them before they leave
 * the browser, so nothing is actually sent.
 */
export function applyConfig(config: PreviewConfig): void {
  // MOCK_HOST is the sentinel the interceptor matches on; keep them in step.
  const host = config.source === "live" ? config.apiHost : MOCK_HOST;

  // The library appends endpoint paths directly, so the host needs its slash.
  sessionStorage.setItem("APIENDPOINTNEW", `${host}/`);
  sessionStorage.setItem("TENANTAPIURL", host);

  const domain = config.domain || location.hostname;
  sessionStorage.setItem("DOMAIN", domain);
  sessionStorage.setItem("COMPANYURL", btoa(`${domain}/manage`));

  // The library logs "Mandatory variables are not set" and skips work when it
  // has no company. Mock mode has no real tenant, so stand one in that matches
  // the companyId inside the fixtures.
  const companyId = config.companyId || (isMocked(config.source) ? btoa("16159") : "");
  if (companyId) sessionStorage.setItem("COMPANYID", companyId);
  if (config.tenantId) localStorage.setItem("tenantId", config.tenantId);
}
