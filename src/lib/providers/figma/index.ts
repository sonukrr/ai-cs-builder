import type { FigmaProvider } from "./types";
import { FigmaMcpProvider } from "./mcp";
import { credentialsPath, needsAuth } from "./mcp-auth";
import { FigmaRestProvider } from "./rest";
import { FigmaMockProvider } from "./mock";

export * from "./types";
export { summarizeDesign } from "./summarize";

/**
 * The desktop app's Dev Mode server. Kept as the default because it needs no
 * credentials; set FIGMA_MCP_URL=https://mcp.figma.com/mcp to use Figma's
 * hosted server instead, which works without the desktop app.
 */
const DEFAULT_MCP_URL = "http://127.0.0.1:3845/mcp";

/**
 * Chooses a Figma backend from the environment.
 *
 * Explicit configuration always wins, so a misconfigured MCP server surfaces as
 * an error the admin can act on rather than silently degrading to demo data.
 * Only the unset case falls through to the mock.
 */
export function getFigmaProvider(): FigmaProvider {
  const configured = (process.env.FIGMA_PROVIDER ?? "").toLowerCase();

  switch (configured) {
    case "mcp":
      return new FigmaMcpProvider(process.env.FIGMA_MCP_URL ?? DEFAULT_MCP_URL);
    case "rest":
      return new FigmaRestProvider(process.env.FIGMA_TOKEN ?? "");
    case "mock":
      return new FigmaMockProvider(process.env.FIGMA_FIXTURE);
    default:
      if (process.env.FIGMA_TOKEN) return new FigmaRestProvider(process.env.FIGMA_TOKEN);
      return new FigmaMockProvider(process.env.FIGMA_FIXTURE);
  }
}

export interface FigmaStatus {
  backend: "mcp" | "rest" | "mock";
  ready: boolean;
  detail: string;
  /**
   * Which MCP server the `mcp` backend points at. The two have completely
   * different prerequisites — the desktop app versus an OAuth token — so
   * anything that reports requirements to an admin has to tell them apart.
   */
  transport?: "desktop" | "hosted";
}

/**
 * Reported to the studio so the UI can say what the import will actually use.
 *
 * The MCP case is asynchronous in spirit — whether a hosted server has a usable
 * token is only knowable by reading the credential store — but this stays
 * synchronous for its callers, so it reports how the token *will* be sourced
 * rather than pretending to have verified it.
 */
export function figmaStatus(): FigmaStatus {
  const provider = getFigmaProvider();
  switch (provider.backend) {
    case "mcp": {
      const url = process.env.FIGMA_MCP_URL ?? DEFAULT_MCP_URL;
      if (!needsAuth(url)) {
        return {
          backend: "mcp",
          ready: true,
          transport: "desktop",
          detail: `Figma Dev Mode MCP at ${url}. Open the file in the Figma desktop app before importing.`,
        };
      }
      return {
        backend: "mcp",
        ready: true,
        transport: "hosted",
        detail: process.env.FIGMA_MCP_TOKEN
          ? `Figma hosted MCP at ${url}, using the OAuth token in FIGMA_MCP_TOKEN.`
          : `Figma hosted MCP at ${url}, using the OAuth token cached by Claude Code in ${credentialsPath()}. No desktop app needed.`,
      };
    }
    case "rest":
      return {
        backend: "rest",
        ready: Boolean(process.env.FIGMA_TOKEN),
        detail: process.env.FIGMA_TOKEN
          ? "Figma REST API with a personal access token."
          : "FIGMA_PROVIDER=rest but FIGMA_TOKEN is not set.",
      };
    default:
      return {
        backend: "mock",
        ready: true,
        detail: "Built-in demo design. Set FIGMA_PROVIDER=mcp or =rest to import a real file.",
      };
  }
}
