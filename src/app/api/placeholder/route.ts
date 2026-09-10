import { placeholderSvg } from "@/lib/providers/images/placeholder";

export const runtime = "nodejs";

/**
 * Serves a branded placeholder image.
 *
 * The drawing itself lives in `@/lib/providers/images/placeholder` because the
 * deploy pipeline needs the same bytes as a file in the generated repository —
 * see `collectStudioAssets`.
 *
 *   /api/placeholder?w=1600&h=900&label=Team%20photo&bg=%230f2a4a&fg=%23ffffff
 */
export async function GET(request: Request) {
  const svg = placeholderSvg(new URL(request.url).searchParams);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Deterministic output, so it can be cached hard.
      "Cache-Control": "public, max-age=31536000, immutable",
      // Rendered as an image, never as a document.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
