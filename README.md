# Career Site Studio

An agent that lets a company administrator build and change a career site by
describing it — importing an existing Figma design, or starting from an approved
base site — without going through the development team for every change.

Built to the specification in [`career-site-agent-plan/`](career-site-agent-plan/).

```
npm install
npm run preview:install           # Angular preview host (one time)
cp .env.example .env.local        # add ANTHROPIC_API_KEY

npm run dev                       # studio   → http://localhost:3000
npm run preview                   # preview  → http://localhost:4200
```

No Figma, GitHub or careers-API credentials are needed to try it: every
integration falls back to a demo backend that exercises the real code path.

---

## Two things worth knowing before reading the code

**`zm-careers-lib` is an Angular 15 library, not React.** The plan assumes a
Next.js stack throughout, and the package README's example markup (`<zm-search>`)
is stale — the compiled selector is `<lib-zm-search>`. Rather than pick one
framework and lose something, the Site Blueprint is framework-agnostic and
everything below it is a renderer:

| Renderer | Where | What it is for |
|---|---|---|
| Angular preview host — [`preview-app/`](preview-app/) | live, in an iframe | Renders the blueprint with the **real** `zm-careers-lib` components |
| Angular emitter — [`src/lib/emit/angular.ts`](src/lib/emit/angular.ts) | build output | Page templates and config, same markup, generated ahead of time |
| Angular app emitter — [`src/lib/emit/angular-app/`](src/lib/emit/angular-app/) | published site | A deployable application around those templates, with the library installed |
| React emitter — [`src/lib/emit/react/`](src/lib/emit/react/) | published site | A Next.js site, for a blueprint with no careers components in it |

The first three produce the genuine `<lib-zm-search>`, `<lib-facets>`,
`<lib-jobs-list>` markup with props bound onto the real `@Input` names. The
preview is not a mock-up of the library — it *is* the library, which is why the
published Angular app is a port of the preview rather than a second design.

The React emitter is the exception that proves the constraint: it renders every
presentation section faithfully and cannot render a single careers component,
because those need an Angular injector to exist at all. It marks each one as a
labelled gap and says so on every publish — see [Publishing](#publishing).

**The component registry is generated, not written.**
[`scripts/build-registry.mjs`](scripts/build-registry.mjs) downloads the
published package and extracts every selector, `@Input` and `@Output` from the
compiled `.d.ts` declarations, merging in editorial metadata (friendly names,
capabilities, prop docs) keyed by class name. Re-run it when the library
publishes:

```
npm run registry:build
```

A component that appears in the package with no editorial entry is emitted as
`unreviewed` and the agent will not offer it until a human classifies it. This
is what makes "never claim unsupported functionality" enforceable rather than
aspirational — the agent cannot name a component that is not in the file.

---

## Architecture

```
Figma MCP / REST / demo ─┐
                         ├─→ semantic analysis ─→ Site Plan ─(admin approves)─┐
Base site via GitHub ────┘                                                    │
                                                                              ▼
                          conversational edits ──→ structured operations ──→ Site Blueprint
                                                        │                     │
                                                   validation             ┌───┴────┐
                                                   (registry-backed)      ▼        ▼
                                                                    React preview  Angular emit
                                                                                        │
                                                                              company branch → publish request
                                                                                        │
                                                        React emit ──→ GitHub push ──→ Vercel deployment
                                                                    (deploy agent)
```

The blueprint is the source of truth. The agent never writes a blueprint
wholesale — it emits operations
([`src/lib/blueprint/operations.ts`](src/lib/blueprint/operations.ts)) which are
applied, validated and versioned. That gives change summaries describing what
actually happened rather than what the model said it did, an undo stack, and a
hard ceiling on what a single edit can do.

| Area | Files |
|---|---|
| Blueprint schema, operations, validation | [`src/lib/blueprint/`](src/lib/blueprint/) |
| The site every base project starts as | [`src/lib/blueprint/default-site.ts`](src/lib/blueprint/default-site.ts) |
| Generated component registry | [`src/lib/registry/`](src/lib/registry/) |
| Figma backends and the band summarizer | [`src/lib/providers/figma/`](src/lib/providers/figma/) |
| Base site (GitHub) with write guard rails | [`src/lib/providers/github/`](src/lib/providers/github/) |
| Web research (Tavily) | [`src/lib/providers/research/`](src/lib/providers/research/) |
| Orchestrator, tools, prompt, capabilities | [`src/lib/agent/`](src/lib/agent/) |
| Angular emitter | [`src/lib/emit/angular.ts`](src/lib/emit/angular.ts) |
| React (Next.js) emitter | [`src/lib/emit/react/`](src/lib/emit/react/) |
| Angular emitter (deployable app with the real library) | [`src/lib/emit/angular-app/`](src/lib/emit/angular-app/) |
| Studio images copied into a generated site | [`src/lib/emit/assets.ts`](src/lib/emit/assets.ts) |
| Deploy agent, its tools | [`src/lib/agent/deploy-agent.ts`](src/lib/agent/deploy-agent.ts), [`src/lib/agent/deploy-tools.ts`](src/lib/agent/deploy-tools.ts) |
| GitHub destination (REST + MCP), Vercel | [`src/lib/providers/github/deploy.ts`](src/lib/providers/github/deploy.ts), [`src/lib/providers/vercel/`](src/lib/providers/vercel/) |
| Shared GitHub MCP session, base site over MCP | [`src/lib/providers/github/mcp-session.ts`](src/lib/providers/github/mcp-session.ts), [`src/lib/providers/github/base-mcp.ts`](src/lib/providers/github/base-mcp.ts) |
| Borrowed MCP OAuth credentials (Figma + GitHub) | [`src/lib/providers/mcp-oauth.ts`](src/lib/providers/mcp-oauth.ts) |
| Screens | [`src/app/projects/new/`](src/app/projects/new/), [`src/app/plan/`](src/app/plan/), [`src/app/studio/`](src/app/studio/) |

---

## The Figma import

This is the path built out most deeply. Six stages, in
[`src/lib/providers/figma/`](src/lib/providers/figma/),
[`src/lib/agent/analyze.ts`](src/lib/agent/analyze.ts) and
[`src/lib/fidelity/`](src/lib/fidelity/):

1. **Fetch** through one of three interchangeable backends (below), normalizing
   to a single `DesignDocument` shape.
2. **Flatten** each frame into ordered *bands* — one per top-level child —
   carrying the text inside, the height, the background, and structural counts:
   text nodes, images, input-shaped rectangles, button instances, and repeated
   sibling subtrees. Geometry is thrown away. This is also the cost and privacy
   boundary: it is the only thing about the design that leaves the process.
3. **Read semantically.** One structured-output call maps each band to either an
   approved component or a static section, with a rationale and a confidence.
   Layer names in real files are meaningless (`Frame 12`, `Group 47`), so the
   demo fixture is deliberately named that way too — the analysis has to work
   from the text and the structure, not from labels containing the answer.
4. **Repair against the registry, and dress the static sections.** A band
   mapped to a component that does not exist is dropped, not passed through.
   Props the component does not declare are stripped. Ids are made unique. Then
   the design's own images are attached to the sections their bands became —
   see below.

   One repair is worth naming because it is a contradiction between two
   otherwise-correct rules. The catalog offers `custom-html` to the analysis,
   but a replica's markup belongs to `set_custom_html`, where the sanitizer
   runs — so the analysis emits the section with no markup, and an empty
   `custom-html` section is a *validation error*. Left alone, an import that
   read any band as bespoke produced a plan that could never be approved. Such
   a band now becomes a text block carrying the design's copy, with a note
   saying it is a replica candidate; markup that does arrive is put through the
   sanitizer here, since the validator requires stored markup to already equal
   its sanitized form.
5. **Approve.** The plan screen shows every section, why it was read that way and
   how confident the model was. Nothing is built until an administrator approves.
6. **Design fidelity review.** The built site is compared back against the design
   it came from, and the project stays closed until a human signs the comparison
   off. Below.

### Where the images come from

Approved components bring their own imagery. Everything else — hero, culture,
media, employee stories, teams, locations, logo wall — has an image slot, and
until it is filled the generated site has a hole in it.

The importer fills it. Images are fetched **band by band** rather than per
frame, which is the detail that makes this work: Figma's asset tool reports the
images found anywhere in a node's subtree, so asking about a frame returns every
picture on the page with no way to tell them apart, while asking about a band
returns that band's images. A section records the band it came from
(`origin.ref`), so the two join directly, in `repairPlan`:

- one image per section, or one per item for the list-shaped types;
- at most four files per band, so a footer whose social icons are eight
  separate files cannot spend the whole import's budget before the hero, the
  logo wall and the culture band have been looked at;
- `logo-wall` prefers the SVGs, everything else the photographs;
- an image already chosen by the model or an admin is never overwritten;
- the frame render is reference for the fidelity review and is never content.

**Alt text is deliberately left empty.** What is known is the file and the band
it came from; what it depicts is not, and an invented description is a wrong
claim where an empty alt is merely a decorative one. Every section filled this
way is named in the import notes on the plan screen, so the alt text gets
written — by the agent, which can now look at the image, or by the admin.
Leftover images, unfilled slots and images no section claimed are all reported
the same way rather than silently dropped: they stay in the asset library.

`scripts/smoke.mjs` covers this end to end without a model call.

### Replicating what is not a component

Functional bands are approved components and are never hand-written. Everything
else — a bespoke hero, a stats strip, an editorial block, an unusual footer —
is a `custom-html` replica, and the point of a replica is that it matches the
design. Three tools in
[`src/lib/agent/design-tools.ts`](src/lib/agent/design-tools.ts) feed it, and
the order matters:

| Tool | What it gives the agent |
|---|---|
| `render_design_node` | **The band, as a picture.** Renders that exact node through the MCP screenshot tool, capped at 1200px so it is worth looking at, and stores it — so asking twice is free, and `describe_design_node` shows the same image afterwards. |
| `describe_design_node` | The exact numbers: box sizes and offsets, fills, type, radii, the real copy, the design's own images for that band — and the picture alongside them. |
| `get_design_reference` | Figma's own markup for the node, via `get_design_context`, requested as `html,css` rather than the React default because a `custom-html` replica is what gets written. Reference only: it knows nothing about this project's components, tokens or sanitizer. |

Before this, the agent authored replicas from a coordinate dump and never saw
the design at all — which is the reliable way to produce a band that is the
right size and the wrong shape. Tool results can carry image blocks, so now it
looks first. SVGs and anything over 3.5MB are not offered as pictures (the API
takes neither), which is the other reason a band-sized render beats a
full-page one.

### Design fidelity review

An approved plan no longer opens the studio. `approve_plan` builds version 1 and
leaves the project in `reviewing`; the review screen shows the design beside what
was built, band by band, and the administrator's approval is what moves it to
`ready`. Projects started from the base site skip the stage entirely — there is
no design to compare them against, and a gate they could never pass would simply
lock them out.

The comparison joins on `origin.ref`, the Figma node id each imported section
already carries, so band → section is exact rather than re-inferred. It reports
three things:

| Axis | How it is judged |
|---|---|
| Coverage and order | Exact. A band with no section (`missing`) or a section with no band (`extra`) is blocking. |
| Design tokens | Exact. Colours, fonts and radius are either what the design specified or they are not. |
| Visual similarity | Evidence only. A 32×32 downsample of the design frame against a screenshot of the built section, reported as a score, never as a verdict. |

**Why a human approves it and not a threshold.** A pixel gate here would fail
every import forever. Two facts make that unavoidable, and both are deliberate.
The importer throws geometry away —
[`summarize.ts` line 10](src/lib/providers/figma/summarize.ts) flattens each
frame into bands and keeps text, height and structural counts, nothing about
where anything sat. And the preview renders the *real* approved
`zm-careers-lib` components: `<lib-facets>` has its own markup, spacing and type,
and cannot be made pixel-identical to a rectangle a designer drew — that
substitution is the entire point of importing into an approved library rather
than exporting the design as code. So a score of 0.6 on a section where an
approved component replaced a bespoke block is the expected outcome, not a
defect. The exact axes are checked mechanically because they *can* be; the
visual axis is put in front of somebody who can tell an acceptable substitution
from a wrong one.

The report is always produced, even when nothing could be captured — a missing
Chrome or a preview host that is not running lands in `capture.unavailable` as a
sentence an administrator can act on, and the review still opens. Being unable
to take a screenshot must never be able to strand a project.

The agent can run and re-run the comparison (`review_fidelity`) and read the
last one (`get_fidelity_report`), and is expected to propose fixes for whatever
is missing or extra. It has no tool that approves anything. That is not an
oversight — an approval the agent can grant itself is not an approval.

### Figma backends

| `FIGMA_PROVIDER` | `FIGMA_MCP_URL` | Needs | Notes |
|---|---|---|---|
| `mcp` | `http://127.0.0.1:3845/mcp` (default) | Figma desktop app, Dev Mode MCP server enabled | Richest — reads the designer's own variables and component names. Unauthenticated. |
| `mcp` | `https://mcp.figma.com/mcp` | An OAuth bearer token | Same richness with no desktop app, so this is the MCP option that works headless. See below. |
| `rest` | — | `FIGMA_TOKEN` | Works headless and in CI. Derives the palette and type ramp from actual usage rather than published styles, which are often absent. |
| `mock` (default) | — | nothing | A plausible careers design. Runs the entire flow, analysis included. |

Either MCP server discovers the tool list at connect time and matches by
intent, because Figma has renamed these tools across releases.

#### Authenticating the hosted MCP server

The hosted server is OAuth-only, and the studio cannot get a token by itself:

- A `figd_` personal access token does not work. The server replies
  `figd_ tokens must be passed via X-Figma-Token header, not Authorization`
  and then rejects that header too — a valid, fully-scoped PAT still 401s.
- Dynamic client registration is advertised at
  `https://api.figma.com/v1/oauth/mcp/register` but returns 403 to the public,
  so the studio cannot register an OAuth client and run its own login.

So the token has to come from an interactive login done once, elsewhere. Run
`claude`, connect the `figma` server with `/mcp`, and approve it in the
browser. Claude Code caches the result — access token, refresh token, and the
client credentials it registered with — in `~/.claude/.credentials.json`, and
[`mcp-auth.ts`](src/lib/providers/figma/mcp-auth.ts) reads it from there.

Refreshes are written back to that same file rather than kept private, because
the refresh token rotates on use: a rotation the studio kept to itself would
log Claude Code out of Figma. Set `FIGMA_MCP_TOKEN` to bypass the cache and
supply a token directly, or `CLAUDE_CREDENTIALS_PATH` if the cache is not in
the default place.

A browser is needed for that one login, but nothing after it — which is the
difference that matters, since the blocker on a headless box is the desktop
app, not the browser.

The hosted server also identifies designs differently, which changes what you
paste into the import box. It takes a **file key** as a required argument
rather than reading whatever file is open, so the URL must be a `/design/` one
(`/board/` FigJam and `/slides/` are not supported). A plain file URL works —
the import lists the document's pages and walks the first few. A node-specific
URL (**Share -> Copy link** on a frame, which appends `?node-id=…`) is better:
it scopes the import to that frame and is the only form the variables tool
accepts, since it has no page-list mode to fall back on.

To check the whole path without needing a file key or a design:

```
npm run figma:check                                        # hosted server
FIGMA_MCP_URL=http://127.0.0.1:3845/mcp npm run figma:check  # desktop server
```

It reports where the token came from and whether the server accepted it, and
resolves the three tool intents against the live tool list — which is the part
that silently breaks when Figma renames a tool.

---

## The component catalog

The conversation is good at intent and bad at discovery — nobody can ask for a
capability they do not know exists, and reading thirty options back over chat is
a poor way to browse. So **+ Add** in the structure panel opens a searchable,
grouped catalog of everything that can go on a page: 13 approved library
capabilities under *Finding jobs*, *Applying* and *Guided discovery*, and 16
content sections under *Introducing the company*, *People and culture* and the
rest.

Each entry shows its friendly name, what it does, and — behind **Options** — the
settings it accepts, described in plain English. Internal component names never
reach the browser; [`/api/components`](src/app/api/components/route.ts) strips
them server-side. Anything approved that no group claims still appears under
*Other capabilities*, so adding a component to the library can never silently
hide it from administrators.

Adding goes through
[`/api/projects/:id/sections`](src/app/api/projects/[projectId]/sections/route.ts),
which builds the same `add_section` operation the agent would and runs the same
validation. The catalog is a different way in, not a way around the rules —
asking for an unapproved or internal component is refused identically.

---

## The live preview

[`preview-app/`](preview-app/) is an Angular 15 host that loads a blueprint from
the studio's API and renders it with the real library components. The studio
embeds it in an iframe.

**Why an iframe.** The preview used to render inline in the studio's right-hand
panel — about 720px wide. `zm-careers-lib` is responsive, and CSS media queries
resolve against the *viewport*, not the containing element, so every "desktop"
preview came out in the mobile layout. No choice of preset could fix that while
the preview shared the studio's viewport. An iframe has a viewport of its own,
so the frame is sized to the true device width and scaled down with a CSS
transform to fit the panel. Measured from inside the running studio:

| | |
|---|---|
| Studio preview panel | 721px |
| Preview frame `innerWidth` | **1280px** |
| `matchMedia('(max-width: 720px)')` | **false** |
| Applied scale | 0.563 — visual only, layout is unaffected |

**Configuring the library.** `zm-careers-lib` is configured through browser
storage rather than Angular DI, and reads it during service construction — so
[`preview-config.ts`](preview-app/src/app/preview-config.ts) seeds it *before*
bootstrap:

| Key | Where | Meaning |
|---|---|---|
| `APIENDPOINTNEW` | sessionStorage | API host |
| `TENANTAPIURL` | sessionStorage | Tenant lookup host |
| `COMPANYID` | sessionStorage | Base64 company id (`window.atob`) |
| `DOMAIN`, `COMPANYURL` | sessionStorage | Read only when the host is `localhost` |
| `tenantId` | localStorage | Sent as the `TenantGroupId` header |

That localhost special case is why the preview must be served from `localhost`
and not `127.0.0.1` — the library compares the hostname literally.

### The data connector

A three-way switch in the preview toolbar. **All three run the same components
down the same code path**; only the rows differ, which is what makes the sample
modes a fair preview rather than a picture of one.

| Mode | Needs | What it shows |
|---|---|---|
| **Sample data** | nothing | Built-in fixtures — generic engineering, design and sales roles. |
| **Researched data** | nothing | Roles the agent researched for *this* company. |
| **Live careers API** | the tenant identity in [`preview-config.ts`](preview-app/src/app/preview-config.ts) | Real jobs, straight from the careers API. |

The middle mode exists because generic sample jobs make every demo look like the
same company. Ask the assistant — *"we're a UK hospital group, load realistic
roles"* — and it researches, then calls `set_job_data`. Facets are always
derived from whichever roles are loaded, so filtering keeps working on a dataset
nobody wrote by hand:

```
Sample     Department: Engineering [4] · Design [3] · Data [2]
Researched Department: Nursing [5] · Allied Health Professionals [3] · Pharmacy [2]
```

The agent gathers facts — titles, departments, the cities a company hires in —
with the research tools below, and writes every summary fresh. Job descriptions
are somebody's copyright and are never reproduced.

Both sample modes are served by an
[HTTP interceptor](preview-app/src/app/mock/mock-api.interceptor.ts). The
fixture *shape* was taken from a live response so the components parse it
exactly as they parse production data.

Getting the fixture shape exactly right mattered more than expected. Three
real mismatches, each of which broke rendering: `facetedSearchConfig.range` is
read unguarded (omitting it throws on every change-detection pass), `facets` is
keyed by *display* name and mapped back through `facetsMapping`, and `skillSet`
and `locAgg` are comma-separated **strings** while the neighbouring `*List`
fields are real arrays.

---

## The default career site

A base project does not start empty. `POST /api/projects` writes version 1 from
[`defaultCareerSite`](src/lib/blueprint/default-site.ts) before anyone says
anything, so the studio opens on a complete, routable site and the conversation
starts at "change this" rather than "build me something". The agent then adjusts
it; `start_from_base` seeds from the same function, so both paths converge.

```
/                header · hero (CTA → /jobs) · testimonials · footer
/jobs            header · [ filters (300px) | search · chips · listing · pagination ] · footer
/jobs/:jobUrl    header · job details · footer
```

Everything in it is ordinary blueprint — sections, props, content, layout
containers — so every part can be changed by the same operations that change any
other site. Nothing about it is special-cased.

**The job routes are a contract, not a preference.** Reading the library's own
source settles all three:

| | What it does |
|---|---|
| `lib-jobs-list` | emits `(jobURL)` as `"<slug>?id=<n>"` and **navigates nowhere** |
| `lib-job-view` | reads the job id from `queryParams['id']` |
| `lib-job-apply` | reads `route.snapshot.paramMap.get('jobUrl')` |

So the detail page is `/jobs/:jobUrl` with the id in the query, and the Angular
emitter binds that output to an `openJob` handler on the page component —
without it, clicking a job card does nothing at all, because the library is
waiting for the host to route. Renaming the parameter to `:id` would break the
apply flow silently, since the library looks it up by name.

The testimonials are written placeholders with branded placeholder portraits,
not scraped quotes: somebody else's words about somebody else's employer are
their copyright and would be a lie on this site. They are complete enough to
judge the layout and obviously meant to be replaced.

**One bug this surfaced in the preview host too.** Bootstrap is loaded globally
because the library depends on it, and it claims `.nav`, `.row` and `.card` for
itself. Specificity does not settle that — the section styles are more specific,
but only for properties they actually declare, and `display` was not one of
them. Bootstrap's `.nav { display: flex }` turned the header into a flex
container whose inner wrapper shrink-wrapped and centred, so the logo could not
sit on the left however the header was written. Both stylesheets now re-declare
what Bootstrap would otherwise decide.

---

## Start from base

Implemented as a full agent capability — provider, tools, guard rails and the
studio flow — against a stand-in repository, because **the approved base repo
link has not been supplied yet**. Point it at the real one and the REST backend
takes over with no other change:

```
BASE_SITE_REPO=owner/career-site-base
GITHUB_TOKEN=ghp_…
```

Until then `/api/capabilities` reports the capability as `demo` and the start
screen says so, rather than offering a button that fails on click.

The write guard rails live in the provider, not in the prompt
([`src/lib/providers/github/types.ts`](src/lib/providers/github/types.ts)):
`main`, `master`, `production` and `release` are refused outright, and commits
are restricted to an allow-list of configuration paths. A conversational request
cannot escalate into rewriting the application. Both backends apply them —
a guard rail only one backend enforces is not a guard rail.

### Reading it through MCP

`GITHUB_PROVIDER=mcp` moves the whole GitHub integration onto GitHub's MCP
server: the base site is read with `get_file_contents`, branched with
`create_branch` and committed with `push_files`
([`base-mcp.ts`](src/lib/providers/github/base-mcp.ts)), and publishing follows
the same variable. Both backends share one connection and one tool-discovery
path ([`mcp-session.ts`](src/lib/providers/github/mcp-session.ts)).

One read has no MCP equivalent: structure discovery needs every path in the
repository, and `get_file_contents` lists a single directory. So the recursive
listing goes through the git data API when `GITHUB_TOKEN` allows it, and
otherwise falls back to a bounded breadth-first walk — which says so when it
stops early, because an incomplete tree makes an incomplete plan.

A detail worth knowing if you extend this: GitHub's MCP server answers a file
read with *two* content blocks — a text block reading "successfully downloaded
text file (SHA: …)" and a resource block holding the file. Reading only the text
blocks gets you the progress note, and reading both prefixes every file with it,
which is enough to stop a `config/site.json` from parsing. `textOf` therefore
treats an attached resource as the answer and the text as commentary.

---

## Publishing

"Request publishing" opens a panel, and the panel does two things: it files the
publish request the governance flow has always filed, and it hands the project
to a **deploy agent** that puts the site on the internet.

```
Site Blueprint v7
      │  emitAngularApp   or   emitReactSite
      ▼
Angular app with zm-careers-lib   |   Next.js app, careers sections gapped
      │  push, one commit         GitHub REST or GitHub MCP
      ▼
github.com/<owner>/<repo>
      │  deploy                   Vercel: from the commit, or from the files
      ▼
https://<project>.vercel.app
```

### Two targets, and why the choice is not a preference

The approved careers components are `zm-careers-lib`, an **Angular 15** library:
its components are declared in an NgModule and constructed by Angular's
injector. No packaging makes them render inside React — installing the library
into a Next.js app would download it and render nothing. So the target is a
consequence of the blueprint, not a taste:

| | **Angular** (default) | **React (Next.js)** |
|---|---|---|
| Careers components | the real ones — search, listings, facets, apply | labelled gaps |
| Chosen when | the site uses any of them | the site is presentation only |
| Emitter | [`emit/angular-app/`](src/lib/emit/angular-app/) | [`emit/react/`](src/lib/emit/react/) |

`recommendedTarget(blueprint)` decides; the publish panel shows both with what
each costs, and the choice is stored on the project.

The Angular target is a port of the preview host, which is the shortest correct
route to a deployable site: `preview-app/` is *already* an Angular app running
the real library against the same blueprint. The generated app installs
`zm-careers-lib` from npm, imports `ZmCareerSitesLibModule`, and binds the
library's genuine selectors and `@Input()` names from
[`emit/angular.ts`](src/lib/emit/angular.ts). Verified end to end: a generated
site builds, and its job list renders live roles from the careers API.

### The tenant, and why a deployed site would otherwise list nothing

`zm-careers-lib` takes its tenant from browser storage — `APIENDPOINTNEW`,
`COMPANYID`, `COMPANYURL`, `DOMAIN`, read in service *constructors*, which is
why `main.ts` seeds them before `bootstrapModule`. Except for two of them, on
any real hostname:

```js
getDomain() {
  if (window.location.hostname == "localhost") return sessionStorage.getItem("DOMAIN") || "";
  return window.location.hostname;   // ← on any real deployment
}
```

The careers API answers an unrecognised domain with **`200` and no jobs** —
measured against the real API, not inferred. So left alone, a site on a
`*.vercel.app` hostname renders every component perfectly and lists nothing,
with nothing on the console to explain it.

The generated app therefore ships
[`careers-tenant.interceptor.ts`](src/lib/emit/angular-app/runtime.ts), which
rewrites `domain` and `companyId` onto every careers-API request. The library
offers no hook for this, but every request goes through Angular's `HttpClient`,
so an interceptor can put the tenant back on the way out. Verified by serving a
generated site from `127.0.0.1` — the library's non-localhost path — where it
*would* have sent `domain=127.0.0.1`: what went out was the configured domain,
the API answered `200`, and ten real job cards rendered.

The pin is deliberate and removable. While it is there the site asks about one
tenant wherever it is deployed, which is right for a preview URL and wrong if
the repository is ever reused for another company; once the site is served from
the careers domain itself, the library derives the same values and the
interceptor can be deleted. Publishing reports which tenant it pinned.

Three smaller things the same investigation turned up:

- a committed `.npmrc` with `legacy-peer-deps=true`, because Vercel runs a bare
  `npm install` and this dependency tree needs it;
- `allowedCommonJsDependencies` for `google-libphonenumber`, which the library
  pulls in;
- `TenantGroupId` comes from `localStorage.tenantId`, which nothing seeds —
  `returnTenantHeader()` sends the header only when it is set. Search works
  without it, so `careers.config.ts` leaves `tenantGroupId` empty rather than
  guessing: a wrong group id is worse than no header.

One thing that is **not** a bug, in case it costs somebody an afternoon: the
careers API sits behind a WAF that rejects requests with a `HeadlessChrome`
user agent. A headless test browser gets `403 Access Denied` from the edge —
an HTML page, not the API — while a normal browser on the same page gets `200`.
Set a normal user agent before concluding anything about the tenant.

### Why the site is generated, not hand-written

`emitReactSite` is a **port of the preview host**, element for element and class
for class — `components/sections/*` in the generated repository are the same
markup as `preview-app/src/app/static-section.component.ts`, and
`app/globals.css` is its stylesheet plus the brand's design tokens. An
administrator approves what the preview showed them; a generator that quietly
improved on it would ship something nobody signed off.

What arrives is ordinary code: literal JSX with the content inline, one route
per blueprint page, no runtime interpreter over `blueprint.json`. Both entry
points come from an Angular world, so a blueprint writes its parameters
Angular's way — the base site's own router has `jobview/:jobUrl` — and the
emitter translates `:id` to Next's `[id]` rather than rejecting the page. The
blueprint travels along for provenance. Anyone can read the repository and change it —
and the README in it says plainly that the next publish overwrites what they
changed, because the blueprint is still the site.

### What the React target cannot carry

`zm-careers-lib` is an **Angular 15** library, so job search, job listings,
filters, pagination, the application form and resume upload cannot render in a
React site. They emit as `PendingIntegration`: a labelled gap that carries the
settings chosen in the studio, plus a `components/library/README.md` naming
every one of them and the three ways to close the gap.

Nothing imitates them. A search box that does not search, or a list of invented
roles, is worse in front of a real candidate than an obvious gap — which is the
same rule the component registry exists to enforce. The publish panel puts this
above the button, the deployment record keeps it, and the agent is instructed to
volunteer it rather than wait to be asked.

### Where it goes

The destination is **never inferred**. An administrator types it into the panel
(or names it in the conversation, which reaches the same place through
`hand_off_to_deploy`), and it is stored on the project so a republish does not
ask again. Three rails are in the provider rather than the prompt
([`src/lib/providers/github/deploy.ts`](src/lib/providers/github/deploy.ts)):

- the approved base repository is refused as a destination, whatever anyone
  types — comparing owner and name, so neither a URL nor a `.git` suffix nor a
  change of case gets a generated site pushed over the thing every project
  starts from;
- a repository holding files the studio did not generate is refused until the
  administrator has explicitly agreed to publish over it;
- a push is one commit whose tree matches the generated site under `app/`,
  `components/`, `lib/` and `public/images/`, and leaves everything else alone.
  A page deleted in the studio stops being live; a LICENSE somebody added
  survives.

### When a publish cannot proceed

Nothing in the panel is disabled except the Publish button while a publish is
running. A disabled button with no explanation reads as a broken feature, and
the one thing it used to guard — an empty repository field — is better said in
a sentence. A blueprint with blocking validation issues publishes too, on the
administrator's say-so, and the deploy agent reports what it could and could
not generate rather than the studio refusing on their behalf.

What *does* stop a publish is a credential that cannot write, and that one is
worth catching early:

```
POST /repos/<owner>/<repo>/git/blobs → 403
x-accepted-github-permissions: contents=write
```

A repository's `permissions` field reports the **user's** role, not the
token's grants — a fine-grained token whose owner is an admin reports
`push: true` and then fails every write. Nothing reveals the truth until
something writes. So `checkWriteAccess` establishes it by writing: it creates
one blob and throws it away. A blob no tree references is unreachable and
pruned, so a pass leaves nothing behind, and a failure comes back carrying
GitHub's own `x-accepted-github-permissions` header and the steps to fix it.

It runs in two places. The publish panel checks the destination as soon as the
repository is typed, so the field says `✓ Ready — empty, and the token can
write to it` or names the missing permission before anything is generated. And
`inspect_repository` runs it before the agent generates a site, because a
credential problem is not one that retrying, patching or regenerating can
change — the agent is instructed to stop and relay the remedy verbatim.

### Two GitHub backends

```
GITHUB_PROVIDER=mcp            # both halves: read the base site, push the build
GITHUB_PROVIDER=rest           # the GitHub API with GITHUB_TOKEN
GITHUB_PROVIDER=mock           # stand-in base repo; generate and check, push nothing

GITHUB_DEPLOY_PROVIDER=        # set only to make publishing differ from the above
```

`GITHUB_DEPLOY_PROVIDER` falls back to `GITHUB_PROVIDER`, then to whatever is
configured, then to the stand-in — so one variable answers "which GitHub backend
is this deployment using". The MCP backend exists because an administrator's idea of "my GitHub
access" is increasingly the MCP server they already connected. It discovers
tools by intent rather than by name and shapes arguments from each tool's own
advertised schema, like the Figma MCP backend it borrows from.

It is a hybrid, and the seams are reported rather than hidden. GitHub's server
(44 tools at the time of writing) covers most of a publish — `push_files` writes
the whole site in one commit, `create_repository`, `create_branch` and
`delete_file` do the rest — but two things it genuinely cannot do:

- **images.** Its file tools document their `content` as "Do not base64-encode
  it; this server does that before calling the REST API", so there is no way to
  hand one a binary. Images go through the git data API in a second commit.
- **listing a tree.** Working out which generated files a republish should
  remove needs a recursive tree, which no MCP tool provides, so that read goes
  through REST as well.

Both need a personal access token, which is why the MCP backend still wants one
even though its bearer may be an OAuth credential. And because `delete_file` is
one path per call and one commit per call, deletions are capped per publish; past
the cap the publish says what it left and names the REST backend, which removes
everything in the same commit as the push.

### Authenticating the MCP backend

`GITHUB_MCP_TOKEN`, falling back to `GITHUB_TOKEN`. The studio can also borrow
the OAuth token Claude Code cached for a `github` MCP server — the mechanism is
shared with Figma in
[`src/lib/providers/mcp-oauth.ts`](src/lib/providers/mcp-oauth.ts), which reads
`~/.claude/.credentials.json`, refreshes an expired token against the
authorization server named in the cached discovery state, and writes the
rotation back so the studio and Claude Code keep sharing one credential.

That path is implemented but needs an OAuth app you registered: GitHub's
authorization server rejects dynamic client registration, so `claude mcp add
--transport http github https://api.githubcopilot.com/mcp/` followed by `/mcp`
cannot complete the flow on its own — it reports *"Incompatible auth server:
does not support dynamic client registration"*. Pass `--client-id` if you have
one; otherwise a token is the shorter road.

### Vercel, with and without a token

With `VERCEL_TOKEN`, the studio finds or creates the project, links it to the
repository where Vercel's GitHub app allows it, deploys, waits for the build,
and reads the build log if it fails. A failed build the agent can attribute to a
generated file it may patch and re-push — twice, then it stops and quotes the
log.

Without a token nothing is faked: the code is pushed, and the report says to
import the repository once at vercel.com/new, after which Vercel builds every
push on its own. A project Vercel would not link deploys by direct file upload
instead, and the deployment record says that later pushes will not deploy
themselves.

### Why a second agent

The studio agent's world is the blueprint, and every rail it has is about not
claiming capability the library does not have. Publishing fails differently — a
repository that already holds something, an unlinked Vercel project, a build
that breaks on one file — and recovering needs judgement about a build log, not
about a career site. Folding that into the studio agent would put tools that can
overwrite a repository in scope for every "make the hero bigger" turn. So the
handoff is explicit, and what is handed over is the blueprint: the same thing
the preview renders.

The deployment record is written by code from the workspace, not by a tool the
model chooses to call, so it cannot say `succeeded` because the model believed
it had. The model's contribution is the prose summary, stored as prose.

---

## Agent capabilities

`GET /api/capabilities` reports each one as `ready`, `demo` or `needs-config`.
The same manifest goes into the system prompt, so the agent knows which of its
own tools will work and can say what is missing instead of failing opaquely.

`IMPORT_FIGMA` · `START_FROM_BASE` · `DESIGN_FIDELITY` · `MODIFY_SITE` ·
`ADD_FUNCTIONALITY` · `MANAGE_IMAGERY` · `RESEARCH_OR_INSPIRATION` ·
`VERSION_AND_PREVIEW` · `REQUEST_PUBLISH` · `DEPLOY_SITE`

### Research

The agent has one route to the open web, and which one depends on what is
configured:

| `TAVILY_API_KEY` | Tools | What comes back |
|---|---|---|
| set | `research_web`, `read_web_page` | Ranked results and full page text, **inside this process**. A researched dataset can name the careers page it came from, and an administrator can open it. |
| unset | `web_search` | Anthropic's server-side search. It informs the answer inside the model's turn; the page text never reaches the studio, so researched roles rest on recollection rather than on a citable source. |

Never both at once — two search tools with overlapping descriptions make the
model deliberate about which to call instead of calling one. `ENABLE_RESEARCH=false`
removes both and takes the studio entirely off the web; `/api/capabilities` then
reports the capability as `needs-config` instead of quietly doing nothing.

Tavily is a search API built to be read by a model rather than by a person: it
returns the passage that answers the query next to the URL it came from, which
is what makes a researched preview checkable. `read_web_page` exists because a
search snippet is three sentences and a jobs board is a hundred rows — reading
the careers page is what actually produces the list of open roles.

What may be gathered is factual: role titles, departments, cities, employment
type, the shape of a hiring plan. Prose is not, and the rule is stated in the
tool descriptions the model reads rather than only in the prompt. Job
descriptions and careers-page copy are somebody's copyright; everything the site
shows is written fresh from the facts.

Inspiration works the same way and is engaged only on explicit request — "take
inspiration from Rakuten's careers site" summarises structural patterns and
produces an original plan; it never reproduces copy or markup.

### Imagery

The agent cannot browse the web for a photograph, and an invented CDN URL is a
link that 404s. So image URLs may only come from four sanctioned sources, and
`set_section_image` **refuses** anything else rather than writing a guess into
the blueprint:

| Source | Needs | Notes |
|---|---|---|
| The imported design | the Figma MCP backend | The design's own photographs and logos, pulled out by `download_assets` at import and copied into the asset store. The best imagery there is: the real marks and the real people. Figma records only the frame each one was found in, not the layer, so the agent matches them by shape and position and falls back to a placeholder when it cannot tell. |
| Company uploads | nothing | `POST /api/projects/:id/assets`. Content-addressed, served back by the studio. Preferred over stock — a real photo of the real team beats stock. |
| Stock photography | `UNSPLASH_ACCESS_KEY` or `PEXELS_API_KEY` | CDN URLs referenced, never copied. Attribution comes back with each result and is carried into the blueprint, because both licences require it on display. |
| Branded placeholder | nothing | `/api/placeholder` renders an SVG in the site's own colours, labelled with what belongs there. |

Placeholders exist so a page missing its photography looks deliberately
unfinished rather than broken — and so the agent always has an honest URL and
never has to leave a hero empty. Alt text is mandatory on every image.

Uploads accept JPEG, PNG, WebP, AVIF, GIF and SVG up to 8MB. SVG is
script-capable, so both the placeholder and asset routes serve under a
restrictive CSP with `nosniff` and a sandbox — a hostile SVG renders as a
picture and nothing else. Filenames are validated against a content-hash
pattern and the resolved path is confirmed to be inside the project, so a `..`
in the URL cannot read anything off disk.

---

## Verifying it

```
npm run smoke     # everything either side of the model call
npm run seed      # plus: leave a built demo project in the store
npm run typecheck
npm run build
```

`npm run smoke` covers the registry extraction, the Figma mock backend, the band
summarizer, plan → blueprint, the guard rails (inventing a component, setting an
unsupported prop, a static section claiming to be functional), a three-operation
conversational edit, the Angular emit, and everything publishing added: the
React emit (a complete Next.js app, careers components emitted as labelled gaps
and *reported* as such, no studio-hosted URLs surviving), the Angular emit (a
complete workspace, the library as a real dependency, its NgModule imported,
the tenant seeded before bootstrap and pinned by the interceptor), and the
deploy guard rails (the base repo refused as a destination, generated paths
recognised, hand-written files left alone). `npm run seed` additionally writes a
finished demo site into the store so the studio and preview can be clicked
through with no API key.

**What is verified and what is not.** Everything above runs green. Exercised
against a running server: project creation, the studio, the emit endpoint, error
handling, base-site discovery against the real Angular base repo, and a full
agent turn — a two-part request ("move employee stories below benefits, and add
resume upload to the jobs page") that read the blueprint, checked the component
spec, applied both edits, saved a version, and flagged an unrelated problem it
noticed in the existing structure.

**The default site was verified by clicking through it.** Generated as Angular,
built, served, and driven with a real browser: home loads; the header nav and
the hero CTA both route to `/jobs`; the facets, search and listing render as the
real components and return ten live roles; searching "java" returns results;
clicking a card opens
`/jobs/java-application-developer-…?id=253847`; a refresh on that route works;
back and forward navigate; the filter column stacks at 390px; every image
resolves. 18 of 19 checks pass — the exception is below.

The preview was verified in a real browser: the jobs page renders
`lib-zm-search`, `lib-facets`, `lib-jobs-list`, ten `lib-job` cards and
`lib-pagination`, with the filter rail showing Department, Location, Employment
Type and the experience range, and a clean console.

**Publishing was verified by building and running what it generates**, which is
the only check that means anything for a code generator. Four generated Next.js
sites compile with `next build` — including one exercising all nineteen section
components, nested row and grid containers with a 300px sidebar, replicas and
copied images. A generated Angular site installs `zm-careers-lib@2.8.3` from
npm, builds (2.76 MB), and serves: `lib-zm-search`, `lib-facets`,
`lib-filter-chips`, `lib-jobs-list`, `lib-job` and `lib-pagination` all render,
the careers API answers `200`, and ten real roles appear with working Experience
and Location facets. Served from `127.0.0.1`, the interceptor pins the tenant
and the same ten roles appear. A plain `npm install` succeeds with the emitted
`.npmrc`.

The publish path itself was exercised end to end against a stand-in GitHub
backend: the agent generated, inspected, "pushed", and reported *"Nothing was
published — this run was a dry run"* rather than claiming success from a mock.
The write preflight was verified against a real repository, where it returns
GitHub's own `contents=write` requirement.

The catalog and the data connector were verified against the running studio: the
catalog serves 29 grouped items with no internal names leaked, adding a section
suffixes a colliding id and refuses unapproved and internal components, and
switching the connector to *Researched* swaps both the job rows and the facet
values (`Engineering [4]` → `Nursing [5]`) with correct counts.

Imagery was verified end to end. Asked to fill two blank slots, the agent
checked its sources, found no uploads and no stock provider, generated branded
placeholders, set them with written alt text, and told the administrator plainly
that they were placeholders that should not be published. The images then
rendered in the preview at the correct cross-origin URLs. The guards were tested
directly: a non-image upload is rejected, `..` in an asset path 404s, and a
`javascript:` colour or a `<script>` label in the placeholder URL is discarded
or escaped.

The GitHub MCP backend was verified against GitHub's hosted server: it connects,
sees 44 tools, reads the base repository (48 files, framework detected, 7 routes
parsed out of the routing module), and refuses a protected branch and an
unwritable path exactly as the REST backend does.

**A known failure, and it is not in this code.** On the job details route the
library's own call to `jobs-service/v1/jobs/careersite` returns `400 Bad
Request` for this tenant, so `lib-job-view` renders and honestly says "No data
found". Every payload variant was tried by hand — with and without the
`TenantGroupId` header, with `domain` added, with the id as a number — and all
of them are rejected, so it is an API or tenant condition rather than anything
the studio generates. Everything upstream of it works: the search returns
roles, the card click routes correctly, and the id arrives in the query where
the component reads it.

**Not verified:** the live Figma Dev Mode MCP connection, and a complete publish
to a real repository. The Figma MCP client is written against Figma's tool
surface and is defensive about tool names and payload shapes, but has never run
against a live server — the REST backend covers the same ground headless. A real
publish has reached the push and stopped there on a token missing
`contents=write`; everything before it (generate, inspect, preflight) and the
Vercel credentials (`/v2/user`, project listing) are confirmed, but no site has
yet been pushed and deployed by the studio end to end.

The preview's **live** data mode is confirmed at the API level — the tenant
handshake and job search answer correctly, and the generated Angular app renders
real roles from them — though the preview host itself has only been run in
sample mode.

---

## Governance

Enforced in code, not in the prompt:

- Deploying is separate from editing, and separate from asking to publish.
  `REQUEST_PUBLISH` validates the blueprint and files a request; it deploys
  nothing. `DEPLOY_SITE` publishes, only to a destination an administrator
  supplied, never over the approved base repository, and never over somebody
  else's files without explicit agreement.
- Protected branches are refused by the provider, on both the REST and MCP
  backends — a guard rail only one backend enforces is not a guard rail.
- Commits to the **base** repository are restricted to an allow-list of
  configuration paths. A **destination** repository is generated output the
  studio owns, so that list does not apply there; what applies instead is that
  the destination is never inferred, the base repo can never be one, and a
  push only ever replaces files under the generated directories.
- Validation no longer blocks publishing. It blocks *building a version* as it
  always did, but an administrator may publish a blueprint that does not
  validate, and then the issues travel with the deployment as warnings and the
  agent says what it could not generate. The studio reports; the person
  decides.
- A deployment record is written by code from the run's own state, not by a
  tool the model chooses to call, so it cannot say `succeeded` because the
  model believed it had. The model's contribution is the prose summary, stored
  as prose.
- Functional capability comes only from the approved registry; a request the
  library cannot serve is recorded on the project as unsupported, never built.
- Versions are append-only. Undo replays an old version forward as a new one, so
  history cannot be rewritten and the undo is itself undoable.
- An imported site stays in `reviewing` until a person approves the fidelity
  comparison. The agent has tools to run the check and fix what it finds, and
  none that approve it.
