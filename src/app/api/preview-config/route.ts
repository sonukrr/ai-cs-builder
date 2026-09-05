export const runtime = "nodejs";

/**
 * Settings the studio hands to the Angular preview host.
 *
 * Kept server-side so the API host, tenant and company id come from the
 * environment rather than being hardcoded into the client bundle, and so
 * changing which backend a demo points at is a restart rather than a rebuild.
 */
export async function GET() {
  return Response.json({
    previewOrigin: process.env.PREVIEW_ORIGIN ?? "http://localhost:4200",
    /** Default data source when the studio first opens: sample | custom | live. */
    defaultSource: (() => {
      const configured = (process.env.PREVIEW_SOURCE ?? "sample").toLowerCase();
      return configured === "live" || configured === "custom" ? configured : "sample";
    })(),
    apiHost: process.env.CAREERS_API_HOST ?? "https://apipreprod1.zwayam.com",
    /** TenantGroupId header the library sends. */
    tenantId: process.env.CAREERS_TENANT_ID ?? "",
    /** Base64-encoded company id; the library decodes it with window.atob. */
    companyId: process.env.CAREERS_COMPANY_ID ?? "",
    /** The career site domain sent as `domain` on every search. */
    domain: process.env.CAREERS_DOMAIN ?? "",
    /** Live mode needs a tenant and company; the studio disables it otherwise. */
    liveReady: Boolean(process.env.CAREERS_TENANT_ID && process.env.CAREERS_COMPANY_ID),
  });
}
