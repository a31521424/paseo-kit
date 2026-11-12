import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHUNK_BYTES, UPLOAD_ALIGN_BYTES, type ByteRange, type PendingUpload } from "../shared/rpc";
import { safeFileName, uniquePath } from "./files";
import { locate, refOf, type Located, type MediaHost } from "./hosts";
import { statLocated } from "./probe";

// Uploads and downloads move in pieces over plugin RPC, so they work through the daemon's direct
// connection, a reverse proxy or a tunnel without any extra port.
//
// An upload writes each piece at its offset in a hidden part file next to the target (pieces may
// arrive out of order) and renames it into place once every byte is there, so an interrupted
// upload never leaves a half file under the real name. Uploads resume: the same file (name, size,
// modification time) to the same folder maps to the same upload ID and part file, and the ranges
// already written are kept in a small record on the daemon host. After a dropped connection, a page
// reload, a plugin reload or a daemon restart, `begin` returns those ranges and the app sends only
// the rest. Records and part files nobody resumes are removed after a few days.
//
// On an SSH host each piece is one `dd` over the shared connection; the record stays on the daemon.

const STATE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paseo-media-studio", "uploads");
/** Unfinished uploads are kept this long after their last piece, then discarded. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
/** An upload nobody touched for this long leaves memory; its record and part file stay. */
const IDLE_MS = 15 * 60 * 1000;
const FLUSH_MS = 500;
const SWEEP_MS = 60 * 60 * 1000;

interface UploadRecord {
  version: 1;
  uploadId: string;
  /** Target folder as the app names it: a daemon path or alias:/path. */
  dir: string;
  name: string;
  size: number;
  lastModified: number | null;
  /** Part file path on the folder's host. */
  partPath: string;
  received: ByteRange[];
  createdAt: number;
  updatedAt: number;
}

interface ActiveUpload {
  record: UploadRecord;
  host: MediaHost;
  dirPath: string;
  lastUsed: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface Download {
  location: Located;
  size: number;
  lastUsed: number;
}

/** Adds `[start, end)` to sorted, merged ranges. */
export function addRange(ranges: readonly ByteRange[], start: number, end: number): ByteRange[] {
  const result: ByteRange[] = [];
  let next: ByteRange = [start, end];
  let placed = false;
  for (const range of ranges) {
    if (range[1] < next[0]) result.push(range);
    else if (range[0] > next[1]) {
      if (!placed) {
        result.push(next);
        placed = true;
      }
      result.push(range);
    } else next = [Math.min(range[0], next[0]), Math.max(range[1], next[1])];
  }
  if (!placed) result.push(next);
  return result;
}

export function coveredBytes(ranges: readonly ByteRange[]): number {
  return ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
}

function isComplete(ranges: readonly ByteRange[], size: number): boolean {
  return size === 0 || (ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] >= size);
}

/** Keeps only the ranges that lie within the first `size` bytes of the part file. */
function clampRanges(ranges: readonly ByteRange[], size: number): ByteRange[] {
  return ranges.filter(([start]) => start < size).map(([start, end]) => [start, Math.min(end, size)] as ByteRange);
}

function uploadIdFor(dir: string, name: string, size: number, lastModified: number | null): string {
  return createHash("sha1")
    .update([dir, name, size, lastModified ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function partName(name: string, uploadId: string): string {
  // Keep the hidden part file name within the 255-byte limit of most file systems.
  let stem = name;
  while (Buffer.byteLength(stem) > 200) stem = stem.slice(0, -1);
  return `.${stem}.${uploadId.slice(0, 10)}.part`;
}

function recordFile(uploadId: string): string {
  return path.join(STATE_DIR, `${uploadId}.json`);
}

async function readRecord(uploadId: string): Promise<UploadRecord | null> {
  try {
    const record = JSON.parse(await fs.readFile(recordFile(uploadId), "utf8")) as UploadRecord;
    return record.version === 1 && record.uploadId === uploadId ? record : null;
  } catch {
    return null;
  }
}

async function writeRecord(record: UploadRecord): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const file = recordFile(record.uploadId);
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record));
  await fs.rename(temp, file);
}

async function deleteRecord(uploadId: string): Promise<void> {
  await fs.unlink(recordFile(uploadId)).catch(() => undefined);
}

async function allRecords(): Promise<UploadRecord[]> {
  const names = await fs.readdir(STATE_DIR).catch(() => [] as string[]);
  const records = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readRecord(name.slice(0, -".json".length))),
  );
  return records.filter((record): record is UploadRecord => record !== null);
}

export function createTransfers() {
  const uploads = new Map<string, ActiveUpload>();
  const downloads = new Map<string, Download>();
  /** One load at a time per upload, so parallel pieces after a restart share it. */
  const loading = new Map<string, Promise<ActiveUpload>>();

  function scheduleFlush(upload: ActiveUpload): void {
    if (upload.flushTimer) return;
    upload.flushTimer = setTimeout(() => {
      upload.flushTimer = null;
      void writeRecord(upload.record).catch((error) => console.error("media-studio: could not save upload progress", error));
    }, FLUSH_MS);
  }

  async function flushNow(upload: ActiveUpload): Promise<void> {
    if (upload.flushTimer) clearTimeout(upload.flushTimer);
    upload.flushTimer = null;
    await writeRecord(upload.record);
  }

  /** The upload in memory, or loaded from its record after a plugin or daemon restart. */
  function activate(uploadId: string): Promise<ActiveUpload> {
    const active = uploads.get(uploadId);
    if (active) return Promise.resolve(active);
    let pending = loading.get(uploadId);
    if (!pending) {
      pending = (async () => {
        const record = await readRecord(uploadId);
        if (!record) throw new Error("This upload expired. Start it again.");
        const dir = await locate(record.dir);
        const upload: ActiveUpload = { record, host: dir.host, dirPath: dir.path, lastUsed: Date.now(), flushTimer: null };
        uploads.set(uploadId, upload);
        return upload;
      })().finally(() => loading.delete(uploadId));
      loading.set(uploadId, pending);
    }
    return pending;
  }

  async function begin(
    dir: Located,
    input: { name: string; size: number; lastModified?: number | null },
  ): Promise<{ uploadId: string; received: ByteRange[]; receivedBytes: number; resumed: boolean }> {
    const name = safeFileName(input.name);
    const lastModified = input.lastModified ?? null;
    const uploadId = uploadIdFor(dir.ref, name, input.size, lastModified);
    let upload = uploads.get(uploadId) ?? null;
    let resumed = false;
    if (upload) {
      resumed = coveredBytes(upload.record.received) > 0;
    } else {
      const record = await readRecord(uploadId);
      if (record && record.dir === dir.ref && record.size === input.size) {
        // The part file must still be there; only ranges inside it count.
        const part = await dir.host.stat(record.partPath).catch(() => null);
        if (part?.isFile) {
          record.received = clampRanges(record.received, part.size);
          upload = { record, host: dir.host, dirPath: dir.path, lastUsed: Date.now(), flushTimer: null };
          resumed = coveredBytes(record.received) > 0;
        }
      }
      if (!upload) {
        await dir.host.mkdirp(dir.path);
        const partPath = path.posix.join(dir.path, partName(name, uploadId));
        await dir.host.createEmpty(partPath);
        const now = Date.now();
        upload = {
          record: { version: 1, uploadId, dir: dir.ref, name, size: input.size, lastModified, partPath, received: [], createdAt: now, updatedAt: now },
          host: dir.host,
          dirPath: dir.path,
          lastUsed: now,
          flushTimer: null,
        };
      }
      uploads.set(uploadId, upload);
      await flushNow(upload);
    }
    upload.lastUsed = Date.now();
    const received = upload.record.received;
    return { uploadId, received, receivedBytes: coveredBytes(received), resumed };
  }

  async function write(input: { uploadId: string; offset: number; base64: string }): Promise<{ received: number }> {
    const upload = await activate(input.uploadId);
    upload.lastUsed = Date.now();
    const data = Buffer.from(input.base64, "base64");
    if (data.length > CHUNK_BYTES) throw new Error("Upload piece is too large");
    if (input.offset % UPLOAD_ALIGN_BYTES !== 0) throw new Error("Upload pieces must start at multiples of 256 KB");
    if (input.offset + data.length > upload.record.size) throw new Error("Upload piece goes past the end of the file");
    await upload.host.writeAt(upload.record.partPath, input.offset, data);
    // Recorded only after the bytes are written, so a crash can lose progress but never claim it.
    upload.record.received = addRange(upload.record.received, input.offset, input.offset + data.length);
    upload.record.updatedAt = Date.now();
    scheduleFlush(upload);
    return { received: coveredBytes(upload.record.received) };
  }

  async function finish(input: { uploadId: string }): Promise<{ path: string }> {
    const upload = await activate(input.uploadId);
    const { record } = upload;
    if (!isComplete(record.received, record.size)) {
      throw new Error(`Upload is incomplete: ${coveredBytes(record.received)} of ${record.size} bytes arrived`);
    }
    const written = await upload.host.stat(record.partPath);
    if (!written || written.size !== record.size) throw new Error("The uploaded file has the wrong size");
    if (upload.flushTimer) clearTimeout(upload.flushTimer);
    upload.flushTimer = null;
    const target = await uniquePath(upload.host, upload.dirPath, record.name);
    await upload.host.rename(record.partPath, target);
    uploads.delete(input.uploadId);
    await deleteRecord(input.uploadId);
    return { path: refOf(upload.host, target) };
  }

  async function abort(uploadId: string): Promise<void> {
    const upload = uploads.get(uploadId) ?? (await activate(uploadId).catch(() => null));
    if (upload?.flushTimer) clearTimeout(upload.flushTimer);
    uploads.delete(uploadId);
    if (upload) await upload.host.remove(upload.record.partPath);
    await deleteRecord(uploadId);
  }

  function isUnder(dir: string, root: string): boolean {
    const base = root.replace(/\/+$/, "");
    return dir === base || dir.startsWith(`${base}/`);
  }

  async function pending(root: string | null): Promise<PendingUpload[]> {
    const records = new Map<string, UploadRecord>();
    for (const record of await allRecords()) records.set(record.uploadId, record);
    // Uploads in memory are newer than their records between flushes.
    for (const upload of uploads.values()) records.set(upload.record.uploadId, upload.record);
    return [...records.values()]
      .filter((record) => !root || isUnder(record.dir, root))
      .filter((record) => Date.now() - record.updatedAt < KEEP_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        uploadId: record.uploadId,
        dir: record.dir,
        name: record.name,
        size: record.size,
        lastModified: record.lastModified,
        receivedBytes: coveredBytes(record.received),
        updatedAt: new Date(record.updatedAt).toISOString(),
      }));
  }

  /** Removes uploads nobody resumed within KEEP_MS, part files included. */
  async function sweepStale(): Promise<void> {
    const now = Date.now();
    for (const record of await allRecords()) {
      if (uploads.has(record.uploadId) || now - record.updatedAt < KEEP_MS) continue;
      try {
        const dir = await locate(record.dir);
        await dir.host.remove(record.partPath);
        await deleteRecord(record.uploadId);
      } catch {
        // The host is unreachable or no longer allowed; give up on the part file eventually.
        if (now - record.updatedAt > KEEP_MS * 2) await deleteRecord(record.uploadId);
      }
    }
  }

  const memorySweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, upload] of uploads) {
      if (now - upload.lastUsed <= IDLE_MS) continue;
      uploads.delete(id);
      void flushNow(upload).catch(() => undefined);
    }
    for (const [id, download] of downloads) if (now - download.lastUsed > IDLE_MS) downloads.delete(id);
  }, 60_000);
  memorySweeper.unref();
  const firstSweep = setTimeout(() => void sweepStale().catch(() => undefined), 20_000);
  firstSweep.unref();
  const staleSweeper = setInterval(() => void sweepStale().catch(() => undefined), SWEEP_MS);
  staleSweeper.unref();

  async function openDownload(location: Located): Promise<{ transferId: string; path: string; name: string; size: number }> {
    const stats = await statLocated(location);
    const transferId = randomUUID();
    downloads.set(transferId, { location, size: stats.size, lastUsed: Date.now() });
    return { transferId, path: location.ref, name: path.basename(location.path), size: stats.size };
  }

  async function readDownload(input: { transferId: string; offset: number }): Promise<{ base64: string }> {
    const download = downloads.get(input.transferId);
    if (!download) throw new Error("This download expired. Start it again.");
    download.lastUsed = Date.now();
    const length = Math.max(0, Math.min(CHUNK_BYTES, download.size - input.offset));
    const data = await download.location.host.readRange(download.location.path, input.offset, length);
    if (data.length < length) throw new Error("The file changed while it was being downloaded.");
    return { base64: data.toString("base64") };
  }

  async function dispose(): Promise<void> {
    clearInterval(memorySweeper);
    clearInterval(staleSweeper);
    clearTimeout(firstSweep);
    // Unfinished uploads stay resumable: save their progress, keep their part files.
    await Promise.all([...uploads.values()].map((upload) => flushNow(upload).catch(() => undefined)));
    uploads.clear();
    downloads.clear();
  }

  return {
    begin,
    write,
    finish,
    abort,
    pending,
    sweepStale,
    openDownload,
    readDownload,
    closeDownload: (transferId: string) => void downloads.delete(transferId),
    dispose,
  };
}
