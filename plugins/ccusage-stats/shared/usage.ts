import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  cost: z.number(),
});

const modelUsageSchema = z.object({ model: z.string(), usage: usageSchema });

const agentUsageSchema = z.object({
  /** ccusage's agent name: "claude", "codex", "gemini", ... */
  agent: z.string(),
  usage: usageSchema,
  models: z.array(modelUsageSchema),
});

const periodSchema = z.object({
  /** "2026-10-12" for days and weeks (the Monday), "2026-10" for months. */
  period: z.string(),
  usage: usageSchema,
  agents: z.array(agentUsageSchema),
});

const sessionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  usage: usageSchema,
  models: z.array(modelUsageSchema),
  lastActivity: z.string().nullable(),
});

export const usageReportRpc = defineRpc({
  name: "usage.report",
  input: z.object({}),
  output: z.object({
    /** When ccusage last produced this report, in epoch milliseconds. */
    generatedAt: z.number(),
    /** The daemon's local date, the same calendar ccusage groups by. */
    today: z.string(),
    timezone: z.string(),
    /** Every agent seen in the report, heaviest first: a stable order for colors. */
    agents: z.array(z.string()),
    /** Contiguous series, oldest first; the last entry is the current period. */
    daily: z.array(periodSchema),
    weekly: z.array(periodSchema),
    monthly: z.array(periodSchema),
    recentSessions: z.array(sessionSchema),
    /** Set when the latest refresh failed and an older report is served instead. */
    refreshError: z.string().nullable(),
  }),
});

const sessionMatchSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    agentId: z.string(),
    providerSessionId: z.string(),
    session: sessionSchema,
  }),
  /** The provider session exists but ccusage has not recorded usage for it yet. */
  z.object({ status: z.literal("pending"), agentId: z.string(), providerSessionId: z.string() }),
  /** Paseo has no provider session id for the agent (never started, or not persistable). */
  z.object({ status: z.literal("unknown"), agentId: z.string() }),
]);

export const sessionUsageRpc = defineRpc({
  name: "usage.sessions",
  input: z.object({ agentIds: z.array(z.string()).max(200) }),
  output: z.object({ generatedAt: z.number(), sessions: z.array(sessionMatchSchema) }),
});

export type Usage = z.infer<typeof usageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type UsagePeriod = z.infer<typeof periodSchema>;
export type SessionUsage = z.infer<typeof sessionSchema>;
export type SessionMatch = z.infer<typeof sessionMatchSchema>;
export type PeriodKind = "daily" | "weekly" | "monthly";

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  cost: 0,
};
