import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listClosedAgents, restoreAgent } from "./server/agents";
import { closedAgentsRpc, restoreAgentRpc } from "./shared/agents";

export default function contribute(server: PluginServerContext) {
  server.handle(closedAgentsRpc, async ({ workspaceId }, { paseo }) => ({
    agents: await listClosedAgents(paseo, workspaceId),
  }));
  server.handle(restoreAgentRpc, async ({ workspaceId, agentId }, { paseo }) => {
    // Reloading restarts an agent's process, so never run it on one that is still open.
    const closed = await listClosedAgents(paseo, workspaceId);
    if (!closed.some((agent) => agent.id === agentId)) {
      throw new Error("This agent is no longer closed in this workspace.");
    }
    await restoreAgent(agentId);
    return {};
  });
  return () => {};
}
