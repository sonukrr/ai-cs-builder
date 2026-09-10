/**
 * The fixed source of a generated React site.
 *
 * Everything in this file is emitted verbatim into the destination repository:
 * the content helpers, the stylesheet, and one component per section type. It
 * is a deliberate port of the Angular preview host — `static-section.component`
 * and its stylesheet, plus `section-host.component`'s container rules — element
 * for element and class for class.
 *
 * That port is the whole point. An administrator approves what the preview
 * showed them, and the fidelity review compares the design against that same
 * preview. If the deployed React invented its own markup the approval would be
 * about a different artefact than the thing that shipped. So when the preview
 * changes, this file changes with it.
 *
 * What is deliberately *not* ported is the approved functional library:
 * `zm-careers-lib` is Angular 15 and cannot run in React. Those sections emit
 * as `PendingIntegration` — a labelled placeholder that carries the blueprint's
 * settings in code and claims nothing. See `emitReactSite`, which reports every
 * one of them as a warning rather than letting it pass unremarked.
 */

export interface RuntimeFile {
  path: string;
  content: string;
}

/* --------------------------------------------------------------- helpers */

/**
 * Content lookup, ported from StaticSectionComponent's accessors.
 *
 * Same tolerance for the same reason: a blueprint is restored from history as
 * raw JSON, so any field may simply be absent, and a missing field must render
 * as nothing rather than as "undefined".
 */
export const CONTENT_TS = `/* Generated from the Site Blueprint. Do not edit — edit the site in the studio. */

export type SectionContent = Record<string, unknown>;
export type Item = Record<string, unknown>;

export interface Credit {
  text: string;
  url: string;
}

/** A string field, with a fallback so a missing one never renders "undefined". */
export function value(content: SectionContent, key: string, fallback = ""): string {
  const raw = content[key];
  return typeof raw === "string" && raw.trim() ? raw : fallback;
}

export function items(content: SectionContent): Item[] {
  const raw = content["items"];
  return Array.isArray(raw) ? (raw as Item[]) : [];
}

export function itemValue(item: Item, key: string, fallback = ""): string {
  const raw = item[key];
  return typeof raw === "string" && raw.trim() ? raw : fallback;
}

/**
 * An image on the section itself.
 *
 * Uploads and generated placeholders were rewritten to /images/… when the site
 * was generated, so unlike the preview there is nothing to rebase here.
 */
export function image(content: SectionContent, key = "image"): string {
  return value(content, key);
}

export function imageAlt(content: SectionContent, key = "image", label = ""): string {
  return value(content, key + "Alt") || value(content, "headline") || label;
}

export function itemImage(item: Item, key: string): string {
  return itemValue(item, key);
}

export function itemAlt(item: Item, key: string): string {
  return itemValue(item, key + "Alt") || itemValue(item, "name") || itemValue(item, "city");
}

/** Stock licences require attribution while the image is on screen. */
export function credit(content: SectionContent, key = "image"): Credit | null {
  const raw = content[key + "Credit"];
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (!text) return null;
  return { text, url: typeof entry.url === "string" ? entry.url : "" };
}

export function credits(content: SectionContent): Credit[] {
  const raw = content["credits"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
    .map((entry) => ({
      text: typeof entry.text === "string" ? entry.text.trim() : "",
      url: typeof entry.url === "string" ? entry.url : "",
    }))
    .filter((entry) => entry.text !== "");
}
`;

/* ------------------------------------------------------------------- css */

/**
 * The site stylesheet, ported from the preview host.
 *
 * `static-section.component.scss` is nested SCSS scoped to a component; this is
 * the same rules flattened into plain CSS, plus the reset from `styles.scss`
 * and the container rules from `section-host.component.scss`. The theme's
 * custom properties are not here — they are generated per site from the
 * blueprint's design tokens and prepended by `emitStylesheet`.
 */
export const BASE_CSS = `/* ---- reset ------------------------------------------------------------- */

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
}

body {
  background: var(--brand-background);
  color: var(--brand-text);
  font-family: var(--brand-font-body);
  -webkit-font-smoothing: antialiased;
}

img {
  max-width: 100%;
}

/* ---- shared -------------------------------------------------------------- */

.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 32px;
}

.wrap.center {
  text-align: center;
}

h1,
h2,
h3 {
  font-family: var(--brand-font-heading);
  letter-spacing: -0.02em;
  margin: 0;
}

h2 {
  font-size: 30px;
  margin-bottom: 8px;
}

h3 {
  font-size: 17px;
  margin-bottom: 6px;
}

p {
  margin: 0;
}

.lede {
  color: var(--brand-muted);
  font-size: 16px;
}

.role {
  color: var(--brand-muted);
  font-size: 13.5px;
}

.btn {
  display: inline-block;
  margin-top: 26px;
  padding: 13px 24px;
  font-weight: 600;
  text-decoration: none;
  background: var(--brand-accent);
  color: #fff;
  border-radius: var(--brand-radius);
}

.btn.inverse {
  background: #fff;
  color: var(--brand-accent);
}

/* ---- sections ------------------------------------------------------------ */

.nav {
  background: #fff;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

.nav-inner {
  display: flex;
  align-items: center;
  gap: 26px;
  height: 68px;
}

.nav-inner nav,
.footer-inner nav {
  display: flex;
  gap: 22px;
  margin-left: auto;
  flex-wrap: wrap;
}

.nav-inner a {
  color: var(--brand-text);
  text-decoration: none;
  font-size: 14.5px;
}

.brand {
  font-family: var(--brand-font-heading);
  font-weight: 700;
  font-size: 17px;
}

.hero {
  position: relative;
  background: var(--brand-primary);
  color: #fff;
  padding: 88px 0;
  overflow: hidden;
}

/* The image sits behind the copy, dimmed enough that the headline keeps a
   usable contrast ratio whatever photograph is chosen. */
.hero .hero-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.42;
}

.hero .wrap {
  position: relative;
}

.hero h1 {
  font-size: 52px;
  line-height: 1.08;
}

.hero .lede {
  color: rgba(255, 255, 255, 0.86);
  font-size: 18.5px;
  margin-top: 16px;
  max-width: 620px;
}

.hero .center .lede {
  margin-left: auto;
  margin-right: auto;
}

.band {
  padding: 64px 0;
  background: var(--brand-background);
}

.band.tinted {
  background: var(--brand-surface);
}

.band.narrow .wrap {
  max-width: 760px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 22px;
  margin-top: 28px;
}

.card {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: var(--brand-radius);
  padding: 20px;
}

/* Images are cropped to a consistent shape rather than allowed to set their own
   height — a grid of portraits at three different aspect ratios reads as an
   accident. \`.empty\` is the state before any image has been chosen. */
.photo {
  display: block;
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: var(--brand-radius);
  margin-bottom: 14px;
}

.photo.empty {
  background: #dde1e6;
}

.media {
  display: block;
  width: 100%;
  height: 280px;
  object-fit: cover;
  border-radius: var(--brand-radius);
}

.media.empty {
  background: var(--brand-surface);
}

.media.tall {
  height: 340px;
}

.tile {
  display: block;
  width: 100%;
  height: 140px;
  object-fit: cover;
  border-radius: var(--brand-radius);
  margin-bottom: 12px;
}

/* An agent-authored replica of one design band. It brings its own stylesheet,
   scoped to its section id, so there is deliberately nothing to style here
   beyond giving it a box of its own. */
.custom-html {
  display: block;
  position: relative;
}

/* Attribution. Both stock licences require it on display, so it is part of the
   design rather than something bolted on later. */
.credit {
  position: absolute;
  right: 12px;
  bottom: 10px;
  font-size: 11px;
  opacity: 0.6;
}

.credit a {
  color: inherit;
  text-decoration: none;
}

.credit.inline {
  position: static;
  display: block;
  margin-top: 6px;
  color: var(--brand-muted);
}

.credit.credits {
  padding: 0 32px 12px;
}

/* Separator between credits, whichever element each one turned out to be. */
.credit.credits > * + *::before {
  content: " \\00b7 ";
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 40px;
  align-items: center;
}

blockquote {
  margin: 0;
  border-left: 3px solid var(--brand-accent);
  padding-left: 16px;
}

blockquote footer {
  color: var(--brand-muted);
  font-size: 13.5px;
  margin-top: 8px;
}

.stat {
  font-family: var(--brand-font-heading);
  font-size: 38px;
  font-weight: 700;
  color: var(--brand-accent);
}

.row {
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  padding: 16px 0;
}

.logo {
  height: 56px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: var(--brand-radius);
  color: var(--brand-muted);
}

.logo img {
  max-width: 80%;
  max-height: 70%;
  object-fit: contain;
}

.cta {
  background: var(--brand-accent);
  color: #fff;
  padding: 64px 0;
}

.cta h2 {
  font-size: 36px;
}

.cta p {
  opacity: 0.9;
  margin-top: 10px;
}

.site-footer {
  background: var(--brand-primary);
  color: #fff;
  padding: 48px 0 30px;
}

.site-footer a {
  color: rgba(255, 255, 255, 0.85);
  text-decoration: none;
  font-size: 14px;
}

.site-footer .footer-inner {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.site-footer .legal {
  opacity: 0.55;
  font-size: 12.5px;
  margin-top: 24px;
}

/* ---- layout containers --------------------------------------------------- */

/* A container stretched by an outer row should fill the slot it was given, so
   its background and its own children stretch with it. */
.layout {
  height: 100%;
}

/* Inside a row or grid this element *is* the flex/grid item, so the placement
   rules generated per child land here. min-width: 0 is not optional: a flex
   item defaults to min-width: auto and a job card's intrinsic width is wide
   enough that it would refuse to shrink and push the row past its container. */
.place {
  min-width: 0;
}

/* ---- sections this build cannot implement -------------------------------- */

/*
  An approved zm-careers-lib component. The library is Angular, so a React
  build cannot render one, and a hand-written imitation would be a search box
  that does not search. This says so instead — see components/library/README.md.
*/
.pending-integration {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 32px;
  color: var(--brand-muted);
  font-size: 14px;
  background: #fff8e5;
  border-top: 1px solid #f0e0b0;
  border-bottom: 1px solid #f0e0b0;
}

.pending-integration strong {
  color: var(--brand-text);
}

/* The library's own components are responsive; these follow the same breakpoint
   so the whole page turns over at one width rather than in pieces. */
@media (max-width: 720px) {
  .hero {
    padding: 56px 0;
  }

  .hero h1 {
    font-size: 34px;
  }

  .band {
    padding: 44px 0;
  }

  .split {
    grid-template-columns: 1fr;
  }

  .wrap {
    padding: 0 20px;
  }

  .pending-integration {
    padding: 20px;
  }
}
`;

/* ------------------------------------------------------- section components */

export interface ComponentSource {
  /** Exported component name, used in the page JSX. */
  name: string;
  /** Path in the generated repository. */
  path: string;
  source: string;
}

const HEADER = `/* Generated from the Site Blueprint. Ported from the studio preview. */`;

/**
 * One component per presentation section type.
 *
 * Several blueprint types share a component where the preview's markup for them
 * is identical — `value-props` and `benefits` are the same card grid — because
 * duplicating it would mean two files that have to be kept the same by hand.
 */
export const STATIC_COMPONENTS: Record<string, ComponentSource> = {
  nav: {
    name: "Nav",
    path: "components/sections/Nav.tsx",
    source: `${HEADER}
import Link from "next/link";
import { site } from "@/lib/site";
import type { SectionContent } from "@/lib/content";

/**
 * The header. Its content comes from the company and the blueprint's
 * navigation rather than from the section's own content — the same as the
 * preview host, which ignores it too. The prop is accepted so that every
 * section component has one signature and the emitter has one call shape.
 */
export function Nav({ content }: { content: SectionContent; label?: string }) {
  void content;

  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <span className="brand">{site.name}</span>
        <nav>
          {site.nav.map((item) =>
            item.href ? (
              <Link key={item.label} href={item.href}>
                {item.label}
              </Link>
            ) : (
              <span key={item.label}>{item.label}</span>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
`,
  },

  hero: {
    name: "Hero",
    path: "components/sections/Hero.tsx",
    source: `${HEADER}
import Link from "next/link";
import { site } from "@/lib/site";
import { credit, image, value, type SectionContent } from "@/lib/content";

/**
 * The hero. Its image is a background, so it is decorative and the headline
 * carries the meaning — alt stays empty on purpose.
 */
export function Hero({ content, label }: { content: SectionContent; label: string }) {
  const background = image(content);
  const centred = value(content, "alignment") === "center";
  const cta = value(content, "ctaLabel");
  const href = value(content, "ctaHref");
  const attribution = credit(content);

  return (
    <section className={background ? "hero has-image" : "hero"}>
      {background ? <img className="hero-bg" src={background} alt="" /> : null}
      <div className={centred ? "wrap center" : "wrap"}>
        <h1>{value(content, "headline", site.name ? "Careers at " + site.name : label)}</h1>
        <p className="lede">{value(content, "subhead", site.tagline)}</p>
        {cta ? (
          href ? (
            <Link className="btn" href={href}>
              {cta}
            </Link>
          ) : (
            <span className="btn">{cta}</span>
          )
        ) : null}
      </div>
      {attribution ? (
        <small className="credit">
          <a href={attribution.url} target="_blank" rel="noopener noreferrer">
            {attribution.text}
          </a>
        </small>
      ) : null}
    </section>
  );
}
`,
  },

  "value-props": {
    name: "CardGrid",
    path: "components/sections/CardGrid.tsx",
    source: `${HEADER}
import { items, itemValue, value, type SectionContent } from "@/lib/content";

/** Value propositions and benefits: a headline over a grid of short cards. */
export function CardGrid({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        <div className="grid">
          {items(content).map((item, index) => (
            <article key={index}>
              <h3>{itemValue(item, "title")}</h3>
              <p>{itemValue(item, "body")}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
`,
  },

  "employee-stories": {
    name: "EmployeeStories",
    path: "components/sections/EmployeeStories.tsx",
    source: `${HEADER}
import { itemAlt, itemImage, items, itemValue, value, type SectionContent } from "@/lib/content";

export function EmployeeStories({ content }: { content: SectionContent; label?: string }) {
  return (
    <section className="band tinted">
      <div className="wrap">
        <h2>{value(content, "headline", "Meet the team")}</h2>
        <div className="grid">
          {items(content).map((item, index) => {
            const photo = itemImage(item, "photo");
            return (
              <article key={index} className="card">
                {photo ? (
                  <img className="photo" src={photo} alt={itemAlt(item, "photo")} loading="lazy" />
                ) : (
                  <div className="photo empty" />
                )}
                <h3>{itemValue(item, "name")}</h3>
                <p className="role">{itemValue(item, "role")}</p>
                <p>{itemValue(item, "quote")}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
`,
  },

  testimonials: {
    name: "Testimonials",
    path: "components/sections/Testimonials.tsx",
    source: `${HEADER}
import { items, itemValue, value, type SectionContent } from "@/lib/content";

export function Testimonials({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        <div className="grid">
          {items(content).map((item, index) => {
            const role = itemValue(item, "role");
            return (
              <blockquote key={index}>
                <p>{itemValue(item, "quote")}</p>
                <footer>
                  {itemValue(item, "author")}
                  {role ? <span> · {role}</span> : null}
                </footer>
              </blockquote>
            );
          })}
        </div>
      </div>
    </section>
  );
}
`,
  },

  stats: {
    name: "Stats",
    path: "components/sections/Stats.tsx",
    source: `${HEADER}
import { items, itemValue, type SectionContent } from "@/lib/content";

export function Stats({ content }: { content: SectionContent; label?: string }) {
  return (
    <section className="band">
      <div className="wrap grid">
        {items(content).map((item, index) => (
          <div key={index}>
            <div className="stat">{itemValue(item, "value")}</div>
            <p className="role">{itemValue(item, "label")}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`,
  },

  culture: {
    name: "Culture",
    path: "components/sections/Culture.tsx",
    source: `${HEADER}
import { image, imageAlt, value, type SectionContent } from "@/lib/content";

export function Culture({ content, label }: { content: SectionContent; label: string }) {
  const picture = image(content);

  return (
    <section className="band">
      <div className="wrap split">
        <div>
          <h2>{value(content, "headline", label)}</h2>
          <p className="lede">{value(content, "body")}</p>
        </div>
        {picture ? (
          <img className="media" src={picture} alt={imageAlt(content, "image", label)} loading="lazy" />
        ) : (
          <div className="media empty" />
        )}
      </div>
    </section>
  );
}
`,
  },

  teams: {
    name: "Teams",
    path: "components/sections/Teams.tsx",
    source: `${HEADER}
import { itemAlt, itemImage, items, itemValue, value, type SectionContent } from "@/lib/content";

export function Teams({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        <div className="grid">
          {items(content).map((item, index) => {
            const tile = itemImage(item, "image");
            return (
              <article key={index} className="card">
                {tile ? (
                  <img className="tile" src={tile} alt={itemAlt(item, "image")} loading="lazy" />
                ) : null}
                <h3>{itemValue(item, "name") || itemValue(item, "city")}</h3>
                <p>{itemValue(item, "body") || itemValue(item, "country")}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
`,
  },

  locations: {
    name: "Locations",
    path: "components/sections/Locations.tsx",
    source: `${HEADER}
import { itemAlt, itemImage, items, itemValue, value, type SectionContent } from "@/lib/content";

export function Locations({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        <div className="grid">
          {items(content).map((item, index) => {
            const tile = itemImage(item, "image");
            return (
              <article key={index} className="card">
                {tile ? (
                  <img className="tile" src={tile} alt={itemAlt(item, "image")} loading="lazy" />
                ) : null}
                <h3>{itemValue(item, "city") || itemValue(item, "name")}</h3>
                <p>{itemValue(item, "country") || itemValue(item, "body")}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
`,
  },

  process: {
    name: "Process",
    path: "components/sections/Process.tsx",
    source: `${HEADER}
import { items, itemValue, value, type SectionContent } from "@/lib/content";

export function Process({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band narrow">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        {items(content).map((item, index) => (
          <div key={index} className="row">
            <h3>{itemValue(item, "title", "Step " + (index + 1))}</h3>
            <p>{itemValue(item, "body")}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`,
  },

  faq: {
    name: "Faq",
    path: "components/sections/Faq.tsx",
    source: `${HEADER}
import { items, itemValue, value, type SectionContent } from "@/lib/content";

export function Faq({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band narrow">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        {items(content).map((item, index) => (
          <div key={index} className="row">
            <h3>{itemValue(item, "question")}</h3>
            <p>{itemValue(item, "answer")}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`,
  },

  cta: {
    name: "Cta",
    path: "components/sections/Cta.tsx",
    source: `${HEADER}
import Link from "next/link";
import { value, type SectionContent } from "@/lib/content";

export function Cta({ content }: { content: SectionContent; label?: string }) {
  const label = value(content, "ctaLabel");
  const href = value(content, "ctaHref");

  return (
    <section className="cta">
      <div className="wrap center">
        <h2>{value(content, "headline", "Ready when you are")}</h2>
        <p>{value(content, "body")}</p>
        {label ? (
          href ? (
            <Link className="btn inverse" href={href}>
              {label}
            </Link>
          ) : (
            <span className="btn inverse">{label}</span>
          )
        ) : null}
      </div>
    </section>
  );
}
`,
  },

  "logo-wall": {
    name: "LogoWall",
    path: "components/sections/LogoWall.tsx",
    source: `${HEADER}
import { itemImage, items, itemValue, value, type SectionContent } from "@/lib/content";

export function LogoWall({ content, label }: { content: SectionContent; label: string }) {
  return (
    <section className="band">
      <div className="wrap">
        <h2>{value(content, "headline", label)}</h2>
        <div className="grid">
          {items(content).map((item, index) => {
            const logo = itemImage(item, "image");
            return (
              <div key={index} className="logo">
                {logo ? (
                  <img src={logo} alt={itemValue(item, "name")} loading="lazy" />
                ) : (
                  itemValue(item, "name")
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
`,
  },

  media: {
    name: "Media",
    path: "components/sections/Media.tsx",
    source: `${HEADER}
import { credit, image, imageAlt, value, type SectionContent } from "@/lib/content";

export function Media({ content, label }: { content: SectionContent; label: string }) {
  const picture = image(content);
  const caption = value(content, "caption");
  const attribution = credit(content);

  return (
    <section className="band">
      <div className="wrap">
        {picture ? (
          <img
            className="media tall"
            src={picture}
            alt={imageAlt(content, "image", label)}
            loading="lazy"
          />
        ) : (
          <div className="media tall empty" />
        )}
        {caption ? <p className="role">{caption}</p> : null}
        {attribution ? (
          <small className="credit inline">
            <a href={attribution.url} target="_blank" rel="noopener noreferrer">
              {attribution.text}
            </a>
          </small>
        ) : null}
      </div>
    </section>
  );
}
`,
  },

  footer: {
    name: "Footer",
    path: "components/sections/Footer.tsx",
    source: `${HEADER}
import Link from "next/link";
import { site } from "@/lib/site";
import { value, type SectionContent } from "@/lib/content";

export function Footer({ content }: { content: SectionContent; label?: string }) {
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <span className="brand">{site.name}</span>
        <nav>
          {site.nav.map((item) =>
            item.href ? (
              <Link key={item.label} href={item.href}>
                {item.label}
              </Link>
            ) : (
              <span key={item.label}>{item.label}</span>
            ),
          )}
        </nav>
      </div>
      <div className="wrap legal">{value(content, "legal", site.legal)}</div>
    </footer>
  );
}
`,
  },

  "custom-html": {
    name: "CustomHtml",
    path: "components/sections/CustomHtml.tsx",
    source: `${HEADER}
import { credits, value, type SectionContent } from "@/lib/content";

/**
 * A replica of one design band, authored as HTML and CSS in the studio.
 *
 * The markup is written straight into the DOM, which is safe for one specific
 * reason: it was sanitized server-side when the operation was applied — a
 * strict tag and attribute allowlist, with script, style, event handlers and
 * non-http(s) URLs removed — and this file only ever receives the result. React
 * escaping is not what makes it safe and would not make it safe; it would only
 * turn a faithful replica into visible angle brackets.
 *
 * \`data-section-id\` is load-bearing: every selector in the replica's
 * stylesheet was rewritten to sit under this attribute, and the stylesheet
 * itself is in app/globals.css. Without the attribute nothing below is styled.
 */
export function CustomHtml({
  sectionId,
  content,
}: {
  sectionId: string;
  content: SectionContent;
  label?: string;
}) {
  const attribution = credits(content);

  return (
    <div data-section-id={sectionId} style={{ position: "relative" }}>
      <section className="custom-html" dangerouslySetInnerHTML={{ __html: value(content, "html") }} />
      {attribution.length > 0 ? (
        <small className="credit inline credits">
          {attribution.map((entry, index) =>
            entry.url ? (
              <a key={index} href={entry.url} target="_blank" rel="noopener noreferrer">
                {entry.text}
              </a>
            ) : (
              <span key={index}>{entry.text}</span>
            ),
          )}
        </small>
      ) : null}
    </div>
  );
}
`,
  },

  "rich-text": {
    name: "RichText",
    path: "components/sections/RichText.tsx",
    source: `${HEADER}
import { value, type SectionContent } from "@/lib/content";

/** Rich text, and any presentation type this build does not know by name. */
export function RichText({ content, label }: { content: SectionContent; label: string }) {
  const headline = value(content, "headline");

  return (
    <section className="band narrow">
      <div className="wrap">
        {headline ? <h2>{headline}</h2> : null}
        <p className="lede">{value(content, "body", label)}</p>
      </div>
    </section>
  );
}
`,
  },
};

/** Presentation types with no component of their own fall back to rich text. */
export const FALLBACK_COMPONENT = STATIC_COMPONENTS["rich-text"];

/**
 * The stand-in for an approved functional component.
 *
 * One component rather than thirteen, because there is nothing type-specific to
 * render: the honest output for "job search" in a React build is a statement
 * that the approved Angular component has not been wired up, plus the settings
 * the administrator chose, so whoever wires it up does not have to go back to
 * the blueprint to find them.
 */
export const PENDING_COMPONENT: ComponentSource = {
  name: "PendingIntegration",
  path: "components/library/PendingIntegration.tsx",
  source: `${HEADER}

/**
 * An approved zm-careers-lib section that this build cannot render.
 *
 * The library is Angular 15, so a React site cannot host one, and writing an
 * imitation would produce a search box that does not search and a job list that
 * lists nothing real. Both are worse than an honest gap, so this renders the
 * gap and carries the blueprint's settings for whoever integrates the real
 * component. See components/library/README.md.
 */
export function PendingIntegration({
  component,
  label,
  settings,
}: {
  component: string;
  label: string;
  settings?: Record<string, unknown>;
}) {
  void settings;

  return (
    <div className="pending-integration" data-library-component={component}>
      <strong>{label}</strong> is an approved careers component ({component}) that this build does
      not render. It needs the zm-careers-lib integration described in
      components/library/README.md.
    </div>
  );
}
`,
};
