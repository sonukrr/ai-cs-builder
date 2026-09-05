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
