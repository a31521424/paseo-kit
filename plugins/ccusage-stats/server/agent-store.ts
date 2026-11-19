import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Paseo's agent list drops an agent once the project of its workspace is removed, even with
// `includeArchived` (the daemon cannot place it, so the entry is skipped). Children started in a
// project that was removed afterwards would then drop out of their parent's numbers. The daemon
// keeps every agent at `$PASEO_HOME/agents/<project>/<agent id>.json`; the plugin runs on the
// daemon's host and reads those records as a fallback. Only the fields below are kept: a record
// also carries launch config, which can hold credentials.

export interface StoredAgent {
  id: string;
  parentAgentId: string | null;
  title: string | null;
  provider: string;
  archived: boolean;
  /** The provider session handle, as `agents.ref(id).refresh()` would report it. */
  sessionId: string | null;
}

interface CachedRecord {
  mtimeMs: number;
  agent: StoredAgent | null;
}

const PARENT_LABEL = "paseo.parent-agent-id";

function agentsDir(): string {
  return path.join(process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"), "agents");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStoredAgent(record: unknown): StoredAgent | null {
  if (!record || typeof record !== "object") return null;
  const raw = record as {
    id?: unknown;
    title?: unknown;
    provider?: unknown;
    archivedAt?: unknown;
    labels?: Record<string, unknown>;
    persistence?: { nativeHandle?: unknown; sessionId?: unknown } | null;
  };
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    parentAgentId: str(raw.labels?.[PARENT_LABEL]),
    title: str(raw.title),
    provider: str(raw.provider) ?? "unknown",
    archived: Boolean(raw.archivedAt),
    sessionId: str(raw.persistence?.nativeHandle) ?? str(raw.persistence?.sessionId),
  };
}

export function createAgentStore() {
  const records = new Map<string, CachedRecord>();

  async function readAll(): Promise<StoredAgent[]> {
    const root = agentsDir();
    const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const seen = new Set<string>();
    const agents: StoredAgent[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(dir, entry.name);
        seen.add(file);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) continue;
        let cached = records.get(file);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
          const agent = await fs
            .readFile(file, "utf8")
            .then((text) => toStoredAgent(JSON.parse(text)))
            .catch(() => null);
          cached = { mtimeMs: stat.mtimeMs, agent };
          records.set(file, cached);
        }
        if (cached.agent) agents.push(cached.agent);
      }
    }
    for (const file of records.keys()) if (!seen.has(file)) records.delete(file);
    return agents;
  }

  return {
    /** Every stored agent whose parent label points at `agentId`, including unlisted ones. */
    async children(agentId: string): Promise<StoredAgent[]> {
      return (await readAll()).filter((agent) => agent.parentAgentId === agentId);
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
