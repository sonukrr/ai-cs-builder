import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Blueprint,
  BlueprintVersion,
  Project,
  PublishRequest,
} from "@/lib/blueprint/schema";
import type { SitePlan } from "@/lib/agent/analyze";
import type { DesignDocument, DesignNode } from "@/lib/providers/figma/types";

/**
 * File-backed persistence.
 *
 * 02-architecture.md names Supabase/Postgres for production. This implements
 * the same interface against the filesystem so the MVP runs with no external
 * service: one directory per project, one JSON file per version. Swapping in
 * Postgres means reimplementing this module and nothing else — no other file
 * imports `node:fs`.
 */

const ROOT = process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), ".data", "projects");

async function projectDir(projectId: string): Promise<string> {
  const dir = path.join(ROOT, projectId);
  await mkdir(path.join(dir, "versions"), { recursive: true });
  return dir;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
  /** Tool calls made while producing this turn, for the activity timeline. */
  activity?: { tool: string; summary: string }[];
}

/**
 * How much of a Figma document is kept on disk.
 *
 * The design is persisted so the agent can author an HTML/CSS replica of a band
 * from the real geometry rather than from a label — see `saveDesign`. A real
 * Figma file is tens of thousands of nodes, most of which describe nothing you
 * could see, so writing it whole would put tens of megabytes per project on
 * disk to no purpose. Everything a replica needs survives the trim; what is
 * dropped is listed on `trimDesign` below.
 */
const DESIGN_MAX_DEPTH = 10;
const DESIGN_MIN_DEPTH = 3;
const DESIGN_MAX_CHILDREN = 48;
const DESIGN_MAX_TEXT = 400;
const DESIGN_MAX_FILLS = 3;
/** Nodes kept per document before the depth limit is tightened and retried. */
const DESIGN_NODE_BUDGET = 6000;

function trimNode(
  node: DesignNode,
  depth: number,
  maxDepth: number,
  count: { n: number },
): DesignNode | null {
  // A node with no area cannot be seen, so it cannot be replicated.
  if (node.bounds.width < 1 || node.bounds.height < 1) return null;

  const children: DesignNode[] = [];
  if (depth < maxDepth) {
    // Past the first few dozen siblings a repeated grid is repeating itself;
    // the ones kept already establish the pattern the replica has to match.
    for (const child of (node.children ?? []).slice(0, DESIGN_MAX_CHILDREN)) {
      const kept = trimNode(child, depth + 1, maxDepth, count);
      if (kept) children.push(kept);
    }
  }

  const text = node.text?.trim().slice(0, DESIGN_MAX_TEXT);
  const fills = node.fills?.slice(0, DESIGN_MAX_FILLS);
  const carries =
    Boolean(text) ||
    (fills?.length ?? 0) > 0 ||
    node.imageUrl !== undefined ||
    node.componentName !== undefined ||
    (node.cornerRadius ?? 0) > 0;

  // A childless node with no paint, no copy and no image is a spacer, a hit
  // area or an empty group. Keeping it would cost bytes and teach nothing.
  if (children.length === 0 && !carries) return null;

  count.n += 1;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    // Sub-pixel coordinates are noise at CSS resolution and roughly double the
    // size of every number written.
    bounds: {
      x: Math.round(node.bounds.x),
      y: Math.round(node.bounds.y),
      width: Math.round(node.bounds.width),
      height: Math.round(node.bounds.height),
    },
    ...(text ? { text } : {}),
    ...(fills && fills.length > 0 ? { fills } : {}),
    ...(node.fontFamily ? { fontFamily: node.fontFamily } : {}),
    ...(node.fontSize ? { fontSize: Math.round(node.fontSize) } : {}),
    ...(node.fontWeight ? { fontWeight: node.fontWeight } : {}),
    ...(node.cornerRadius ? { cornerRadius: Math.round(node.cornerRadius) } : {}),
    ...(node.imageUrl ? { imageUrl: node.imageUrl } : {}),
    ...(node.componentName ? { componentName: node.componentName } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * What is dropped, and why:
 *
 * - zero-area nodes, and childless nodes with no fill, text, image, radius or
 *   component name — nothing about them is visible, so nothing about them can
 *   be replicated;
 * - siblings past the 48th under one parent, which are a repeated grid
 *   repeating itself;
 * - everything below depth 10, tightened further only if the document is still
 *   over budget, in which case a warning records the depth actually kept;
 * - fills past the third on one node, and copy past 400 characters;
 * - sub-pixel coordinate precision.
 *
 * Nothing else is touched: `bounds`, `fills`, `fontFamily`, `fontSize`,
 * `fontWeight`, `cornerRadius`, `text`, `imageUrl` and `componentName` are the
 * whole vocabulary a replica is authored from, and `styles`/`images` are what
 * the fidelity review reads.
 */
function trimDesign(design: DesignDocument): DesignDocument {
  let maxDepth = DESIGN_MAX_DEPTH;
  let frames: DesignDocument["frames"] = [];
  let count = { n: 0 };

  // Depth is reduced rather than nodes truncated, because cutting a document
  // off part-way through leaves later bands with nothing at all while the
  // first band keeps detail nobody asked for.
  while (true) {
    count = { n: 0 };
    frames = design.frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      bounds: {
        x: Math.round(frame.bounds.x),
        y: Math.round(frame.bounds.y),
        width: Math.round(frame.bounds.width),
        height: Math.round(frame.bounds.height),
      },
      children: frame.children
        .map((child) => trimNode(child, 1, maxDepth, count))
        .filter((child): child is DesignNode => child !== null),
    }));
    if (count.n <= DESIGN_NODE_BUDGET || maxDepth <= DESIGN_MIN_DEPTH) break;
    maxDepth -= 1;
  }

  const warnings = [...design.warnings];
  if (maxDepth < DESIGN_MAX_DEPTH) {
    warnings.push(
      `Design detail was kept to ${maxDepth} levels deep (${count.n} nodes) because the file is very large; a replica of a deeply nested band may be missing its innermost detail.`,
    );
  }

  return { ...design, frames, warnings };
}

export const store = {
  async createProject(input: {
    name: string;
    entryPoint: Project["entryPoint"];
    sourceRef?: string;
  }): Promise<Project> {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      entryPoint: input.entryPoint,
      sourceRef: input.sourceRef ?? "",
      status: "planning",
      currentVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(path.join(await projectDir(project.id), "project.json"), project);
    return project;
  },

  async getProject(projectId: string): Promise<Project | null> {
    return readJson<Project>(path.join(ROOT, projectId, "project.json"));
  },

  async listProjects(): Promise<Project[]> {
    try {
      const ids = await readdir(ROOT);
      const projects = await Promise.all(ids.map((id) => store.getProject(id)));
      return projects
        .filter((p): p is Project => p !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },

  async updateProject(projectId: string, patch: Partial<Project>): Promise<Project> {
    const existing = await store.getProject(projectId);
    if (!existing) throw new Error(`No project ${projectId}`);
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    await writeJson(path.join(await projectDir(projectId), "project.json"), updated);
    return updated;
  },

  /** The pending site plan, held between analysis and admin approval. */
  async savePlan(projectId: string, plan: SitePlan, meta: Record<string, unknown> = {}): Promise<void> {
    await writeJson(path.join(await projectDir(projectId), "plan.json"), { plan, meta });
  },

  async getPlan(
    projectId: string,
  ): Promise<{ plan: SitePlan; meta: Record<string, unknown> } | null> {
    return readJson(path.join(ROOT, projectId, "plan.json"));
  },

  /**
   * The imported design itself, kept so a band can be replicated rather than
   * approximated.
   *
   * The plan's meta already carries `summarizeDesign(design)`, which throws
   * geometry away on purpose — it exists to decide what a band *is*. Deciding
   * what a band *looks like* needs the opposite: bounds, fills, type and corner
   * radii. So the document is stored alongside the summary rather than instead
   * of it, trimmed by `trimDesign` because a real file is far too large to keep
   * whole.
   */
  async saveDesign(projectId: string, design: DesignDocument): Promise<void> {
    await writeJson(path.join(await projectDir(projectId), "design.json"), trimDesign(design));
  },

  async getDesign(projectId: string): Promise<DesignDocument | null> {
    return readJson<DesignDocument>(path.join(ROOT, projectId, "design.json"));
  },

  /**
   * Commits a new version.
   *
   * Versions are append-only and numbered from 1. Nothing overwrites a version
   * once written, which is what makes undo and the change history trustworthy.
   */
  async saveVersion(
    projectId: string,
    input: { blueprint: Blueprint; summary: string; operations?: Record<string, unknown>[] },
  ): Promise<BlueprintVersion> {
    const project = await store.getProject(projectId);
    if (!project) throw new Error(`No project ${projectId}`);

    const version = project.currentVersion + 1;
    const record: BlueprintVersion = {
      version,
      createdAt: new Date().toISOString(),
      summary: input.summary,
      operations: input.operations ?? [],
      blueprint: { ...input.blueprint, version },
      previewUrl: "",
      branch: "",
    };

    const dir = await projectDir(projectId);
    await writeJson(path.join(dir, "versions", `${version}.json`), record);
    await store.updateProject(projectId, { currentVersion: version });
    return record;
  },

  async getVersion(projectId: string, version: number): Promise<BlueprintVersion | null> {
    return readJson<BlueprintVersion>(path.join(ROOT, projectId, "versions", `${version}.json`));
  },

  async getCurrentBlueprint(projectId: string): Promise<Blueprint | null> {
    const project = await store.getProject(projectId);
    if (!project || project.currentVersion === 0) return null;
    const record = await store.getVersion(projectId, project.currentVersion);
    return record?.blueprint ?? null;
  },

  async listVersions(projectId: string): Promise<BlueprintVersion[]> {
    try {
      const files = await readdir(path.join(ROOT, projectId, "versions"));
      const records = await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => readJson<BlueprintVersion>(path.join(ROOT, projectId, "versions", f))),
      );
      return records
        .filter((r): r is BlueprintVersion => r !== null)
        .sort((a, b) => b.version - a.version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },

  /**
   * Undo — reverts to a previous version by writing it forward as a new one.
   *
   * Rolling back by deleting versions would make history lie about what
   * happened. Replaying the old blueprint as version N+1 keeps the record
   * honest and keeps undo itself undoable.
   */
  async revertTo(projectId: string, version: number): Promise<BlueprintVersion> {
    const target = await store.getVersion(projectId, version);
    if (!target) throw new Error(`No version ${version}`);
    return store.saveVersion(projectId, {
      blueprint: target.blueprint,
      summary: `Reverted to version ${version}`,
      operations: [{ op: "revert", toVersion: version }],
    });
  },

  async appendTurn(projectId: string, turn: ConversationTurn): Promise<void> {
    const file = path.join(await projectDir(projectId), "conversation.json");
    const existing = (await readJson<ConversationTurn[]>(file)) ?? [];
    existing.push(turn);
    await writeJson(file, existing);
  },

  async getConversation(projectId: string): Promise<ConversationTurn[]> {
    return (await readJson<ConversationTurn[]>(path.join(ROOT, projectId, "conversation.json"))) ?? [];
  },

  async createPublishRequest(input: {
    projectId: string;
    version: number;
    requestedBy: string;
    changeSummary: string;
    notes?: string;
  }): Promise<PublishRequest> {
    const request: PublishRequest = {
      id: randomUUID(),
      projectId: input.projectId,
      version: input.version,
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      status: "pending",
      changeSummary: input.changeSummary,
      notes: input.notes ?? "",
    };
    const file = path.join(await projectDir(input.projectId), "publish-requests.json");
    const existing = (await readJson<PublishRequest[]>(file)) ?? [];
    existing.push(request);
    await writeJson(file, existing);
    await store.updateProject(input.projectId, { status: "publish-requested" });
    return request;
  },

  async listPublishRequests(projectId: string): Promise<PublishRequest[]> {
    return (
      (await readJson<PublishRequest[]>(path.join(ROOT, projectId, "publish-requests.json"))) ?? []
    );
  },
};
