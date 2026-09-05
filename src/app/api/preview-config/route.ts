export const runtime = "nodejs";

/**
 * Settings the studio hands to the Angular preview host.
 *
 * Only what varies per deployment lives here. The careers-API identity — the
 * endpoint, company id and domain — is fixed inside the preview host itself
 * (preview-app/src/app/preview-config.ts), because seeding those storage keys
 * is the entire contract `zm-careers-lib` needs to run; routing them through
 * the environment and then the iframe URL only added ways to get them wrong.
 */
export async function GET() {
  return Response.json({
    previewOrigin: process.env.PREVIEW_ORIGIN ?? "http://localhost:4200",
    /** Default data source when the studio first opens: sample | custom | live. */
    defaultSource: (() => {
      const configured = (process.env.PREVIEW_SOURCE ?? "sample").toLowerCase();
      return configured === "live" || configured === "custom" ? configured : "sample";
    })(),
    /** The host carries its own credentials, so live mode is always offerable. */
    liveReady: true,
  });
}
