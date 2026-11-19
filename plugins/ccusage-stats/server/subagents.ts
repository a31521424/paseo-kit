import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMPTY_USAGE, type ModelUsage, type SubagentUsage, type Usage } from "../shared/usage";
import { runClaudeSessions, type RawClaudeSession } from "./ccusage";
import type { SubagentLog } from "./claude-logs";

// ccusage folds a session's subagents into the session's total and has no per-subagent output.
// Pricing them separately means showing ccusage only those logs: link (or copy) them into a
// scratch config directory and run `ccusage claude session` on it, where each log becomes its own
// session. Finished subagents never change, so a result is reused until the log's size or mtime does.

interface Priced {
  size: number;
  mtimeMs: number;
  session: RawClaudeSession | null;
}

function usageOf(row: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): Omit<Usage, "cost"> {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
  };
}

function toSubagent(log: SubagentLog, session: RawClaudeSession | null): SubagentUsage {
  const models: ModelUsage[] = (session?.modelBreakdowns ?? [])
    .map((model) => ({ model: model.modelName, usage: { ...usageOf(model), cost: model.cost } }))
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
  return {
    id: log.id,
    type: log.type,
    description: log.description,
    usage: session
      ? { ...usageOf(session), totalTokens: session.totalTokens, cost: session.totalCost }
      : EMPTY_USAGE,
    models,
    lastActivity: session?.lastActivity ?? null,
  };
}

async function placeLog(source: string, target: string): Promise<void> {
  // A hard link costs nothing when the scratch directory is on the same filesystem.
  await fs.link(source, target).catch(() => fs.copyFile(source, target));
}

export function createSubagentPricer(timezone: string) {
  const priced = new Map<string, Priced>();
  let queue: Promise<unknown> = Promise.resolve();

  async function price(logs: readonly SubagentLog[]): Promise<void> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ccusage-stats-"));
    try {
      const dir = path.join(scratch, "projects", "subagents");
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(logs.map((log) => placeLog(log.file, path.join(dir, `${log.id}.jsonl`))));
      const sessions = new Map(
        (await runClaudeSessions(scratch, timezone)).map((session) => [session.sessionId, session]),
      );
      for (const log of logs) {
        priced.set(log.file, {
          size: log.size,
          mtimeMs: log.mtimeMs,
          session: sessions.get(log.id) ?? null,
        });
      }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  return {
    /** Usage of each subagent, most expensive first. */
    async usage(logs: readonly SubagentLog[]): Promise<SubagentUsage[]> {
      const stale = logs.filter((log) => {
        const entry = priced.get(log.file);
        return !entry || entry.size !== log.size || entry.mtimeMs !== log.mtimeMs;
      });
      if (stale.length > 0) {
        // One ccusage run at a time; a panel refresh while one runs waits for it.
        const run = queue.then(() => price(stale));
        queue = run.catch(() => {});
        await run;
      }
      return logs
        .map((log) => toSubagent(log, priced.get(log.file)?.session ?? null))
        .sort((a, b) => b.usage.cost - a.usage.cost || b.usage.totalTokens - a.usage.totalTokens);
    },
  };
}

export type SubagentPricer = ReturnType<typeof createSubagentPricer>;
