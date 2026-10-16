import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const closedAgentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  createdAt: z.string(),
  archivedAt: z.string(),
});

export type ClosedAgent = z.infer<typeof closedAgentSchema>;

/** Archived top-level agents of a workspace, most recently closed first. */
export const closedAgentsRpc = defineRpc({
  name: "agents.closed",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ agents: z.array(closedAgentSchema) }),
});

/** Unarchives an agent and resumes its session, like the Unarchive button in its tab. */
export const restoreAgentRpc = defineRpc({
  name: "agents.restore",
  input: z.object({ workspaceId: z.string(), agentId: z.string() }),
  output: z.object({}),
});
