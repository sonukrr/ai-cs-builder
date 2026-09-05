import { assets } from "@/lib/store/assets";

export const runtime = "nodejs";

/**
 * Serves an uploaded image.
 *
 * Read by the preview host, which runs on its own origin, so this route is
 * cross-origin readable — images are public content on the eventual career
 * site anyway.
 *
 * SVG is an allowed upload type and is script-capable, so responses carry a
 * restrictive CSP and `nosniff`. Together those mean a malicious SVG renders as
 * a picture and nothing more.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; file: string }> },
) {
  const { projectId, file } = await params;

  const asset = await assets.read(projectId, file);
  if (!asset) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.contentType,
      // Content-addressed filenames never change meaning, so cache hard.
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
