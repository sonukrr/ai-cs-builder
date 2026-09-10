import type { Blueprint, Page } from "@/lib/blueprint/schema";
import { registry } from "@/lib/registry";
import { emitAngularSite, usedComponents } from "@/lib/emit/angular";
import {
  ANGULAR_ASSETS,
  collectStudioAssets,
  rebaseAssets,
  type StudioAsset,
} from "@/lib/emit/assets";
import {
  APP_COMPONENT_TS,
  ENVIRONMENT_PROD_TS,
  ENVIRONMENT_TS,
  INDEX_HTML,
  MAIN_TS,
  SECTION_COMPONENT_TS,
  STYLES_SCSS,
  TENANT_INTERCEPTOR_TS,
} from "./runtime";
import { SECTION_COMPONENT_HTML, SECTION_COMPONENT_SCSS } from "./template";

/**
 * Emits a deployable Angular site that runs the real approved component library.
 *
 * This is the answer to the one thing the React target cannot do.
 * `zm-careers-lib` is an Angular 15 library: its components are declared in an
 * NgModule and constructed by Angular's injector, so no amount of packaging
 * makes them render inside React. A React site can only mark them as gaps —
 * which is honest, and useless to a candidate who wants to search for a job.
 *
 * So for a site that uses them, the deployable artefact is an Angular
 * application, and the shortest correct route to one is the preview host: it is
 * already an Angular app running the real library against the same blueprint.
 * This emitter ships that app with the blueprint compiled in — page templates
 * from `emit/angular.ts` binding the library's genuine selectors and inputs,
 * the presentation sections ported from the preview, and the library installed
 * from npm like any other dependency.
 *
 * THE ONE THING TO KNOW BEFORE DEPLOYING. The library resolves its tenant from
 * `sessionStorage` only on localhost; on any other hostname
 * `CommonService.getDomain()` and `getCompanyUrl()` derive it from
 * `location.hostname` instead. The careers API answers an unrecognised domain
 * with `200` and `data: null`, so a site served from a `*.vercel.app` hostname
 * renders every component perfectly and lists no jobs, with nothing on the
 * console to say why. `emitAngularApp` therefore returns that as a warning
 * every time, and the generated README says it too.
 */

export interface AngularSiteFile {
  path: string;
  /** UTF-8 source, or base64 for the images copied out of the asset store. */
  content: string;
  encoding: "utf-8" | "base64";
}

export interface EmitAngularOptions {
  /** Bytes for the assets `collectStudioAssets` found, keyed by their URL. */
  images?: Map<string, { base64: string }>;
  studioProjectId?: string;
}

export interface AngularSite {
  files: AngularSiteFile[];
  warnings: string[];
  notes: string[];
  pages: { id: string; route: string; file: string }[];
  /** Approved library components this site actually renders. */
  libraryComponents: string[];
  assets: StudioAsset[];
}

/**
 * The tenant identity seeded into browser storage before Angular boots.
 *
 * The same values the preview host uses (`preview-app/src/app/preview-config.ts`
 * — the source of truth), because those are the ones known to make the careers
 * API answer. They are emitted as a plain, editable module rather than read
 * from the studio's environment: a published site belongs to one company, and
 * a tenant that changed because an environment variable changed somewhere else
 * would be a very quiet way to point a live careers site at the wrong company.
 */
const CAREERS = {
  /** Base64 company id — the library decodes it with window.atob. */
  companyId: "MTY4ODE=",
  /** Base64 of `${domain}/manage`, which is what `getCompanyUrl()` computes. */
  companyUrl: "dHJpYW56ZGlnaXRhbC5wcmVwcm9kMS5vcGVuaW5ncy5jby9tYW5hZ2U=",
  /** The career site's own host, sent as `domain` on every search. */
  domain: "trianzdigital.preprod1.openings.co",
  /** Trailing slash included: the library appends endpoint paths directly. */
  apiEndpoint: "https://apipreprod1.zwayam.com/",
  /**
   * The TenantGroupId header, when it is known.
   *
   * `returnTenantHeader()` in the library reads `localStorage.tenantId` and
   * sends the header only if it is set — and nothing in the preview or here
   * seeds it. `/jobs/search` answers 200 with real jobs without it, so it is
   * left empty rather than filled with a guess: a wrong group id is worse than
   * no header at all.
   */
  tenantGroupId: "",
} as const;

/** Versions taken from the preview host, which is a working install. */
const DEPENDENCIES: Record<string, string> = {
  "@angular/animations": "^15.2.10",
  "@angular/cdk": "^15.2.9",
  "@angular/common": "^15.2.10",
  "@angular/compiler": "^15.2.10",
  "@angular/core": "^15.2.10",
  "@angular/forms": "^15.2.10",
  "@angular/material": "^15.2.9",
  "@angular/material-moment-adapter": "^15.2.9",
  "@angular/platform-browser": "^15.2.10",
  "@angular/platform-browser-dynamic": "^15.2.10",
  "@angular/router": "^15.2.10",
  bootstrap: "^5.3.0-alpha3",
  "google-libphonenumber": "^3.2.34",
  moment: "^2.30.1",
  "ng-recaptcha": "^11.0.0",
  "ngx-bootstrap": "^10.3.0",
  "ngx-intl-tel-input": "^14.0.0",
  "ngx-mat-select-search": "^7.0.5",
  "ngx-skeleton-loader": "^8.0.0",
  rxjs: "~7.8.0",
  tslib: "^2.6.0",
  "zm-careers-lib": `^${registry.package.version}`,
  "zone.js": "~0.12.0",
};

const DEV_DEPENDENCIES: Record<string, string> = {
  "@angular-devkit/build-angular": "^15.2.11",
  "@angular/cli": "^15.2.11",
  "@angular/compiler-cli": "^15.2.10",
  typescript: "~4.9.5",
};

function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

function pascal(value: string): string {
  const name = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Page${name}`;
}

function componentClassName(page: Page): string {
  return `${pascal(page.id)}PageComponent`;
}

/** A link the generated site may emit: an internal route or an absolute URL. */
function safeHref(value: unknown): string {
  if (typeof value !== "string") return "";
  const href = value.trim();
  if (/^https?:\/\//i.test(href)) return href;
  // `//evil.com` and `/\evil.com` both leave the site; a real route never does.
  if (/^\/[^/\\]/.test(href) || href === "/") return href;
  return "";
}

/**
 * The blueprint with navigation and call-to-action targets resolved.
 *
 * A blueprint names a target page by id, which means nothing to a browser or to
 * Angular's router. Resolving them here is what makes the hero's button a real
 * link on the published site — the preview renders `javascript:void(0)` because
 * it has nowhere to go.
 */
function resolveLinks(blueprint: Blueprint): Blueprint {
  const routes = new Map(blueprint.pages.map((page) => [page.id, page.path]));

  const withLinks = (content: Record<string, unknown>): Record<string, unknown> => {
    const target = content.ctaPageId;
    const resolved =
      typeof target === "string" && routes.has(target)
        ? safeHref(routes.get(target))
        : safeHref(content.ctaHref);

    if (!resolved) {
      if (content.ctaHref === undefined) return content;
      const { ctaHref: _dropped, ...rest } = content;
      return rest;
    }
    return { ...content, ctaHref: resolved };
  };

  const walk = (sections: Blueprint["pages"][number]["sections"]): typeof sections =>
    sections.map((section) => ({
      ...section,
      content: withLinks(section.content as Record<string, unknown>),
      children: section.children ? walk(section.children) : [],
    }));

  return {
    ...blueprint,
    pages: blueprint.pages.map((page) => ({ ...page, sections: walk(page.sections) })),
  };
}

function emitCareersConfig(): string {
  return `/**
 * The tenant identity \`zm-careers-lib\` runs against.
 *
 * The library is configured through browser storage rather than Angular DI:
 * \`ServerApiService\` reads \`sessionStorage.APIENDPOINTNEW\` in its constructor,
 * \`DataStoreService\` reads \`COMPANYID\`, and \`CommonService\` reads \`DOMAIN\` and
 * \`COMPANYURL\`. All of it has to be in place before Angular bootstraps, which
 * is why main.ts calls this first and why this file imports nothing.
 *
 * Off localhost the library ignores \`domain\` and \`companyUrl\` and derives both
 * from \`location.hostname\` instead — which on a deployment URL is a domain the
 * careers API has never heard of, and it answers those with 200 and no jobs.
 * \`CareersTenantInterceptor\` puts these values back on every outgoing request
 * so the deployed site shows the same roles as the studio preview. Change the
 * tenant here and both the storage seeding and the interceptor follow.
 */
export const CAREERS = {
  companyId: ${JSON.stringify(CAREERS.companyId)},
  companyUrl: ${JSON.stringify(CAREERS.companyUrl)},
  domain: ${JSON.stringify(CAREERS.domain)},
  apiEndpoint: ${JSON.stringify(CAREERS.apiEndpoint)},
  /**
   * Sent as the TenantGroupId header when set. The library reads it from
   * \`localStorage.tenantId\`, which nothing seeds; search works without it, so
   * it stays empty until someone confirms the right value for this tenant.
   */
  tenantGroupId: ${JSON.stringify(CAREERS.tenantGroupId)},
} as const;

export function applyCareersConfig(): void {
  sessionStorage.setItem("APIENDPOINT", CAREERS.apiEndpoint);
  sessionStorage.setItem("APIENDPOINTNEW", CAREERS.apiEndpoint);
  sessionStorage.setItem("TENANTAPIURL", CAREERS.apiEndpoint.replace(/\\/+$/, ""));

  sessionStorage.setItem("COMPANYID", CAREERS.companyId);
  sessionStorage.setItem("COMPANYURL", CAREERS.companyUrl);
  sessionStorage.setItem("DOMAIN", CAREERS.domain);
}
`;
}

function emitSiteConfig(blueprint: Blueprint): string {
  const routes = new Map(blueprint.pages.map((page) => [page.id, page.path]));
  const nav = blueprint.nav.map((item) => ({
    label: item.label,
    href: item.pageId ? safeHref(routes.get(item.pageId)) : safeHref(item.href),
  }));

  return `/* Generated from the Site Blueprint v${blueprint.version}. Do not edit — change the site in the studio. */

export interface NavLink {
  label: string;
  /** Empty when the blueprint's navigation item points nowhere yet. */
  href: string;
}

export const site: { name: string; tagline: string; nav: NavLink[] } = {
  name: ${JSON.stringify(blueprint.company.name)},
  tagline: ${JSON.stringify(blueprint.company.tagline)},
  nav: ${JSON.stringify(nav, null, 2).split("\n").join("\n  ")},
};
`;
}

function emitAppModule(blueprint: Blueprint): string {
  const pages = blueprint.pages;
  const imports = pages
    .map(
      (page) =>
        `import { ${componentClassName(page)} } from "./pages/${page.id}/${page.id}.component";`,
    )
    .join("\n");
  const declarations = pages.map((page) => `    ${componentClassName(page)},`).join("\n");

  return `/* Generated from the Site Blueprint v${blueprint.version}. Do not edit — change the site in the studio. */
import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { HTTP_INTERCEPTORS, HttpClientModule } from "@angular/common/http";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { RouterModule } from "@angular/router";
import { ${registry.package.ngModule} } from "${registry.package.name}";

import { AppComponent } from "./app.component";
import { SectionComponent } from "./section.component";
import { CareersTenantInterceptor } from "./careers-tenant.interceptor";
import { routes } from "./app.routes";
${imports}

/**
 * The library's components inject ActivatedRoute and HttpClient, so a router
 * and an HTTP client have to be present for them to construct at all — which
 * is why RouterModule and HttpClientModule are here even for a page that only
 * shows presentation sections.
 *
 * \`${registry.package.ngModule}\` is the approved component library
 * (${registry.package.name}@${registry.package.version}). Everything functional on
 * this site comes from it; nothing here reimplements a job search.
 */
@NgModule({
  declarations: [
    AppComponent,
    SectionComponent,
${declarations}
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    HttpClientModule,
    FormsModule,
    ReactiveFormsModule,
    RouterModule.forRoot(routes),
    ${registry.package.ngModule},
  ],
  providers: [
    // Pins careers-API traffic to this site's tenant; see the interceptor.
    { provide: HTTP_INTERCEPTORS, useClass: CareersTenantInterceptor, multi: true },
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
`;
}

function emitAngularJson(name: string): string {
  return `${JSON.stringify(
    {
      $schema: "./node_modules/@angular/cli/lib/config/schema.json",
      version: 1,
      newProjectRoot: "projects",
      projects: {
        [name]: {
          projectType: "application",
          root: "",
          sourceRoot: "src",
          prefix: "app",
          architect: {
            build: {
              builder: "@angular-devkit/build-angular:browser",
              options: {
                outputPath: "dist",
                index: "src/index.html",
                main: "src/main.ts",
                polyfills: ["zone.js"],
                tsConfig: "tsconfig.app.json",
                assets: [{ glob: "**/*", input: "src/assets", output: "assets" }],
                // The library depends on google-libphonenumber, which is
                // CommonJS. Declaring it keeps the build quiet about an
                // optimization bailout nobody here can act on.
                allowedCommonJsDependencies: ["google-libphonenumber"],
                styles: [
                  "node_modules/bootstrap/dist/css/bootstrap.min.css",
                  "node_modules/@angular/material/prebuilt-themes/indigo-pink.css",
                  "src/styles.scss",
                ],
                scripts: [],
              },
              configurations: {
                production: {
                  // The library pulls in Material, Bootstrap and moment; the CLI's
                  // default 500kB ceiling would fail the build on a site that is
                  // working exactly as intended.
                  budgets: [{ type: "initial", maximumWarning: "4mb", maximumError: "8mb" }],
                  outputHashing: "all",
                  fileReplacements: [
                    {
                      replace: "src/environments/environment.ts",
                      with: "src/environments/environment.prod.ts",
                    },
                  ],
                },
                development: {
                  buildOptimizer: false,
                  optimization: false,
                  vendorChunk: true,
                  extractLicenses: false,
                  sourceMap: true,
                  namedChunks: true,
                },
              },
              defaultConfiguration: "production",
            },
            serve: {
              builder: "@angular-devkit/build-angular:dev-server",
              options: { port: 4200, host: "localhost" },
              configurations: {
                production: { browserTarget: `${name}:build:production` },
                development: { browserTarget: `${name}:build:development` },
              },
              defaultConfiguration: "development",
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG_JSON = `${JSON.stringify(
  {
    compileOnSave: false,
    compilerOptions: {
      baseUrl: "./",
      outDir: "./dist/out-tsc",
      forceConsistentCasingInFileNames: true,
      strict: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: false,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      sourceMap: true,
      declaration: false,
      downlevelIteration: true,
      experimentalDecorators: true,
      moduleResolution: "node",
      importHelpers: true,
      target: "ES2022",
      module: "ES2022",
      useDefineForClassFields: false,
      lib: ["ES2022", "dom"],
      skipLibCheck: true,
    },
    angularCompilerOptions: {
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      // The generated templates bind values out of an untyped content record,
      // which strict template checking has no way to verify.
      strictTemplates: false,
    },
  },
  null,
  2,
)}\n`;

const TSCONFIG_APP_JSON = `${JSON.stringify(
  {
    extends: "./tsconfig.json",
    compilerOptions: { outDir: "./out-tsc/app", types: [] },
    files: ["src/main.ts"],
    include: ["src/**/*.d.ts"],
  },
  null,
  2,
)}\n`;

/**
 * Vercel needs two things said explicitly for an Angular single-page app: where
 * the build output is, and that every route serves index.html. Without the
 * rewrite, a candidate who reloads on /jobslist gets a 404 from the CDN.
 */
const VERCEL_JSON = `${JSON.stringify(
  {
    $schema: "https://openapi.vercel.sh/vercel.json",
    outputDirectory: "dist",
    rewrites: [{ source: "/((?!assets/).*)", destination: "/index.html" }],
  },
  null,
  2,
)}\n`;

/**
 * Why this file exists.
 *
 * The library's peer dependencies do not all agree with each other — the
 * preview host installs with `--legacy-peer-deps` for the same reason — and
 * Vercel runs a plain `npm install`, which would fail the build on a peer
 * conflict npm 6 would have ignored. A committed `.npmrc` is the only way to
 * tell a build platform that before it starts installing.
 */
const NPMRC = `legacy-peer-deps=true
`;

const GITIGNORE = `node_modules
dist
out-tsc
.angular
.DS_Store
*.log
.env*.local
.vercel
`;

function emitReadme(blueprint: Blueprint, library: string[], options: EmitAngularOptions): string {
  const pages = blueprint.pages.map((page) => `| ${page.name} | \`${page.path}\` |`).join("\n");

  return `# ${blueprint.company.name || "Career site"}

Generated from a Site Blueprint by Career Site Studio — version ${blueprint.version}${
    options.studioProjectId ? `, project \`${options.studioProjectId}\`` : ""
  }.

An Angular 15 application, because the careers components are an Angular
library: job search, listings, filters, pagination and the application flow are
the real \`${registry.package.name}\` components, not imitations.

## This code is generated

Every file here except this README is written from \`blueprint.json\`. Change the
site in the studio and publish again; edits made directly in this repository are
overwritten by the next publish.

## Running it

\`\`\`bash
npm install
npm start          # http://localhost:4200
npm run build      # -> dist/
\`\`\`

## The careers tenant

\`${registry.package.name}\` identifies its tenant from the **hostname it is
served from** once that hostname is not \`localhost\`:
\`CommonService.getDomain()\` and \`getCompanyUrl()\` derive both from
\`location.hostname\`, and the values in \`src/app/careers.config.ts\` are only
consulted on localhost. The careers API answers an unrecognised domain with
\`200\` and no data, so left alone this site would render every component
correctly and list no jobs, with nothing on the console to say why.

\`src/app/careers-tenant.interceptor.ts\` prevents that: it rewrites \`domain\`
and \`companyId\` on every careers-API request to the values in
\`careers.config.ts\`. So this site shows the same roles wherever it is
deployed — which is what you want for a preview URL, and what you do not want
if this repository is ever reused for a different company.

Once the site is served from the careers domain itself (in Vercel, Settings ->
Domains), the library derives the same values on its own and the interceptor can
be deleted.

## Pages

| Page | Route |
| --- | --- |
${pages}

## Layout

- \`src/app/pages/\` — one component per blueprint page. The templates bind the
  library's real selectors and inputs.
- \`src/app/section.component.*\` — the presentation sections, ported from the
  studio preview so this site renders what the administrator approved.
- \`src/styles/theme.css\` — the brand's design tokens, the per-container layout
  rules with their mobile breakpoints, and any hand-authored replica CSS.
- \`src/app/careers.config.ts\` — the tenant identity, seeded into
  \`sessionStorage\` before Angular boots and pinned onto every request by
  \`careers-tenant.interceptor.ts\`.
- \`src/assets/images/\` — every image the site uses, copied out of the studio.

## Approved components on this site

${library.length > 0 ? library.map((name) => `- \`${name}\``).join("\n") : "_None — this site is presentation only._"}
`;
}

/* ------------------------------------------------------------------- public */

export function emitAngularApp(
  blueprint: Blueprint,
  options: EmitAngularOptions = {},
): AngularSite {
  const assets = collectStudioAssets(blueprint, ANGULAR_ASSETS);
  // Every renderer downstream of here sees /assets/images/… rather than /api/….
  const site = resolveLinks(rebaseAssets(blueprint, assets));

  const warnings: string[] = [];
  const notes: string[] = [];
  const files: AngularSiteFile[] = [];
  const text = (path: string, content: string) =>
    files.push({ path, content, encoding: "utf-8" as const });

  /* The blueprint's own output: page templates, components, routes, theme. */
  for (const file of emitAngularSite(site)) text(file.path, file.content);

  const name = slug(blueprint.company.name, "career-site");

  text("src/main.ts", MAIN_TS);
  text(
    "src/index.html",
    INDEX_HTML(
      blueprint.company.name ? `Careers at ${blueprint.company.name}` : "Careers",
      blueprint.company.tagline || "",
    ),
  );
  text("src/styles.scss", STYLES_SCSS);
  text("src/environments/environment.ts", ENVIRONMENT_TS);
  text("src/environments/environment.prod.ts", ENVIRONMENT_PROD_TS);
  text("src/app/app.component.ts", APP_COMPONENT_TS);
  text("src/app/app.module.ts", emitAppModule(site));
  text("src/app/careers.config.ts", emitCareersConfig());
  text("src/app/careers-tenant.interceptor.ts", TENANT_INTERCEPTOR_TS);
  text("src/app/site.config.ts", emitSiteConfig(site));
  text("src/app/section.component.ts", SECTION_COMPONENT_TS);
  text("src/app/section.component.html", SECTION_COMPONENT_HTML);
  text("src/app/section.component.scss", SECTION_COMPONENT_SCSS);

  text(
    "package.json",
    `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        scripts: {
          start: "ng serve",
          build: "ng build",
          watch: "ng build --watch --configuration development",
        },
        dependencies: DEPENDENCIES,
        devDependencies: DEV_DEPENDENCIES,
      },
      null,
      2,
    )}\n`,
  );
  text("angular.json", emitAngularJson(name));
  text("tsconfig.json", TSCONFIG_JSON);
  text("tsconfig.app.json", TSCONFIG_APP_JSON);
  text("vercel.json", VERCEL_JSON);
  text(".npmrc", NPMRC);
  text(".gitignore", GITIGNORE);

  const library = usedComponents(site);
  text("README.md", emitReadme(site, library, options));

  /* Images. A reference with no bytes is reported rather than dropped. */
  const missing: string[] = [];
  for (const asset of assets) {
    const bytes = options.images?.get(asset.url);
    if (!bytes) {
      missing.push(asset.url);
      continue;
    }
    files.push({ path: asset.path, content: bytes.base64, encoding: "base64" });
  }

  if (missing.length > 0) {
    warnings.push(
      `${missing.length} image${missing.length === 1 ? "" : "s"} could not be copied out of the studio, so ${
        missing.length === 1 ? "it" : "they"
      } will 404 on the deployed site: ${missing.slice(0, 5).join(", ")}${
        missing.length > 5 ? ", …" : ""
      }`,
    );
  }

  /*
    The warning that matters, and it is unconditional: the library reads its
    tenant from the hostname off localhost, so a deployment on a Vercel URL
    renders perfectly and lists nothing.
  */
  if (library.length > 0) {
    // A note rather than a warning: the interceptor makes the deployed site
    // behave like the preview. What is worth saying is which tenant it is
    // pinned to, and that the pin is deliberate and removable.
    notes.push(
      `Careers requests are pinned to ${CAREERS.domain} (company ${CAREERS.companyId}) by src/app/careers-tenant.interceptor.ts, so the deployed site lists the same roles as the studio preview whatever hostname it is served from. ${registry.package.name} would otherwise derive the tenant from location.hostname and the API answers an unknown domain with 200 and no jobs. Serve the site from the careers domain and the interceptor can be deleted.`,
    );
  } else {
    notes.push(
      "This site has no functional careers components, so it would deploy identically as a React build.",
    );
  }

  const pages = site.pages.map((page) => ({
    id: page.id,
    route: page.path,
    file: `src/app/pages/${page.id}/${page.id}.component.html`,
  }));

  if (!site.pages.some((page) => page.path === "/")) {
    warnings.push(
      `No blueprint page has the path "/", so the deployed site's home page is a 404. Give one page the path "/" in the studio.`,
    );
  }

  notes.push(
    `${files.length} files, ${pages.length} route${pages.length === 1 ? "" : "s"}, ${
      assets.length - missing.length
    } image${assets.length - missing.length === 1 ? "" : "s"}, ${library.length} library component${
      library.length === 1 ? "" : "s"
    }.`,
  );

  return { files, warnings, notes, pages, libraryComponents: library, assets };
}
