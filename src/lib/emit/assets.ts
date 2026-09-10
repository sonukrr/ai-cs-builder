import { createHash } from "node:crypto";
import type { Blueprint } from "@/lib/blueprint/schema";

/**
 * Studio-hosted images, and how they travel into a generated site.
 *
 * Uploads, imported design images and branded placeholders are all served by
 * the studio, so a deployed site that kept referencing them would break the
 * moment the studio was unreachable — and the studio is an internal tool, so
 * that is immediately. They have to be copied into the repository instead, and
 * every reference rewritten.
 *
 * Shared by both emitters because the rewriting is identical and only the
 * layout differs: Next.js serves `public/`, the Angular CLI serves
 * `src/assets/`.
 */

/** Where a target keeps its static files. */
export interface AssetLayout {
  /** Directory in the repository, e.g. `public/images`. */
  directory: string;
  /** URL prefix the built site serves them under, e.g. `/images`. */
  publicPath: string;
}

export const NEXT_ASSETS: AssetLayout = { directory: "public/images", publicPath: "/images" };
export const ANGULAR_ASSETS: AssetLayout = {
  directory: "src/assets/images",
  publicPath: "/assets/images",
};

export interface StudioAsset {
  /** The studio-relative URL as it appears in the blueprint. */
  url: string;
  /** Where it will live in the repository. */
  path: string;
  /** The URL the generated site references it by. */
  publicUrl: string;
}

/**
 * The scan is over every string in every section rather than over the known
 * image keys, because a `custom-html` replica carries its own `<img src>` and
 * its own `url(…)` in CSS, and those are exactly as dependent on the studio as
 * a hero image is.
 */
const STUDIO_URL =
  /\/api\/(?:projects\/[0-9a-fA-F-]+\/assets\/[\w.-]+|placeholder\?[^\s"'()<>\\]*)/g;

function fileNameFor(url: string): string {
  const asset = url.match(/\/assets\/([\w.-]+)$/);
  // Asset filenames are already content-addressed by the store; a placeholder
  // is identified by its query, so the same query is the same picture.
  if (asset) return asset[1];
  return `placeholder-${createHash("sha1").update(url).digest("hex").slice(0, 12)}.svg`;
}

/** Every studio-hosted image the blueprint refers to, de-duplicated. */
export function collectStudioAssets(
  blueprint: Blueprint,
  layout: AssetLayout = NEXT_ASSETS,
): StudioAsset[] {
  const found = new Map<string, StudioAsset>();

  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(STUDIO_URL)) {
        const url = match[0];
        if (found.has(url)) continue;
        const file = fileNameFor(url);
        found.set(url, {
          url,
          path: `${layout.directory}/${file}`,
          publicUrl: `${layout.publicPath}/${file}`,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) scan(entry);
    }
  };

  scan(blueprint.pages);
  scan(blueprint.company.brand);
  return [...found.values()];
}

/** The same value with every studio image URL pointing into the built site. */
export function rebaseAssets<T>(value: T, assets: StudioAsset[]): T {
  if (assets.length === 0) return value;
  const lookup = new Map(assets.map((asset) => [asset.url, asset.publicUrl]));

  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input.replace(STUDIO_URL, (match) => lookup.get(match) ?? match);
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, walk(entry)]));
    }
    return input;
  };

  return walk(value) as T;
}
