import { execFile } from "node:child_process";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ClosedAgent } from "../shared/agents";

type Paseo = PluginHandlerContext["paseo"];

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const PAGE_SIZE = 200;
const MAX_AGENTS = 50;
const RESTORE_TIMEOUT_MS = 90_000;

export async function listClosedAgents(paseo: Paseo, workspaceId: string): Promise<ClosedAgent[]> {
  const agents: ClosedAgent[] = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) {
      // Closing a subagent's tab only hides it, so only top-level agents end up archived by a close.
      if (agent.workspaceId !== workspaceId || !agent.archivedAt || agent.labels?.[PARENT_AGENT_LABEL]) continue;
      agents.push({
        id: agent.id,
        title: agent.title,
        provider: agent.provider,
        model: agent.model,
        createdAt: agent.createdAt,
        archivedAt: agent.archivedAt,
      });
    }
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  agents.sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
  return agents.slice(0, MAX_AGENTS);
}

/**
 * The SDK has no unarchive call, so this runs `paseo agent reload`. It sends the same request as
 * the Unarchive button in an archived agent's tab: unarchive, then resume the provider session.
 * The CLI finds this daemon through PASEO_HOME, which the plugin process inherits.
 */
export function restoreAgent(agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "paseo",
      ["agent", "reload", agentId, "--json"],
      { timeout: RESTORE_TIMEOUT_MS, env: process.env },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error("The paseo CLI is not on the daemon's PATH, so the agent cannot be restored."));
        }
        const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
        reject(new Error(detail ? `Could not restore the agent: ${detail}` : error.message));
      },
    );
  });
}
