import { GitHubRestDeployProvider, MockDeployProvider, type DeployTargetProvider } from "./deploy";
import { DEFAULT_GITHUB_MCP_URL, GitHubMcpDeployProvider } from "./deploy-mcp";
import { gitHubMcpCredentialState } from "./mcp-auth";

/**
 * Which GitHub backend a publish uses, and whether it can actually push.
 *
 * A separate module from `deploy.ts` and `deploy-mcp.ts` only so that neither
 * of those has to import the other: the MCP backend delegates to the REST one
 * for binary files and repository state, and the factory has to know about
 * both.
 *
 * The order of preference is the administrator's stated intent first
 * (GITHUB_DEPLOY_PROVIDER, then GITHUB_PROVIDER), then whatever is actually
 * configured, and a stand-in last — so a deployment with no credentials
 * demonstrates the whole flow and says plainly that it pushed nothing, rather
 * than presenting an unavailable button.
 */

export type DeployBackend = "mcp" | "rest" | "mock";

function requested(): DeployBackend | "" {
  const value = (process.env.GITHUB_DEPLOY_PROVIDER ?? process.env.GITHUB_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  return value === "mcp" || value === "rest" || value === "mock" ? value : "";
}

function mcpUrl(): string {
  return (process.env.GITHUB_MCP_URL ?? "").trim() || DEFAULT_GITHUB_MCP_URL;
}

/**
 * The token handed to the backends at construction.
 *
 * This is the *personal access token* half only. The MCP backend resolves its
 * own bearer per connection — it may be a cached OAuth credential that expires
 * — and uses this one for the REST work MCP cannot do: binary files and reading
 * repository state. See `mcp-auth.ts`.
 */
function token(): string {
  // Either variable, because both are set by hand and are therefore personal
  // access tokens. The one credential that must never be used here is the
  // cached OAuth token: it is minted for the MCP resource and GitHub's git data
  // API may accept nothing it carries.
  return (process.env.GITHUB_TOKEN ?? process.env.GITHUB_MCP_TOKEN ?? "").trim();
}

export function getDeployTargetProvider(): DeployTargetProvider {
  const choice = requested();

  if (choice === "mock") return new MockDeployProvider();
  if (choice === "mcp") return new GitHubMcpDeployProvider({ url: mcpUrl(), token: token() });
  if (choice === "rest") {
    return token() ? new GitHubRestDeployProvider(token()) : new MockDeployProvider();
  }

  // Nothing was asked for: an explicit MCP URL is a statement of intent, and
  // otherwise a token is all the REST backend needs.
  if (process.env.GITHUB_MCP_URL?.trim()) {
    return new GitHubMcpDeployProvider({ url: mcpUrl(), token: token() });
  }
  return token() ? new GitHubRestDeployProvider(token()) : new MockDeployProvider();
}

export interface DeployTargetStatus {
  backend: DeployBackend;
  /** Can a real push happen. */
  ready: boolean;
  detail: string;
  requires: string[];
}

export function deployTargetStatus(): DeployTargetStatus {
  const provider = getDeployTargetProvider();

  if (provider.backend === "mock") {
    return {
      backend: "mock",
      ready: false,
      detail:
        "No GitHub credentials, so a publish generates and checks the site but pushes nothing. Set GITHUB_TOKEN (contents: read/write on the destination repository), or GITHUB_MCP_URL to push through a GitHub MCP server.",
      requires: ["GITHUB_TOKEN, or GITHUB_MCP_URL with GITHUB_MCP_TOKEN"],
    };
  }

  if (provider.backend === "mcp") {
    const credential = gitHubMcpCredentialState(mcpUrl());
    return {
      backend: "mcp",
      // A backend that cannot authenticate is not ready, however configured it
      // looks: the publish would get as far as the first tool call and stop.
      ready: credential.available,
      detail: [
        `Pushing through the GitHub MCP server at ${mcpUrl()}.`,
        credential.detail,
        token()
          ? ""
          : "No personal access token is set, so images cannot be pushed and stale files cannot be removed — the MCP server's file tools take text only. Set GITHUB_TOKEN.",
      ]
        .filter(Boolean)
        .join(" "),
      requires: [
        "An authorised github MCP server (claude mcp add + /mcp), or GITHUB_MCP_TOKEN",
        "GITHUB_TOKEN, for the images MCP cannot push",
      ],
    };
  }

  return {
    backend: "rest",
    ready: true,
    detail:
      "Pushing through the GitHub API with GITHUB_TOKEN. The token needs contents: read/write on the destination repository, and repository creation rights if the studio is to create it.",
    requires: ["GITHUB_TOKEN"],
  };
}
