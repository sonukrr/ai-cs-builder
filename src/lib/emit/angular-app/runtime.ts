/**
 * The fixed source of a generated Angular site.
 *
 * Emitted verbatim into the destination repository: the application shell, and
 * the component that renders presentation sections. It is a port of the preview
 * host (`preview-app/src/app`), which is not a coincidence — the preview *is*
 * an Angular app running the real `zm-careers-lib`, so the shortest path to a
 * deployed site that renders those components correctly is to ship the same
 * app with the blueprint compiled into it instead of fetched at runtime.
 *
 * What is deliberately dropped from the port: the studio plumbing. No
 * postMessage selection, no click-to-edit outlines, no mock HTTP interceptor,
 * no fetching a blueprint from the studio's API. A published site talks to the
 * real careers API and has no studio to talk to.
 *
 * What is deliberately kept: the storage seeding in `main.ts`. The library
 * reads its tenant identity out of sessionStorage in service constructors, so
 * it has to be there before Angular bootstraps — see `careers.config.ts`.
 */

/** The bootstrap. Order matters; see the comment inside. */
export const MAIN_TS = `import { enableProdMode } from "@angular/core";
import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { AppModule } from "./app/app.module";
import { applyCareersConfig } from "./app/careers.config";
import { environment } from "./environments/environment";

/**
 * Configuration has to land before Angular starts.
 *
 * \`ServerApiService\` reads \`sessionStorage.APIENDPOINTNEW\` in its constructor
 * and \`DataStoreService\` reads \`COMPANYID\` in its own, so both are resolved the
 * first time anything injects them. Bootstrapping first and configuring after
 * would leave the library pointed at an empty host for the rest of the session.
 */
applyCareersConfig();

if (environment.production) enableProdMode();

platformBrowserDynamic()
  .bootstrapModule(AppModule)
  .catch((error) => {
    console.error(error);
  });
`;

export const INDEX_HTML = (title: string, description: string): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${description}" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
`;

export const STYLES_SCSS = `/* Bootstrap and the Material theme are pulled in ahead of this by angular.json,
   because zm-careers-lib depends on both. */
@import "./styles/theme.css";

html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
}

body {
  background: var(--brand-background, #fff);
  color: var(--brand-text, #101214);
  font-family: var(--brand-font-body, system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}

/* The library ships Material form fields at their default density, which is
   tall enough to dominate a hero. Tighten just enough to sit in a page. */
.mat-mdc-form-field {
  width: 100%;
}

/* The library's components carry their own padding inconsistently, so give the
   functional ones a predictable band around them. */
lib-zm-search,
lib-filter-chips,
lib-facets,
lib-jobs-list,
lib-jobs-list-es,
lib-pagination,
lib-job-view,
lib-job-apply,
lib-custom-apply,
lib-upload-resume,
lib-apply-confirmation,
lib-job-recommendation,
lib-find-your-spot {
  display: block;
}

.page > lib-zm-search,
.page > lib-filter-chips,
.page > lib-facets,
.page > lib-jobs-list,
.page > lib-jobs-list-es,
.page > lib-pagination,
.page > lib-job-view,
.page > lib-job-apply,
.page > lib-custom-apply,
.page > lib-upload-resume,
.page > lib-apply-confirmation,
.page > lib-job-recommendation,
.page > lib-find-your-spot {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 32px;
}

/* Inside a layout container the centring above would fight the column it was
   placed in: a 300px facet column would keep a 32px gutter and a max-width it
   can never reach. */
.layout > * {
  min-width: 0;
}

@media (max-width: 720px) {
  .page > lib-zm-search,
  .page > lib-facets,
  .page > lib-jobs-list,
  .page > lib-jobs-list-es,
  .page > lib-job-view,
  .page > lib-job-apply,
  .page > lib-custom-apply,
  .page > lib-upload-resume,
  .page > lib-job-recommendation,
  .page > lib-find-your-spot {
    padding: 20px;
  }
}
`;

/**
 * Pins every careers request to the configured tenant.
 *
 * This is the fix for the one thing that would otherwise make a deployed site
 * look right and list nothing. `CommonService.getDomain()` returns
 * `location.hostname` on any host that is not localhost, so on a
 * `*.vercel.app` URL the library asks the careers API about a domain the API
 * has never heard of — and the API answers 200 with no jobs and no error.
 *
 * The library offers no hook for that. What it does do is send every request
 * through Angular's HttpClient, so an interceptor can put the right tenant back
 * on the way out. That is all this does: rewrite `domain` and `companyId` on
 * careers-API traffic to the values in careers.config.ts, and nothing else.
 *
 * WHEN TO DELETE THIS. Once the site is served from the careers domain itself,
 * the library derives the same values on its own and this becomes a no-op worth
 * removing — while it is here, the site asks about this one tenant wherever it
 * is deployed, which is exactly what you do not want if the repository is ever
 * reused for a different company.
 */
export const TENANT_INTERCEPTOR_TS = `import { Injectable } from "@angular/core";
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from "@angular/common/http";
import { Observable } from "rxjs";
import { CAREERS } from "./careers.config";

@Injectable()
export class CareersTenantInterceptor implements HttpInterceptor {
  private readonly apiHost = hostOf(CAREERS.apiEndpoint);

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only careers-API traffic. Anything else the app fetches is its own.
    if (hostOf(request.url) !== this.apiHost) return next.handle(request);

    let updated = request;

    // The search and the apply flow send their tenant as multipart fields.
    if (request.body instanceof FormData) {
      const body = request.body;
      if (body.has("domain")) body.set("domain", CAREERS.domain);
      if (body.has("companyId")) body.set("companyId", CAREERS.companyId);
      updated = updated.clone({ body });
    } else if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
      const body: Record<string, any> = { ...(request.body as Record<string, any>) };
      let touched = false;
      if ("domain" in body) {
        body["domain"] = CAREERS.domain;
        touched = true;
      }
      if ("companyId" in body) {
        body["companyId"] = CAREERS.companyId;
        touched = true;
      }
      if (touched) updated = updated.clone({ body });
    }

    // Some reads carry it in the query string instead.
    let params = updated.params;
    if (params.has("domain")) params = params.set("domain", CAREERS.domain);
    if (params.has("companyId")) params = params.set("companyId", CAREERS.companyId);
    if (params !== updated.params) updated = updated.clone({ params });

    /*
      The library sets TenantGroupId from localStorage.tenantId, which nothing
      seeds. The search works without it, so it is only sent when configured —
      sending a wrong group id is worse than sending none.
    */
    if (CAREERS.tenantGroupId && !updated.headers.has("TenantGroupId")) {
      updated = updated.clone({
        headers: updated.headers.set("TenantGroupId", CAREERS.tenantGroupId),
      });
    }

    return next.handle(updated);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url, window.location.origin).host;
  } catch {
    return "";
  }
}
`;

export const APP_COMPONENT_TS = `import { Component } from "@angular/core";

/** The shell. Every page is a route, so there is nothing else to render here. */
@Component({
  selector: "app-root",
  template: "<router-outlet></router-outlet>",
})
export class AppComponent {}
`;

export const ENVIRONMENT_TS = `export const environment = { production: false };
`;

export const ENVIRONMENT_PROD_TS = `export const environment = { production: true };
`;

/**
 * The presentation sections, ported from the preview host.
 *
 * `custom-html` is absent on purpose: the Angular emitter writes a replica's
 * markup straight into the page template and its stylesheet into theme.css, so
 * this component never sees one. Everything else is the preview's template,
 * element for element and class for class, so a published page renders what the
 * administrator approved.
 */
export const SECTION_COMPONENT_TS = `import { Component, HostBinding, Input } from "@angular/core";
import { site } from "./site.config";

@Component({
  selector: "app-section",
  templateUrl: "./section.component.html",
  styleUrls: ["./section.component.scss"],
})
export class SectionComponent {
  /** The static section type: hero, benefits, footer, and so on. */
  @Input() type = "";
  @Input() sectionId = "";
  @Input() label = "";
  @Input() content: Record<string, any> = {};

  readonly year = new Date().getFullYear();
  readonly companyName = site.name;
  readonly tagline = site.tagline;
  readonly nav = site.nav;

  /** Replica stylesheets are scoped to this attribute; harmless elsewhere. */
  @HostBinding("attr.data-section-id") get hostSectionId(): string | null {
    return this.sectionId || null;
  }

  /** Content lookup with a fallback, so a missing field never renders "undefined". */
  value(key: string, fallback = ""): string {
    const raw = this.content?.[key];
    return typeof raw === "string" && raw.trim() ? raw : fallback;
  }

  get items(): Record<string, any>[] {
    const raw = this.content?.["items"];
    return Array.isArray(raw) ? raw : [];
  }

  /** Images were rewritten into /assets/ when the site was generated. */
  image(key = "image"): string {
    return this.value(key);
  }

  imageAlt(key = "image"): string {
    return this.value(key + "Alt") || this.value("headline") || this.label;
  }

  itemImage(item: Record<string, any>, key: string): string {
    const raw = item?.[key];
    return typeof raw === "string" ? raw : "";
  }

  itemAlt(item: Record<string, any>, key: string): string {
    return String(item?.[key + "Alt"] ?? item?.["name"] ?? item?.["city"] ?? "");
  }

  /** Both stock licences require attribution while the image is on screen. */
  credit(key = "image"): { text: string; url: string } | null {
    const raw = this.content?.[key + "Credit"];
    return raw && typeof raw === "object" ? (raw as { text: string; url: string }) : null;
  }
}
`;
