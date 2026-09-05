import { enableProdMode } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { AppModule } from "./app/app.module";
import { applyConfig, readConfig } from "./app/preview-config";
import { MockApiInterceptor } from "./app/mock/mock-api.interceptor";
import { setDataset, type JobSeed } from "./app/mock/mock-data";

/**
 * Configuration has to land before Angular starts.
 *
 * `ServerApiService` reads `sessionStorage.APIENDPOINTNEW` in its constructor
 * and `DataStoreService` reads `COMPANYID` in its own, so both are resolved the
 * first time anything injects them. Bootstrapping first and configuring after
 * would leave the library pointed at an empty host for the rest of the session.
 */
const config = readConfig(location.search);
applyConfig(config);
MockApiInterceptor.source = config.source;

/**
 * A project-specific dataset has to be in place before the first component
 * renders, or the job list fires its search against the built-in fixtures and
 * shows the wrong company's roles for a beat. Loading it here — ahead of
 * bootstrap, like the rest of the configuration — avoids that flash entirely.
 *
 * A failure here is not fatal: the built-in dataset stays loaded and the
 * preview still works, which is better than an empty page.
 */
async function loadCustomDataset(): Promise<void> {
  if (config.source !== "custom" || !config.projectId) return;

  try {
    const response = await fetch(`${config.studioOrigin}/api/projects/${config.projectId}/dataset`);
    if (!response.ok) throw new Error(`studio returned ${response.status}`);

    const body = (await response.json()) as {
      dataset: { companyName: string; basedOn: string; roles: JobSeed[] } | null;
    };
    if (!body.dataset?.roles?.length) throw new Error("no dataset saved for this project");

    setDataset(
      body.dataset.roles,
      `${body.dataset.companyName}${body.dataset.basedOn ? ` · researched from ${body.dataset.basedOn}` : ""}`,
    );
  } catch (error) {
    console.warn("[preview] falling back to built-in sample data:", error);
  }
}

if (import.meta.url.includes("/dist/")) enableProdMode();

loadCustomDataset()
  .then(() => platformBrowserDynamic().bootstrapModule(AppModule))
  .catch((error) => {
    // The studio shows an empty frame otherwise, with the reason only in the
    // iframe's own console.
    document.body.innerHTML = `<pre style="padding:24px;font:13px ui-monospace;color:#b3261e;white-space:pre-wrap">${
      error?.message ?? error
    }</pre>`;
    console.error(error);
  });
