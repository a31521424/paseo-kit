import { promises as fs } from "node:fs";
import path from "node:path";
import { MIN_TRANSPORT_STREAM_BYTES, TRANSPORT_STREAM_HEAD_BYTES, isAmbiguousMedia, looksLikeTransportStream, mediaKindOf, type MediaKind } from "../shared/media";
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

/**
 * Drops `.ts` and `.mts` files that are source code rather than transport streams: small ones
 * outright, the rest by their first bytes. Other files pass untouched.
 */
export async function dropSourceCode<T>(
  items: T[],
  fileOf: (item: T) => { path: string; size: number } | null,
  readHead: (file: string, length: number) => Promise<Uint8Array>,
): Promise<T[]> {
  const verdicts = items.map(() => true);
  const pending: number[] = [];
  items.forEach((item, index) => {
    const file = fileOf(item);
    if (!file || !isAmbiguousMedia(file.path)) return;
    if (file.size < MIN_TRANSPORT_STREAM_BYTES) verdicts[index] = false;
    else pending.push(index);
  });
  // A few reads at a time: on an SSH host each one is a command over the shared connection.
  const worker = async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      const head = await readHead(fileOf(items[index]!)!.path, TRANSPORT_STREAM_HEAD_BYTES).catch(() => new Uint8Array(0));
      verdicts[index] = looksLikeTransportStream(head);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return items.filter((_, index) => verdicts[index]);
}

async function readLocalHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
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
      if (seen >= maxEntries || Date.now() > deadline) return { files: await dropSourceCode(files, (file) => file, readLocalHead), truncated: true };
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
  return { files: await dropSourceCode(files, (file) => file, readLocalHead), truncated: false };
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
  const entries = await dropSourceCode(
    await host.listDir(dir),
    (entry) => (entry.isDirectory ? null : { path: path.posix.join(dir, entry.name), size: entry.size }),
    (file, length) => host.readRange(file, 0, length),
  );
  for (const entry of entries) {
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
