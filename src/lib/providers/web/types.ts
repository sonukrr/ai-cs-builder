/**
 * A page on the open web, read well enough to be replicated.
 *
 * The shapes here deliberately mirror `providers/figma/types.ts`. A Figma
 * import and a web import answer the same question — what bands is this made
 * of, what does each one say, and what pictures are in it — and the agent has
 * a working pipeline for that answer already: look at a band, read its
 * geometry and copy, then author an HTML/CSS replica. Keeping the vocabulary
 * the same means the web importer plugs into that pipeline rather than
 * inventing a second one.
 */

export interface WebImage {
  /** The absolute URL as it appears on the page. */
  sourceUrl: string;
  /** Where it lives in this project's asset store once imported. */
  url: string;
  alt: string;
  /** Rendered size on the page, which is what a replica has to reproduce. */
  width: number;
  height: number;
  /** True for a CSS background rather than an <img>. */
  background: boolean;
  bytes: number;
}

/** One element's styling, as CSS an agent can read and translate. */
export interface WebStyleRule {
  /** A readable path to the element within the band, e.g. `div.hero > h1`. */
  selector: string;
  /** Declarations, already filtered to the ones that describe the design. */
  declarations: string;
}

export interface WebBand {
  /** Position in the page, top to bottom. The agent refers to bands by this. */
  index: number;
  /** A short, human name derived from the band's own heading or id. */
  name: string;
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** Visible copy, in document order, capped. */
  text: string;
  /** The band's headings, which is usually what it is *for*. */
  headings: string[];
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  /** Images inside this band, as asset URLs once imported. */
  images: WebImage[];
  /** A screenshot of this band alone, stored as a project asset. */
  screenshotUrl: string;
  /** The band's own markup, trimmed. Reference only — never pasted. */
  markup: string;
  /**
   * The styling that makes the band look the way it does: the computed rules
   * for its root and its notable descendants. Computed rather than authored,
   * because the authored stylesheet is usually a framework's and says nothing
   * about what this band actually resolved to.
   */
  styles: WebStyleRule[];
  /**
   * Anything that moves: transitions and animations, per element. Named
   * animations resolve against the page's `keyframes`.
   */
  animations: string[];
}

/** Design tokens inferred from the page, as a starting point for the theme. */
export interface WebTokens {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  headingFont: string;
  bodyFont: string;
  radius: number;
}

export interface WebPageCapture {
  url: string;
  title: string;
  description: string;
  /** Viewport the page was rendered at. */
  viewportWidth: number;
  pageHeight: number;
  bands: WebBand[];
  /** Every image imported, including those not inside a recognised band. */
  images: WebImage[];
  tokens: WebTokens;
  /**
   * Every `@keyframes` the page defines that something on it uses.
   *
   * Separate from the bands because a keyframe rule is page-level: two bands
   * can share one animation, and a replica that copied the declaration without
   * the keyframes would animate to nothing.
   */
  keyframes: string[];
  /** A screenshot of the whole page, stored as a project asset. */
  screenshotUrl: string;
  /** Anything the administrator should know about what was and was not read. */
  warnings: string[];
}
