import { promises as fs } from "node:fs";
import path from "node:path";
import { mediaKindOf, type MediaKind } from "../shared/media";
import type { MediaEntry } from "../shared/rpc";
import { refOf, type MediaHost } from "./hosts";

/** Folder names never worth scanning for media. Hidden folders are skipped as well. */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "venv", "site-packages", "target", "Pods"]);

export interface ScannedFile {
  path: string;
  kind: MediaKind;
  size: number;
  mtimeMs: number;
}

interface ScanOptions {
  maxEntries?: number;
  maxDepth?: number;
  budgetMs?: number;
}

/**
 * Media files under `root` on the daemon host, breadth first, within a budget so a huge repository
 * costs a bounded amount of time. `truncated` says the budget ran out before every folder was read.
 */
export async function scanMedia(root: string, options: ScanOptions = {}): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const { maxEntries = 20_000, maxDepth = 8, budgetMs = 2000 } = options;
  const deadline = Date.now() + budgetMs;
  const files: ScannedFile[] = [];
  let seen = 0;
  let queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  // Folders already read, by real path: a linked folder is followed once, and a link loop ends.
  const visited = new Set<string>([await fs.realpath(root).catch(() => root)]);
  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const { dir, depth } of queue) {
      if (seen >= maxEntries || Date.now() > deadline) return { files, truncated: true };
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      seen += entries.length;
      const statTasks: Promise<void>[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth + 1 <= maxDepth && !SKIPPED_DIRS.has(entry.name)) next.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (entry.isSymbolicLink()) {
          // Footage is often linked in from a shared drive; follow links to files and folders.
          statTasks.push(
            fs.stat(full).then(
              async (stats) => {
                if (stats.isDirectory()) {
                  if (depth + 1 > maxDepth || SKIPPED_DIRS.has(entry.name)) return;
                  const real = await fs.realpath(full).catch(() => full);
                  if (visited.has(real)) return;
                  visited.add(real);
                  next.push({ dir: full, depth: depth + 1 });
                  return;
                }
                const kind = stats.isFile() ? mediaKindOf(entry.name) : null;
                if (kind) files.push({ path: full, kind, size: stats.size, mtimeMs: stats.mtimeMs });
              },
              () => undefined,
            ),
          );
          continue;
        }
        if (!entry.isFile()) continue;
        const kind = mediaKindOf(entry.name);
        if (!kind) continue;
        statTasks.push(
          fs.stat(full).then(
            (stats) => {
              files.push({ path: full, kind, size: stats.size, mtimeMs: stats.mtimeMs });
            },
            () => undefined,
          ),
        );
      }
      await Promise.all(statTasks);
    }
    queue = next;
  }
  return { files, truncated: false };
}

export async function listRecent(host: MediaHost, root: string, limit: number): Promise<{ entries: MediaEntry[]; truncated: boolean }> {
  const { files, truncated } = await host.scan(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    truncated: truncated || files.length > limit,
    entries: files.slice(0, limit).map((file) => ({
      path: refOf(host, file.path),
      name: path.basename(file.path),
      kind: file.kind,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    })),
  };
}

export async function listFolder(host: MediaHost, dir: string, limit: number): Promise<{ entries: MediaEntry[]; truncated: boolean }> {
  const result: MediaEntry[] = [];
  for (const entry of await host.listDir(dir)) {
    const kind = entry.isDirectory ? "directory" : mediaKindOf(entry.name);
    if (!kind) continue;
    result.push({
      path: refOf(host, path.posix.join(dir, entry.name)),
      name: entry.name,
      kind,
      size: entry.isDirectory ? 0 : entry.size,
      modifiedAt: new Date(entry.mtimeMs).toISOString(),
    });
  }
  result.sort((a, b) => {
    if ((a.kind === "directory") !== (b.kind === "directory")) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { entries: result.slice(0, limit), truncated: result.length > limit };
}

/** A file name the user can type: no folders, no control characters, not `.` or `..`. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f/\\]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(`Invalid file name: ${name}`);
  return cleaned;
}

/** `dir/name`, or `dir/name (2).ext` and so on when that already exists. */
export async function uniquePath(host: MediaHost, dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.posix.join(dir, index === 1 ? name : `${stem} (${index})${ext}`);
    if (!(await host.stat(candidate))) return candidate;
  }
  throw new Error(`Too many files named ${name}`);
}
