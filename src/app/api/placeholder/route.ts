export const runtime = "nodejs";

/**
 * A themed placeholder image, drawn from the site's own brand colours.
 *
 * The point is that a page missing its photography should look deliberately
 * unfinished rather than broken. A grey box reads as a bug; a branded panel
 * that names what belongs there reads as a task. It also means the agent always
 * has *some* honest image URL to use — it never has to invent one, and it never
 * has to leave a hero with nothing behind it.
 *
 * Self-contained by design: colours and label arrive as parameters, so the
 * response depends on nothing and caches forever.
 *
 *   /api/placeholder?w=1600&h=900&label=Team%20photo&bg=%230f2a4a&fg=%23ffffff
 */

const MAX_DIMENSION = 4000;

function clampInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(16, Math.min(MAX_DIMENSION, parsed));
}

/** Only accept hex we control the shape of — this string goes into markup. */
function safeColor(value: string | null, fallback: string): string {
  const candidate = (value ?? "").trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(candidate) ? candidate : fallback;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const width = clampInt(params.get("w"), 1600);
  const height = clampInt(params.get("h"), 900);
  const bg = safeColor(params.get("bg"), "#0f2a4a");
  const fg = safeColor(params.get("fg"), "#ffffff");
  const label = escapeXml((params.get("label") ?? "").slice(0, 80));

  // Scale the motif and type with the box so a 96px avatar and a 1600px hero
  // both look considered rather than one being a scaled-up version of the other.
  const shorter = Math.min(width, height);
  const fontSize = Math.max(11, Math.round(shorter * 0.055));
  const gap = Math.round(shorter * 0.09);
  const stroke = Math.max(1, Math.round(shorter * 0.004));
  const showLabel = label.length > 0 && shorter >= 120;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label || "Placeholder image"}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${bg}" stop-opacity="0.78"/>
    </linearGradient>
    <pattern id="p" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${gap}" stroke="${fg}" stroke-opacity="0.10" stroke-width="${stroke}"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <rect width="${width}" height="${height}" fill="url(#p)"/>
  ${
    showLabel
      ? `<text x="50%" y="50%" fill="${fg}" fill-opacity="0.82" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="0.02em" text-anchor="middle" dominant-baseline="middle">${label}</text>`
      : ""
  }
</svg>`;

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
