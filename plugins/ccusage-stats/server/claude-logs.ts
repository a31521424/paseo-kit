import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code keeps one log per session at `<config>/projects/<project>/<session id>.jsonl`. When a
// session is resumed or forked, the new log starts with rows that carry `forkedFrom.sessionId`, and
// ccusage, which drops duplicate messages, books the history that was not copied, including every
// Task subagent (`<session id>/subagents/agent-<id>.jsonl`), under the older session. A Paseo agent's
// conversation is therefore its current session plus that chain.

// A new session usually appears just before Paseo asks about it; don't rescan more often than this.
const INDEX_TTL_MS = 30_000;
const MAX_CHAIN = 50;
// The fork marker is on the first rows; stop reading a log head after this many rows or bytes.
const HEAD_ROWS = 5;
const HEAD_BYTES = 4 * 1024 * 1024;

/** The `projects` directories ccusage reads: `CLAUDE_CONFIG_DIR` (comma separated) or the defaults. */
function projectRoots(): string[] {
  const configured = (process.env.CLAUDE_CONFIG_DIR ?? "")
    .split(",")
    .map((dir) => dir.trim())
    .filter(Boolean);
  const bases = configured.length
    ? configured
    : [path.join(os.homedir(), ".config", "claude"), path.join(os.homedir(), ".claude")];
  return bases.map((base) => path.join(base, "projects"));
}

async function listDir(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

/** Reads up to the first `HEAD_ROWS` JSON rows of a log without loading the whole file. */
async function readHeadRows(file: string): Promise<unknown[]> {
  const handle = await fs.open(file, "r");
  try {
    const parts: Buffer[] = [];
    let offset = 0;
    let newlines = 0;
    while (offset < HEAD_BYTES && newlines < HEAD_ROWS) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      parts.push(chunk.subarray(0, bytesRead));
      for (
        let at = chunk.indexOf(10);
        at !== -1 && at < bytesRead;
        at = chunk.indexOf(10, at + 1)
      ) {
        newlines += 1;
      }
    }
    // Decode once: a chunk boundary can split a multi-byte character.
    const text = Buffer.concat(parts).toString("utf8");
    const rows: unknown[] = [];
    for (const line of text.split("\n").slice(0, HEAD_ROWS)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // A cut-off last line or a non-JSON line.
      }
    }
    return rows;
  } finally {
    await handle.close();
  }
}

function forkedFromOf(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const forkedFrom = (row as { forkedFrom?: { sessionId?: unknown } }).forkedFrom;
  return typeof forkedFrom?.sessionId === "string" ? forkedFrom.sessionId : null;
}

export interface SubagentLog {
  /** The log file name without `.jsonl`: `agent-<id>`. */
  id: string;
  file: string;
  size: number;
  mtimeMs: number;
  type: string | null;
  description: string | null;
}

export function createClaudeLogs() {
  let index = new Map<string, string>();
  let indexedAt = 0;
  let indexing: Promise<void> | null = null;
  // The head of a log never changes, so neither does its parent.
  const parents = new Map<string, string | null>();

  const reindex = () => {
    indexing ??= (async () => {
      const next = new Map<string, string>();
      for (const root of projectRoots()) {
        for (const project of await listDir(root)) {
          if (!project.isDirectory()) continue;
          const dir = path.join(root, project.name);
          for (const entry of await listDir(dir)) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              next.set(entry.name.slice(0, -".jsonl".length), path.join(dir, entry.name));
            }
          }
        }
      }
      index = next;
      indexedAt = Date.now();
    })().finally(() => {
      indexing = null;
    });
    return indexing;
  };

  async function sessionFile(sessionId: string): Promise<string | null> {
    if (!index.has(sessionId) && Date.now() - indexedAt > INDEX_TTL_MS) await reindex();
    return index.get(sessionId) ?? null;
  }

  async function parentOf(sessionId: string): Promise<string | null> {
    const file = await sessionFile(sessionId);
    if (!file) return null;
    if (!parents.has(file)) {
      const rows = await readHeadRows(file).catch(() => []);
      parents.set(file, rows.map(forkedFromOf).find((id) => id !== null) ?? null);
    }
    return parents.get(file) ?? null;
  }

  return {
    /** The session followed by the sessions it was resumed or forked from, newest first. */
    async chain(sessionId: string): Promise<string[]> {
      const chain = [sessionId];
      let parent = await parentOf(sessionId);
      while (parent && !chain.includes(parent) && chain.length < MAX_CHAIN) {
        chain.push(parent);
        parent = await parentOf(parent);
      }
      return chain;
    },

    /** Task subagent logs that Claude Code wrote for these sessions. */
    async subagents(sessionIds: readonly string[]): Promise<SubagentLog[]> {
      const logs: SubagentLog[] = [];
      for (const sessionId of sessionIds) {
        const file = await sessionFile(sessionId);
        if (!file) continue;
        const dir = path.join(file.slice(0, -".jsonl".length), "subagents");
        for (const entry of await listDir(dir)) {
          if (
            !entry.isFile() ||
            !entry.name.startsWith("agent-") ||
            !entry.name.endsWith(".jsonl")
          ) {
            continue;
          }
          const id = entry.name.slice(0, -".jsonl".length);
          const logFile = path.join(dir, entry.name);
          const stat = await fs.stat(logFile).catch(() => null);
          if (!stat) continue;
          const meta = await fs
            .readFile(path.join(dir, `${id}.meta.json`), "utf8")
            .then((text) => JSON.parse(text) as { agentType?: unknown; description?: unknown })
            .catch(() => null);
          logs.push({
            id,
            file: logFile,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            type: typeof meta?.agentType === "string" ? meta.agentType : null,
            description: typeof meta?.description === "string" ? meta.description : null,
          });
        }
      }
      return logs;
    },
  };
}

export type ClaudeLogs = ReturnType<typeof createClaudeLogs>;
