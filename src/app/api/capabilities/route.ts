import { capabilities } from "@/lib/agent/capabilities";
import { hasApiKey } from "@/lib/agent/client";
import { registry } from "@/lib/registry";

export const runtime = "nodejs";

/** What this deployment can actually do — drives the honest state in the UI. */
export async function GET() {
  return Response.json({
    agentReady: hasApiKey(),
    library: {
      name: registry.package.name,
      version: registry.package.version,
      framework: registry.package.framework,
      componentCount: registry.components.filter((c) => c.status === "approved").length,
    },
    capabilities: capabilities(),
  });
}
