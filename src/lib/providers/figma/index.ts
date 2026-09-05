import type { FigmaProvider } from "./types";
import { FigmaMcpProvider } from "./mcp";
import { FigmaRestProvider } from "./rest";
import { FigmaMockProvider } from "./mock";

export * from "./types";
export { summarizeDesign } from "./summarize";

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
      return new FigmaMcpProvider(process.env.FIGMA_MCP_URL ?? "http://127.0.0.1:3845/mcp");
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
}

/** Reported to the studio so the UI can say what the import will actually use. */
export function figmaStatus(): FigmaStatus {
  const provider = getFigmaProvider();
  switch (provider.backend) {
    case "mcp":
      return {
        backend: "mcp",
        ready: true,
        detail: `Figma Dev Mode MCP at ${process.env.FIGMA_MCP_URL ?? "http://127.0.0.1:3845/mcp"}. Open the file in the Figma desktop app before importing.`,
      };
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
