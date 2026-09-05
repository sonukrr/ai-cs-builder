import {
  type BaseSiteContext,
  type BaseSiteFile,
  type BaseSiteProvider,
  PROTECTED_BRANCHES,
  isWritable,
} from "./types";
import { GitHubRestProvider } from "./rest";

export * from "./types";

/**
 * Stand-in for the approved base repository.
 *
 * The base repo link is supplied later, so this models the shape one is
 * expected to have — the config trio from 07-base-site-flow.md plus a component
 * library — and lets the START_FROM_BASE flow be built and demoed now. Point
 * BASE_SITE_REPO at the real repository and the REST backend takes over with
 * no other change.
 */
class BaseSiteMockProvider implements BaseSiteProvider {
  readonly backend = "mock" as const;
  readonly configured = true;

  async readContext(repo: string): Promise<BaseSiteContext> {
    return {
      repo: repo || "example-org/career-site-base",
      defaultBranch: "main",
      framework: "next",
      keyFiles: [],
      readme: [
        "# Career Site Base",
        "",
        "The approved starting point for company career sites.",
        "",
        "Customisation happens through `config/*.json`. React source is off limits",
        "to the builder — new presentation needs are met by composing the existing",
        "components, and new functional needs by the approved component library.",
      ].join("\n"),
      tree: [
        "README.md",
        "config/site.json",
        "config/theme.json",
        "config/content.json",
        "src/app/page.tsx",
        "src/app/jobs/page.tsx",
        "src/app/jobs/[id]/page.tsx",
        "src/app/teams/page.tsx",
        "src/components/Hero.tsx",
        "src/components/Nav.tsx",
        "src/components/Footer.tsx",
        "src/components/Benefits.tsx",
        "src/components/EmployeeStories.tsx",
        "src/components/Cta.tsx",
        "src/components/Stats.tsx",
      ],
      config: [
        {
          path: "config/site.json",
          content: JSON.stringify(
            { name: "Base Careers", pages: ["/", "/jobs", "/jobs/[id]", "/teams"] },
            null,
            2,
          ),
        },
        {
          path: "config/theme.json",
          content: JSON.stringify(
            { primary: "#111111", secondary: "#666666", radius: 8, font: "Inter" },
            null,
            2,
          ),
        },
        { path: "config/content.json", content: JSON.stringify({ sections: {} }, null, 2) },
      ],
      components: [
        { name: "Hero", path: "src/components/Hero.tsx" },
        { name: "Nav", path: "src/components/Nav.tsx" },
        { name: "Footer", path: "src/components/Footer.tsx" },
        { name: "Benefits", path: "src/components/Benefits.tsx" },
        { name: "EmployeeStories", path: "src/components/EmployeeStories.tsx" },
        { name: "Cta", path: "src/components/Cta.tsx" },
        { name: "Stats", path: "src/components/Stats.tsx" },
      ],
      pages: [
        { name: "Home", path: "/" },
        { name: "jobs", path: "/jobs" },
        { name: "jobs/[id]", path: "/jobs/[id]" },
        { name: "teams", path: "/teams" },
      ],
      warnings: [
        "This is a stand-in base site. Set BASE_SITE_REPO and GITHUB_TOKEN to read the real repository.",
      ],
    };
  }

  async createBranch(repo: string, branch: string) {
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(`Refusing to create over the protected branch "${branch}"`);
    }
    return { branch, url: `https://github.com/${repo || "example-org/career-site-base"}/tree/${branch}` };
  }

  async commitFiles(repo: string, branch: string, files: BaseSiteFile[]) {
    if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
      throw new Error(`Refusing to commit to the protected branch "${branch}"`);
    }
    const blocked = files.filter((f) => !isWritable(f.path));
    if (blocked.length > 0) {
      throw new Error(
        `Refusing to write outside the approved configuration surface: ${blocked.map((f) => f.path).join(", ")}`,
      );
    }
    return { commitUrl: "", files: files.map((f) => f.path) };
  }
}

export function getBaseSiteProvider(): BaseSiteProvider {
  const configured = (process.env.GITHUB_PROVIDER ?? "").toLowerCase();
  if (configured === "rest" || (configured !== "mock" && process.env.GITHUB_TOKEN)) {
    return new GitHubRestProvider(process.env.GITHUB_TOKEN ?? "");
  }
  return new BaseSiteMockProvider();
}

/** The repository the base flow reads. Empty until one is supplied. */
export function baseSiteRepo(): string {
  return process.env.BASE_SITE_REPO ?? "";
}

export interface BaseSiteStatus {
  backend: string;
  ready: boolean;
  repo: string;
  detail: string;
}

export function baseSiteStatus(): BaseSiteStatus {
  const provider = getBaseSiteProvider();
  const repo = baseSiteRepo();

  if (provider.backend === "mock") {
    return {
      backend: "mock",
      ready: true,
      repo: repo || "example-org/career-site-base",
      detail:
        "Using a stand-in base repository. Set BASE_SITE_REPO and GITHUB_TOKEN to read the approved one.",
    };
  }

  return {
    backend: provider.backend,
    ready: Boolean(repo),
    repo,
    detail: repo
      ? `Reading ${repo} through the GitHub API.`
      : "GITHUB_TOKEN is set but BASE_SITE_REPO is not — supply the approved base repository link.",
  };
}
