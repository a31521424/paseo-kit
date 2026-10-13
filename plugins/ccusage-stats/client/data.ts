import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import {
  EMPTY_USAGE,
  sessionUsageRpc,
  usageReportRpc,
  type AgentUsage,
  type Usage,
  type UsagePeriod,
} from "../shared/usage";

// The daemon caches ccusage's report and refreshes it after each finished turn; polling only
// picks that up. ccusage reads whole log files, so there is no point polling faster.
const REPORT_REFRESH_MS = 30_000;
const SESSION_REFRESH_MS = 20_000;

export type UsageReport = RpcOutput<typeof usageReportRpc>;

export function useUsageReport() {
  const getReport = useRpc(usageReportRpc);
  return useQuery({
    queryKey: ["usage-report"],
    queryFn: () => getReport({}),
    refetchInterval: REPORT_REFRESH_MS,
    staleTime: REPORT_REFRESH_MS / 2,
  });
}

export function useSessionUsage(agentId: string) {
  const getSessions = useRpc(sessionUsageRpc);
  return useQuery({
    queryKey: ["session-usage", agentId],
    queryFn: async () => {
      const { sessions } = await getSessions({ agentIds: [agentId] });
      return sessions[0] ?? { status: "unknown" as const, agentId };
    },
    refetchInterval: SESSION_REFRESH_MS,
  });
}

// Days before today that define a typical day for the sidebar meter: four weeks, so weekly rhythms
// even out and enough active days remain once idle ones are skipped.
export const TYPICAL_DAYS = 28;
// With no history, the typical day follows SemiAnalysis's subscription limit tests (October 2026,
// agentic workload): a $200 Claude Max 20x plan holds about $11,726 of API-equivalent value a month
// on Opus 5.5, and 20% is a realistic utilization. Labs change limits often; revisit with new tests.
export const DEFAULT_TYPICAL_COST = (11726 * 0.2) / 30;

/** A typical day in API-equivalent dollars, the same measure ccusage's cost is in. */
export interface TypicalDay {
  cost: number;
  /** Active days the figure is drawn from; 0 when the default stands in. */
  activeDays: number;
  /** True when there is no recent history and the default stands in. */
  estimated: boolean;
  /**
   * Mean cost per calendar day, idle days included, from the first day with usage in the window
   * through yesterday: what the meter's agents cost over time, comparable to a plan's price.
   * Null with no history.
   */
  average: { cost: number; days: number } | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Median cost per active day over the TYPICAL_DAYS before today. Idle days are skipped so
 * weekends and time off do not drag the typical day down, and the median keeps one marathon day,
 * or a day with a single prompt, from moving it far. Cost rather than tokens, because cache reads
 * dominate token counts while costing next to nothing.
 */
export function typicalDay(daily: readonly UsagePeriod[]): TypicalDay {
  const costs = daily.slice(-TYPICAL_DAYS - 1, -1).map((day) => day.usage.cost);
  const active = costs.filter((cost) => cost > 0);
  if (active.length === 0) {
    return { cost: DEFAULT_TYPICAL_COST, activeDays: 0, estimated: true, average: null };
  }
  // Counting from the first active day, so a short history is not averaged over empty weeks
  // from before it began.
  const days = costs.length - costs.findIndex((cost) => cost > 0);
  const total = active.reduce((sum, cost) => sum + cost, 0);
  return {
    cost: median(active),
    activeDays: active.length,
    estimated: false,
    average: { cost: total / days, days },
  };
}

/** Named series before the rest fold into "Other". */
export const MAX_NAMED_AGENTS = 4;
export const OTHER_AGENT = "other";

export interface Swatch {
  color: string;
  opacity: number;
}

/**
 * Agent identity colors. The theme offers one accent and neutrals; the status colors mean
 * health, not identity, so agents get accent and muted steps instead. The order comes from the
 * report (heaviest agent across all history first), so an agent keeps its color across every view, and
 * every swatch sits next to a text label.
 */
export function agentSwatch(theme: PluginTheme, agents: readonly string[], agent: string): Swatch {
  const steps: Swatch[] = [
    { color: theme.colors.accent, opacity: 1 },
    { color: theme.colors.accent, opacity: 0.5 },
    { color: theme.colors.foregroundMuted, opacity: 0.9 },
    { color: theme.colors.foregroundMuted, opacity: 0.45 },
  ];
  const index = agents.indexOf(agent);
  if (index < 0 || index >= MAX_NAMED_AGENTS) return { color: theme.colors.border, opacity: 1 };
  return steps[index] ?? { color: theme.colors.border, opacity: 1 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

/** A period's agents in report order, with anything past the named slots folded into "Other". */
export function foldAgents(agents: readonly AgentUsage[], order: readonly string[]): AgentUsage[] {
  const named: AgentUsage[] = [];
  let other: AgentUsage | null = null;
  for (const agent of agents) {
    const rank = order.indexOf(agent.agent);
    if (rank >= 0 && rank < MAX_NAMED_AGENTS) {
      named.push(agent);
    } else {
      other ??= { agent: OTHER_AGENT, usage: EMPTY_USAGE, models: [] };
      other = {
        agent: OTHER_AGENT,
        usage: addUsage(other.usage, agent.usage),
        models: [...other.models, ...agent.models],
      };
    }
  }
  named.sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
  return other ? [...named, other] : named;
}
