/**
 * Imagery for a career site.
 *
 * Three sources, in the order the agent should prefer them:
 *
 * 1. **Assets the company uploaded.** Always right, always licensed, and the
 *    only source that shows the actual company. Stored and served by the
 *    studio — see src/lib/store/assets.ts.
 * 2. **Stock photography**, when a provider key is configured. Real photographs
 *    of people and workplaces, referenced by their CDN URL rather than copied,
 *    and carrying the attribution the licence requires.
 * 3. **Generated placeholders.** Always available, no network, no licence
 *    question. Drawn from the site's own brand colours so a page reads as
 *    deliberate rather than broken while real imagery is still being gathered.
 *
 * The agent must never invent an image URL. Every URL in a blueprint comes from
 * one of these three, which is what stops it emitting links that 404.
 */

export interface ImageCandidate {
  /** The URL to put in the blueprint. */
  url: string;
  /** A smaller version for pickers, when the provider offers one. */
  thumbnailUrl: string;
  width: number;
  height: number;
  /** Description for the `alt` attribute. Never decorative filler. */
  alt: string;
  /**
   * Attribution required by the licence, if any. Carried through to the
   * blueprint so the built site can display it.
   */
  credit: {
    photographer: string;
    photographerUrl: string;
    source: string;
    sourceUrl: string;
  } | null;
  provider: "upload" | "unsplash" | "pexels" | "placeholder";
}

export type Orientation = "landscape" | "portrait" | "square" | "any";

export interface ImageProvider {
  readonly name: "unsplash" | "pexels" | "none";
  readonly configured: boolean;
  search(query: string, options: { orientation: Orientation; count: number }): Promise<ImageCandidate[]>;
}

/** Section content keys that hold an image, and what shape suits each. */
export const IMAGE_SLOTS: Record<string, { key: string; orientation: Orientation; note: string }> = {
  hero: { key: "image", orientation: "landscape", note: "Wide banner behind the headline." },
  culture: { key: "image", orientation: "landscape", note: "Supporting image beside the copy." },
  media: { key: "image", orientation: "landscape", note: "A full-width image or video still." },
  "employee-stories": { key: "photo", orientation: "portrait", note: "One photo per person, on each item." },
  teams: { key: "image", orientation: "landscape", note: "One image per team, on each item." },
  locations: { key: "image", orientation: "landscape", note: "One image per location, on each item." },
  "logo-wall": { key: "image", orientation: "square", note: "One logo per item." },
};
