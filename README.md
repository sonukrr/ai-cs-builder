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
framework and lose something, the Site Blueprint is framework-agnostic and has
two renderers downstream:

| Renderer | Where | What it is for |
|---|---|---|
| Angular preview host — [`preview-app/`](preview-app/) | live, in an iframe | Renders the blueprint with the **real** `zm-careers-lib` components |
| Angular emitter — [`src/lib/emit/angular.ts`](src/lib/emit/angular.ts) | build output | The static site that ships, same markup, generated ahead of time |

Both produce the genuine `<lib-zm-search>`, `<lib-facets>`, `<lib-jobs-list>`
markup with props bound onto the real `@Input` names. The preview is not a
mock-up of the library — it *is* the library.

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
| Generated component registry | [`src/lib/registry/`](src/lib/registry/) |
| Figma backends and the band summarizer | [`src/lib/providers/figma/`](src/lib/providers/figma/) |
| Base site (GitHub) with write guard rails | [`src/lib/providers/github/`](src/lib/providers/github/) |
| Web research (Tavily) | [`src/lib/providers/research/`](src/lib/providers/research/) |
| Orchestrator, tools, prompt, capabilities | [`src/lib/agent/`](src/lib/agent/) |
| Angular emitter | [`src/lib/emit/angular.ts`](src/lib/emit/angular.ts) |
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
4. **Repair against the registry.** A band mapped to a component that does not
   exist is dropped, not passed through. Props the component does not declare
   are stripped. Ids are made unique.
5. **Approve.** The plan screen shows every section, why it was read that way and
   how confident the model was. Nothing is built until an administrator approves.
6. **Design fidelity review.** The built site is compared back against the design
   it came from, and the project stays closed until a human signs the comparison
   off. Below.

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
cannot escalate into rewriting the application.

---

## Agent capabilities

`GET /api/capabilities` reports each one as `ready`, `demo` or `needs-config`.
The same manifest goes into the system prompt, so the agent knows which of its
own tools will work and can say what is missing instead of failing opaquely.

`IMPORT_FIGMA` · `START_FROM_BASE` · `DESIGN_FIDELITY` · `MODIFY_SITE` ·
`ADD_FUNCTIONALITY` · `MANAGE_IMAGERY` · `RESEARCH_OR_INSPIRATION` ·
`VERSION_AND_PREVIEW` · `REQUEST_PUBLISH`

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
link that 404s. So image URLs may only come from three sanctioned sources, and
`set_section_image` **refuses** anything else rather than writing a guess into
the blueprint:

| Source | Needs | Notes |
|---|---|---|
| Company uploads | nothing | `POST /api/projects/:id/assets`. Content-addressed, served back by the studio. Always preferred — a real photo of the real team beats stock. |
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
conversational edit, and the Angular emit. `npm run seed` additionally writes a
finished demo site into the store so the studio and preview can be clicked
through with no API key.

**What is verified and what is not.** Everything above runs green. Exercised
against a running server: project creation, the studio, the emit endpoint, error
handling, base-site discovery against the real Angular base repo, and a full
agent turn — a two-part request ("move employee stories below benefits, and add
resume upload to the jobs page") that read the blueprint, checked the component
spec, applied both edits, saved a version, and flagged an unrelated problem it
noticed in the existing structure.

The preview was verified in a real browser: the jobs page renders
`lib-zm-search`, `lib-facets`, `lib-jobs-list`, ten `lib-job` cards and
`lib-pagination`, with the filter rail showing Department, Location, Employment
Type and the experience range, and a clean console.

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

**Not verified:** the live Figma Dev Mode MCP connection, and the preview's
**live** data mode. The MCP client is written against Figma's tool surface and
is defensive about tool names and payload shapes, but has never run against a
live server — the REST backend covers the same ground headless. For live
preview data, the tenant handshake and job search were confirmed against
`apipreprod1.zwayam.com` with `curl`, but the preview itself has only been run
in sample mode, because no tenant or company id for a preview site was
available.

---

## Governance

Enforced in code, not in the prompt:

- Nothing deploys. `REQUEST_PUBLISH` validates the blueprint and files a request.
- Protected branches are refused by the provider.
- Commits are restricted to an allow-list of configuration paths.
- Functional capability comes only from the approved registry; a request the
  library cannot serve is recorded on the project as unsupported, never built.
- Versions are append-only. Undo replays an old version forward as a new one, so
  history cannot be rewritten and the undo is itself undoable.
- An imported site stays in `reviewing` until a person approves the fidelity
  comparison. The agent has tools to run the check and fix what it finds, and
  none that approve it.
