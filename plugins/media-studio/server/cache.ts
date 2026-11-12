import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Thumbnails, filmstrips and waveforms are cached on the daemon host, keyed by the file's path, size
// and modification time, so a rewritten file gets new ones and the old ones age out.
const CACHE_ROOT = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paseo-media-studio", "v1");
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const TRIM_INTERVAL_MS = 30 * 60 * 1000;

export function cacheKey(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

function cacheFile(key: string, ext: string): string {
  return path.join(CACHE_ROOT, key.slice(0, 2), `${key}.${ext}`);
}

export async function readCache(key: string, ext: string): Promise<Buffer | null> {
  const file = cacheFile(key, ext);
  const data = await fs.readFile(file).catch(() => null);
  if (data) {
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => undefined);
  }
  return data;
}

export async function writeCache(key: string, ext: string, data: Buffer | string): Promise<void> {
  const file = cacheFile(key, ext);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } catch {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/** Memoizes `produce` in the disk cache as JSON. */
export async function cachedJson<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const hit = await readCache(key, "json");
  if (hit) {
    try {
      return JSON.parse(hit.toString()) as T;
    } catch {
      // Fall through and rebuild a damaged entry.
    }
  }
  const value = await produce();
  await writeCache(key, "json", JSON.stringify(value));
  return value;
}

async function trim(): Promise<void> {
  const files: { file: string; size: number; mtimeMs: number }[] = [];
  const shards = await fs.readdir(CACHE_ROOT).catch(() => []);
  for (const shard of shards) {
    const dir = path.join(CACHE_ROOT, shard);
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const stats = await fs.stat(file).catch(() => null);
      if (stats?.isFile()) files.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }
  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of files) {
    if (total <= MAX_CACHE_BYTES * 0.8) break;
    await fs.unlink(entry.file).catch(() => undefined);
    total -= entry.size;
  }
}

/** Keeps the cache under 1 GB, oldest use first. Returns the cleanup. */
export function startCacheTrimmer(): () => void {
  const runTrim = () => void trim().catch((error) => console.error("media-studio: cache trim failed", error));
  const first = setTimeout(runTrim, 30_000);
  const timer = setInterval(runTrim, TRIM_INTERVAL_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
