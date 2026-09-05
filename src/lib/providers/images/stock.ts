import type { ImageCandidate, ImageProvider, Orientation } from "./types";

/**
 * Stock photography backends.
 *
 * Both return CDN URLs that the blueprint references directly — nothing is
 * downloaded or re-hosted, which keeps the licence intact and means an image
 * costs the studio no storage. Attribution comes back with each result and is
 * carried into the blueprint, because both licences require it on display and
 * the agent should never be the reason a company breaches one.
 */

const TIMEOUT_MS = 20_000;

export class UnsplashProvider implements ImageProvider {
  readonly name = "unsplash" as const;
  readonly configured: boolean;
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
    this.configured = Boolean(key);
  }

  async search(
    query: string,
    { orientation, count }: { orientation: Orientation; count: number },
  ): Promise<ImageCandidate[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(Math.min(count, 30)),
      content_filter: "high",
    });
    // Unsplash has no "any"; omitting the parameter is what means any.
    if (orientation !== "any" && orientation !== "square") params.set("orientation", orientation);
    if (orientation === "square") params.set("orientation", "squarish");

    const response = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
      headers: { Authorization: `Client-ID ${this.key}`, "Accept-Version": "v1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Unsplash returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      results: {
        urls: { regular: string; small: string };
        width: number;
        height: number;
        alt_description: string | null;
        description: string | null;
        links: { html: string };
        user: { name: string; links: { html: string } };
      }[];
    };

    return data.results.map((photo) => ({
      url: photo.urls.regular,
      thumbnailUrl: photo.urls.small,
      width: photo.width,
      height: photo.height,
      alt: photo.alt_description ?? photo.description ?? query,
      credit: {
        photographer: photo.user.name,
        photographerUrl: photo.user.links.html,
        source: "Unsplash",
        sourceUrl: photo.links.html,
      },
      provider: "unsplash" as const,
    }));
  }
}

export class PexelsProvider implements ImageProvider {
  readonly name = "pexels" as const;
  readonly configured: boolean;
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
    this.configured = Boolean(key);
  }

  async search(
    query: string,
    { orientation, count }: { orientation: Orientation; count: number },
  ): Promise<ImageCandidate[]> {
    const params = new URLSearchParams({ query, per_page: String(Math.min(count, 30)) });
    if (orientation !== "any") params.set("orientation", orientation);

    const response = await fetch(`https://api.pexels.com/v1/search?${params}`, {
      headers: { Authorization: this.key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Pexels returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      photos: {
        src: { large: string; medium: string };
        width: number;
        height: number;
        alt: string;
        url: string;
        photographer: string;
        photographer_url: string;
      }[];
    };

    return data.photos.map((photo) => ({
      url: photo.src.large,
      thumbnailUrl: photo.src.medium,
      width: photo.width,
      height: photo.height,
      alt: photo.alt || query,
      credit: {
        photographer: photo.photographer,
        photographerUrl: photo.photographer_url,
        source: "Pexels",
        sourceUrl: photo.url,
      },
      provider: "pexels" as const,
    }));
  }
}

/** Reports itself unconfigured so the agent falls back rather than failing. */
class NoStockProvider implements ImageProvider {
  readonly name = "none" as const;
  readonly configured = false;
  async search(): Promise<ImageCandidate[]> {
    return [];
  }
}

export function getStockProvider(): ImageProvider {
  if (process.env.UNSPLASH_ACCESS_KEY) return new UnsplashProvider(process.env.UNSPLASH_ACCESS_KEY);
  if (process.env.PEXELS_API_KEY) return new PexelsProvider(process.env.PEXELS_API_KEY);
  return new NoStockProvider();
}
