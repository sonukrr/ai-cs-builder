import { existsSync } from "node:fs";
import { figmaStatus } from "@/lib/providers/figma";
import { baseSiteStatus } from "@/lib/providers/github";
import { getStockProvider } from "@/lib/providers/images/stock";
import { researchStatus } from "@/lib/providers/research";
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

/**
 * Whether the preview can actually be screenshotted.
 *
 * The capture drives the Chrome already on the machine rather than downloading
 * one, so its readiness is a property of the host. Whether the preview host is
 * *running* cannot be settled without trying it, and this is called on every
 * capability request — so the binary is what is checked here, and a preview
 * nobody started surfaces later as `capture.unavailable` on the report itself.
 */
function captureStatus(): { ready: boolean; detail: string } {
  const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
  const previewOrigin = process.env.PREVIEW_ORIGIN ?? "http://localhost:4200";

  return existsSync(chromePath)
    ? {
        ready: true,
        detail: `Screenshots are taken by driving ${chromePath} against the preview at ${previewOrigin}. If the preview host is not running the report still opens, saying so instead of showing images.`,
      }
    : {
        ready: false,
        detail: `No browser to screenshot with at ${chromePath} (set CHROME_PATH). The comparison still runs — coverage, order and tokens are exact and need no images — but the administrator will approve without seeing the two side by side.`,
      };
}

export function capabilities(): Capability[] {
  const figma = figmaStatus();
  const capture = captureStatus();
  const base = baseSiteStatus();
  const stock = getStockProvider();
  const research = researchStatus();

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
      id: "DESIGN_FIDELITY",
      name: "Review an imported site against its design",
      description:
        "After an imported plan is built, compares the site back against the Figma design band by band — coverage, order and tokens exactly, visual similarity as evidence — and holds the project in review until an administrator approves the comparison. Approval is always the administrator's; the agent can only run the check and fix what it finds.",
      // Two halves, and only one of them can be demonstrated on stand-in data:
      // the mock design compares fine, but a screenshot of the preview is only
      // as real as the design it is being held against. So the mock backend is
      // demo rather than ready even when the capture works perfectly.
      state:
        figma.backend === "mock"
          ? "demo"
          : figma.ready && capture.ready
            ? "ready"
            : "needs-config",
      detail:
        figma.backend === "mock"
          ? `The demo design is compared against the built site for real; only the design is a stand-in. ${capture.detail}`
          : figma.ready
            ? capture.detail
            : `${figma.detail} Without a real design there is nothing to compare against.`,
      requires: [
        "FIGMA_PROVIDER=mcp or =rest (a real design to compare against)",
        "CHROME_PATH (a browser to screenshot the preview with; the visual evidence only)",
        "PREVIEW_ORIGIN, running",
      ],
      tools: ["review_fidelity", "get_fidelity_report"],
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
      name: "Research the company and the web",
      description:
        "Finds what a company actually hires for and loads those roles into the preview, so filters and listings show something recognisable instead of generic samples. On explicit request, also summarises another career site's structural patterns — as an original plan, never copied markup or content.",
      // Both backends work; they differ in what comes back. Tavily hands the
      // page text to this process, so a researched dataset can name the URL it
      // came from. The built-in search cannot, which is a real difference to an
      // administrator deciding whether to trust the roles on screen.
      state: research.backend === "tavily" ? "ready" : research.backend === "builtin" ? "demo" : "needs-config",
      detail: research.detail,
      requires:
        research.backend === "off"
          ? ["ENABLE_RESEARCH=true"]
          : ["TAVILY_API_KEY (for research whose sources can be cited)"],
      tools:
        research.backend === "tavily"
          ? ["research_web", "read_web_page", "get_job_data", "set_job_data"]
          : research.backend === "builtin"
            ? ["web_search", "get_job_data", "set_job_data"]
            : ["get_job_data", "set_job_data"],
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
