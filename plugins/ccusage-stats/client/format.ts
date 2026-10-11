import type { PeriodKind } from "../shared/usage";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "999", "345K", "28.0M", "1.26B": three significant digits, never more than five characters. */
export function formatTokens(tokens: number): string {
  const value = Math.max(tokens, 0);
  if (value < 999.5) return `${Math.round(value)}`;
  let scaled = value;
  for (const unit of ["K", "M", "B", "T"]) {
    scaled /= 1000;
    // Thresholds sit below the rounding points: 9.996 would print as "10.00", 999.6 as "1000".
    if (scaled < 9.995) return `${scaled.toFixed(2)}${unit}`;
    if (scaled < 99.95) return `${scaled.toFixed(1)}${unit}`;
    if (scaled < 999.5 || unit === "T") return `${Math.round(scaled)}${unit}`;
  }
  return "";
}

/** "$0.42", "$12.30", "$118", "$1.2K". */
export function formatCost(cost: number): string {
  const value = Math.max(cost, 0);
  if (value === 0) return "$0";
  if (value < 0.005) return "<$0.01";
  if (value < 99.995) return `$${value.toFixed(2)}`;
  if (value < 999.5) return `$${Math.round(value)}`;
  return `$${(value / 1000).toFixed(1)}K`;
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function parseKey(key: string): { year: number; month: number; day: number } {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return { year, month, day };
}

/** Axis labels: "12", "Oct 5", "Oct". */
export function formatPeriodShort(kind: PeriodKind, key: string): string {
  const { month, day } = parseKey(key);
  if (kind === "monthly") return MONTHS[month - 1] ?? key;
  if (kind === "weekly") return `${MONTHS[month - 1]} ${day}`;
  return `${day}`;
}

/** Headline labels: "Mon, Oct 12", "Week of Oct 5", "October 2026". */
export function formatPeriodLong(kind: PeriodKind, key: string): string {
  const { year, month, day } = parseKey(key);
  if (kind === "monthly") return `${MONTHS[month - 1]} ${year}`;
  if (kind === "weekly") return `Week of ${MONTHS[month - 1]} ${day}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${MONTHS[month - 1]} ${day}`;
}

export const CURRENT_LABEL: Record<PeriodKind, string> = {
  daily: "Today",
  weekly: "This week",
  monthly: "This month",
};

export const PREVIOUS_LABEL: Record<PeriodKind, string> = {
  daily: "yesterday",
  weekly: "last week",
  monthly: "last month",
};

export function formatAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes",
  pi: "Pi",
  goose: "Goose",
  kilo: "Kilo",
  copilot: "Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  kimi: "Kimi",
  qwen: "Qwen",
  openclaw: "OpenClaw",
  grok: "Grok Build",
  zcode: "ZCode",
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** A Codex rollout name or a UUID, shortened to something recognizable. */
export function shortSessionId(id: string): string {
  const tail = id.split(/[/-]/).filter(Boolean);
  const uuidStart = tail.length >= 5 ? tail[tail.length - 5] : undefined;
  return (uuidStart ?? id).slice(0, 8);
}
