import { figmaStatus } from "@/lib/providers/figma";
import { baseSiteStatus } from "@/lib/providers/github";
import { getStockProvider } from "@/lib/providers/images/stock";
import { hasApiKey } from "./client";

/**
 * What this agent can do, and whether each thing is actually wired up.
 *
 * Two jobs. The studio renders this so an administrator sees honest state
 * instead of a button that fails on click. And a condensed form goes into the
 * system prompt, so the agent knows which of its own tools will work and can
 * say "the base repository has not been configured yet" rather than trying and
 * reporting an opaque error.
 *
 * Everything degrades to a usable demo state rather than being switched off, so
 * no capability is ever simply missing — it is ready, or ready-in-demo-mode, or
 * explicitly waiting on configuration.
 */

export type CapabilityState = "ready" | "demo" | "needs-config";

export interface Capability {
  id: string;
  /** Admin-facing name. */
  name: string;
  description: string;
  state: CapabilityState;
  detail: string;
  /** What to set to move this from demo/needs-config to ready. */
  requires: string[];
  /** Agent tools this capability enables. */
  tools: string[];
}

export function capabilities(): Capability[] {
  const figma = figmaStatus();
  const base = baseSiteStatus();
  const stock = getStockProvider();
  const research = (process.env.ENABLE_RESEARCH ?? "true").toLowerCase() !== "false";

  return [
    {
      id: "IMPORT_FIGMA",
      name: "Import an existing Figma design",
      description:
        "Reads a Figma file, reads each band of the design semantically, maps functional bands to approved components, and produces a site plan for approval.",
      state: figma.backend === "mock" ? "demo" : figma.ready ? "ready" : "needs-config",
      detail: figma.detail,
      requires:
        figma.backend === "mcp"
          ? ["Figma desktop app running with the Dev Mode MCP server enabled"]
          : figma.backend === "rest"
            ? ["FIGMA_TOKEN"]
            : ["FIGMA_PROVIDER=mcp (desktop) or FIGMA_PROVIDER=rest + FIGMA_TOKEN"],
      tools: ["import_figma"],
    },
    {
      id: "START_FROM_BASE",
      name: "Start from the approved base site",
      description:
        "Reads the approved base career-site repository, discovers its pages, components and configuration, and customises it for the company.",
      // The base repo link is supplied later; until then this runs against a
      // stand-in so the flow is demonstrable rather than dark.
      state: base.backend === "mock" ? "demo" : base.ready ? "ready" : "needs-config",
      detail: base.detail,
      requires: ["BASE_SITE_REPO (the approved repository link)", "GITHUB_TOKEN"],
      tools: ["read_base_site", "start_from_base"],
    },
    {
      id: "MODIFY_SITE",
      name: "Change the site by describing it",
      description:
        "Applies conversational edits — reordering sections, rewriting copy, changing the theme — as structured operations against the site blueprint.",
      state: hasApiKey() ? "ready" : "needs-config",
      detail: hasApiKey()
        ? "Available on every project."
        : "ANTHROPIC_API_KEY is not set, so the agent cannot run.",
      requires: ["ANTHROPIC_API_KEY"],
      tools: ["get_blueprint", "apply_operations"],
    },
    {
      id: "ADD_FUNCTIONALITY",
      name: "Add career functionality",
      description:
        "Adds approved capabilities such as job search, filters, resume upload or the application form. Capability the library does not have is recorded as a request, never invented.",
      state: "ready",
      detail: "Backed by the generated component registry, so it cannot drift from the library.",
      requires: [],
      tools: ["search_components", "describe_component", "apply_operations"],
    },
    {
      id: "MANAGE_IMAGERY",
      name: "Find and set images",
      description:
        "Puts real imagery on the site: photographs the company uploads, licensed stock photography with its attribution, or a branded placeholder. Always writes alt text.",
      // Placeholders and uploads work with no credentials at all, so the
      // capability is never simply unavailable — only narrower.
      state: stock.configured ? "ready" : "demo",
      detail: stock.configured
        ? `Uploads, branded placeholders, and stock photography via ${stock.name}.`
        : "Uploads and branded placeholders. Set UNSPLASH_ACCESS_KEY or PEXELS_API_KEY to add stock photography.",
      requires: ["UNSPLASH_ACCESS_KEY or PEXELS_API_KEY (for stock photography only)"],
      tools: ["list_image_sources", "search_stock_images", "create_placeholder_image", "set_section_image"],
    },
    {
      id: "RESEARCH_OR_INSPIRATION",
      name: "Take inspiration from another site",
      description:
        "On explicit request only, researches a public career site and summarises its structural patterns. Produces an original plan — never copied markup or content.",
      state: research ? "ready" : "needs-config",
      detail: research
        ? "Uses web search, and is only engaged when an administrator asks for it."
        : "Disabled by ENABLE_RESEARCH=false.",
      requires: ["ENABLE_RESEARCH=true"],
      tools: ["web_search"],
    },
    {
      id: "VERSION_AND_PREVIEW",
      name: "Versions, undo and preview",
      description:
        "Saves every approved change as a version with a change summary, supports undo, and renders a live preview from the blueprint.",
      state: "ready",
      detail: "Versions are append-only; undo replays an old version forward rather than deleting history.",
      requires: [],
      tools: ["list_versions", "revert_to_version"],
    },
    {
      id: "REQUEST_PUBLISH",
      name: "Request publication",
      description:
        "Validates the blueprint, writes controlled configuration to a company branch, and files a publish request for review. Never deploys to production.",
      state: base.backend === "mock" ? "demo" : base.ready ? "ready" : "needs-config",
      detail:
        base.backend === "mock"
          ? "Publish requests are recorded locally; branch commits need the base repository."
          : base.detail,
      requires: ["BASE_SITE_REPO", "GITHUB_TOKEN"],
      tools: ["commit_to_branch", "request_publish"],
    },
  ];
}

/** Condensed capability state for the system prompt. */
export function capabilitiesForPrompt(): string {
  return capabilities()
    .map((c) => {
      const state =
        c.state === "ready"
          ? "READY"
          : c.state === "demo"
            ? "DEMO MODE — works end to end, but against stand-in data. Say so if it matters to the admin's decision."
            : `NOT CONFIGURED — needs ${c.requires.join(", ")}. Do not attempt it; explain what is missing.`;
      return `- ${c.id} (${c.name}): ${state}\n  ${c.detail}`;
    })
    .join("\n");
}
