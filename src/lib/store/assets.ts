import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Storage for images a company uploads.
 *
 * This is the "hosting" half of the imagery capability: without it the agent
 * can only ever reference someone else's photographs. Uploads live beside the
 * project's other state and are served back by
 * /api/projects/[projectId]/assets/[file].
 *
 * Files are content-addressed, so re-uploading the same photo is idempotent and
 * a blueprint's image URLs stay valid across edits.
 *
 * Local disk here, matching the rest of the store; production would swap this
 * module for object storage and nothing else would change.
 */

const ROOT = process.env.STUDIO_DATA_DIR ?? path.join(process.cwd(), ".data", "projects");

/** Raster and vector formats a career site actually uses. */
const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface StoredAsset {
  /** Filename on disk, and the last path segment of its URL. */
  file: string;
  url: string;
  contentType: string;
  bytes: number;
  /** Admin-supplied description, kept for the `alt` attribute. */
  alt: string;
  uploadedAt: string;
}

interface AssetIndex {
  [file: string]: { contentType: string; bytes: number; alt: string; uploadedAt: string };
}

function assetDir(projectId: string): string {
  return path.join(ROOT, projectId, "assets");
}

function indexPath(projectId: string): string {
  return path.join(assetDir(projectId), "index.json");
}

async function readIndex(projectId: string): Promise<AssetIndex> {
  try {
    return JSON.parse(await readFile(indexPath(projectId), "utf8")) as AssetIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function assetUrl(projectId: string, file: string): string {
  return `/api/projects/${projectId}/assets/${file}`;
}

export const assets = {
  isAllowed(contentType: string): boolean {
    return contentType in ALLOWED;
  },

  allowedTypes(): string[] {
    return Object.keys(ALLOWED);
  },

  async save(
    projectId: string,
    input: { data: Uint8Array; contentType: string; alt?: string },
  ): Promise<StoredAsset> {
    const extension = ALLOWED[input.contentType];
    if (!extension) {
      throw new Error(
        `${input.contentType} is not a supported image type. Use one of: ${Object.keys(ALLOWED).join(", ")}`,
      );
    }
    if (input.data.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`Image is ${Math.round(input.data.byteLength / 1024)}KB; the limit is 8MB.`);
    }

    // Content-addressed: the same bytes always land on the same URL.
    const digest = createHash("sha256").update(input.data).digest("hex").slice(0, 16);
    const file = `${digest}.${extension}`;

    const dir = assetDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), input.data);

    const index = await readIndex(projectId);
    const record = {
      contentType: input.contentType,
      bytes: input.data.byteLength,
      alt: input.alt ?? index[file]?.alt ?? "",
      uploadedAt: index[file]?.uploadedAt ?? new Date().toISOString(),
    };
    index[file] = record;
    await writeFile(indexPath(projectId), JSON.stringify(index, null, 2), "utf8");

    return { file, url: assetUrl(projectId, file), ...record };
  },

  async list(projectId: string): Promise<StoredAsset[]> {
    const index = await readIndex(projectId);
    return Object.entries(index)
      .map(([file, record]) => ({ file, url: assetUrl(projectId, file), ...record }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  },

  /**
   * Reads one asset for serving.
   *
   * The filename is validated rather than trusted: it reaches this function
   * from a URL path, and a `..` segment would otherwise read anything on disk.
   */
  async read(
    projectId: string,
    file: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    if (!/^[0-9a-f]{16}\.(jpg|png|webp|avif|gif|svg)$/.test(file)) return null;

    const full = path.join(assetDir(projectId), file);
    // Belt and braces: confirm the resolved path is still inside the project.
    if (!path.resolve(full).startsWith(path.resolve(assetDir(projectId)) + path.sep)) return null;

    try {
      const [data, index] = await Promise.all([readFile(full), readIndex(projectId)]);
      await stat(full);
      return { data, contentType: index[file]?.contentType ?? "application/octet-stream" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async describe(projectId: string, file: string, alt: string): Promise<void> {
    const index = await readIndex(projectId);
    if (!index[file]) throw new Error(`No asset ${file}`);
    index[file].alt = alt;
    await writeFile(indexPath(projectId), JSON.stringify(index, null, 2), "utf8");
  },

  /** Bytes currently stored, so the studio can show usage. */
  async totalBytes(projectId: string): Promise<number> {
    try {
      const files = await readdir(assetDir(projectId));
      const sizes = await Promise.all(
        files
          .filter((f) => f !== "index.json")
          .map(async (f) => (await stat(path.join(assetDir(projectId), f))).size),
      );
      return sizes.reduce((total, size) => total + size, 0);
    } catch {
      return 0;
    }
  },
};
