import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import {
  claudeLimitsRpc,
  refreshClaudeLimitsRpc,
  type ClaudeLimitsState,
  type LimitWindow,
} from "../shared/limits";
import { formatAgo } from "./format";
import { FONT } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export const LIMITS_QUERY_KEY = ["claude-limits"] as const;
// Asking is cheap: the daemon answers from its cache and runs /usage at most every few minutes.
const LIMITS_POLL_MS = 60_000;
// While the daemon runs /usage in the background, look again soon for the new numbers.
const LIMITS_REFRESHING_POLL_MS = 3_000;

export function useClaudeLimits() {
  const read = useRpc(claudeLimitsRpc);
  return useQuery({
    queryKey: LIMITS_QUERY_KEY,
    queryFn: () => read({}),
    refetchInterval: (query) =>
      query.state.data?.refreshing ? LIMITS_REFRESHING_POLL_MS : LIMITS_POLL_MS,
  });
}

function useRefreshLimits() {
  const refresh = useRpc(refreshClaudeLimitsRpc);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => refresh({}),
    onSuccess: (state) => queryClient.setQueryData(LIMITS_QUERY_KEY, state),
  });
}

/** Re-renders every `ms` so relative times and countdowns stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The same thresholds as host-monitor's meters: yellow from 70%, red from 90%. */
export function limitColor(theme: PluginTheme, percent: number | null): string {
  if (percent === null) return theme.colors.foregroundMuted;
  if (percent >= 90) return theme.colors.statusDanger;
  if (percent >= 70) return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function formatPercentUsed(percent: number | null): string {
  if (percent === null) return "—";
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const timeOf = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "today 7:00 PM", "tomorrow 9:00 AM", "Nov 21, 9:00 AM": in this device's time zone and locale. */
export function formatReset(resetsAt: number, now = Date.now()): string {
  const date = new Date(resetsAt);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(date, new Date(now))) return `today ${timeOf(date)}`;
  if (sameDay(date, tomorrow)) return `tomorrow ${timeOf(date)}`;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${timeOf(date)}`;
}

/** The popover's short form: "7:00 PM" today, "Thu 9:00 AM" this week, else "Nov 21". */
function formatResetShort(resetsAt: number, now: number): string {
  const date = new Date(resetsAt);
  if (sameDay(date, new Date(now))) return timeOf(date);
  if (resetsAt - now < 6 * 24 * 60 * 60_000) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${timeOf(date)}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "in 2h 5m", "in 3d 4h". */
function formatIn(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const METHOD_LABEL = {
  headless: "claude -p /usage",
  interactive: "/usage in an interactive Claude Code session",
} as const;

/** Why there are no numbers, or null when there are (or will be shortly). */
function problemText(state: ClaudeLimitsState): string | null {
  if (state.missingClaude) {
    return "Claude Code (claude) was not found on this host. Install it, or set its path in this plugin's settings.";
  }
  if (!state.limits && state.error) return `Could not read plan limits: ${state.error}`;
  return null;
}

/** The short form for the sidebar. */
function problemShort(state: ClaudeLimitsState): string | null {
  if (state.missingClaude) return "Claude Code not found";
  if (!state.limits && state.error) return "Plan limits unavailable";
  return null;
}

export function LimitBar({
  theme,
  percent,
  height = 6,
}: {
  theme: PluginTheme;
  percent: number | null;
  height?: number;
}) {
  const fill = Math.min(Math.max(percent ?? 0, 0), 100) / 100;
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
        backgroundColor: theme.colors.surface2,
      }}
    >
      {fill > 0 ? (
        <View
          style={{
            width: `${fill * 100}%`,
            minWidth: 2,
            height: "100%",
            backgroundColor: limitColor(theme, percent),
          }}
        />
      ) : null}
    </View>
  );
}

// Below these widths the sidebar line drops its bars, then keeps only the fuller of the two spans.
const SIDEBAR_WIDTH_FOR_BARS = 170;
const SIDEBAR_WIDTH_FOR_BOTH = 104;

function SidebarWindow({
  theme,
  label,
  span,
  bar,
}: {
  theme: PluginTheme;
  label: string;
  span: LimitWindow | null;
  bar: boolean;
}) {
  const percent = span?.percent ?? null;
  const hot = percent !== null && percent >= 70;
  return (
    <View
      style={{
        flex: bar ? 1 : undefined,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
      }}
    >
      <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>{label}</Text>
      {bar ? (
        <View style={{ flex: 1, minWidth: 16 }}>
          <LimitBar theme={theme} percent={percent} height={5} />
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          fontSize: FONT.body,
          color: hot ? limitColor(theme, percent) : theme.colors.foreground,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatPercentUsed(percent)}
      </Text>
    </View>
  );
}

/** Text for the sidebar trigger's accessibility label; empty when the feature is off. */
export function limitsAccessibilityText(state: ClaudeLimitsState | undefined): string {
  if (!state?.enabled) return "";
  const problem = problemShort(state);
  if (problem) return `. ${problem}`;
  const { limits } = state;
  if (!limits) return "";
  const five = formatPercentUsed(limits.fiveHour?.percent ?? null);
  const week = formatPercentUsed(limits.sevenDay?.percent ?? null);
  return `. Claude plan: 5-hour ${five} used, weekly ${week} used`;
}

/**
 * The second sidebar footer line: the 5-hour and weekly windows. Nothing at all while the
 * feature is off or before the first answer.
 */
export function LimitsSidebarLine({
  theme,
  state,
  width,
}: {
  theme: PluginTheme;
  state: ClaudeLimitsState | undefined;
  width: number;
}) {
  if (!state?.enabled) return null;
  const problem = problemShort(state);
  const { limits } = state;
  if (!problem && !limits) return null;
  let content;
  if (problem || !limits) {
    content = (
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          marginLeft: 6,
          fontSize: FONT.caption,
          color: theme.colors.foregroundMuted,
        }}
      >
        {problem}
      </Text>
    );
  } else if (width >= SIDEBAR_WIDTH_FOR_BOTH) {
    const bars = width >= SIDEBAR_WIDTH_FOR_BARS;
    content = (
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          marginLeft: 6,
          gap: 10,
        }}
      >
        <SidebarWindow theme={theme} label="5h" span={limits.fiveHour} bar={bars} />
        <SidebarWindow theme={theme} label="7d" span={limits.sevenDay} bar={bars} />
      </View>
    );
  } else {
    // Narrow: only the window closer to its limit.
    const fiveHour = limits.fiveHour?.percent ?? -1;
    const sevenDay = limits.sevenDay?.percent ?? -1;
    const [label, span] =
      sevenDay > fiveHour ? (["7d", limits.sevenDay] as const) : (["5h", limits.fiveHour] as const);
    content = (
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", marginLeft: 6 }}>
        <SidebarWindow theme={theme} label={label} span={span} bar={false} />
      </View>
    );
  }
  const full = Math.max(limits?.fiveHour?.percent ?? 0, limits?.sevenDay?.percent ?? 0) >= 100;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", overflow: "hidden" }}>
      <Icon
        name="Gauge"
        size={14}
        color={full ? theme.colors.statusDanger : theme.colors.foregroundMuted}
      />
      {content}
    </View>
  );
}

function resetLine(span: LimitWindow | null, now: number): string {
  if (!span) return "Not shown by /usage";
  if (span.resetsAt) {
    return `Resets ${formatReset(span.resetsAt, now)} (${formatIn(span.resetsAt, now)})`;
  }
  if (span.resetsText) return `Resets ${span.resetsText}`;
  return "Reset time not shown";
}

/** The Details screen's row: label and percent, a bar, then the reset time. */
function WindowRow({
  theme,
  label,
  span,
  now,
}: {
  theme: PluginTheme;
  label: string;
  span: LimitWindow | null;
  now: number;
}) {
  const percent = span?.percent ?? null;
  const hot = percent !== null && percent >= 70;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: FONT.body, color: theme.colors.foreground }}>
          {label}
        </Text>
        <Text
          style={{
            fontSize: 18,
            fontWeight: "600",
            color: hot ? limitColor(theme, percent) : theme.colors.foreground,
            fontVariant: ["tabular-nums"],
          }}
        >
          {span ? `${formatPercentUsed(percent)} used` : "—"}
        </Text>
      </View>
      <LimitBar theme={theme} percent={percent} height={8} />
      <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
        {resetLine(span, now)}
        {percent !== null && percent >= 100 ? " · limit reached" : ""}
      </Text>
    </View>
  );
}

/** The popover's row: one line of label, bar, percent and reset time. */
function CompactWindowRow({
  theme,
  label,
  span,
  now,
}: {
  theme: PluginTheme;
  label: string;
  span: LimitWindow | null;
  now: number;
}) {
  const percent = span?.percent ?? null;
  const hot = percent !== null && percent >= 70;
  const reset = span?.resetsAt ? formatResetShort(span.resetsAt, now) : (span?.resetsText ?? "");
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${span ? `${formatPercentUsed(percent)} used` : "not shown"}${span ? `, ${resetLine(span, now)}` : ""}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <Text style={{ width: 54, fontSize: FONT.body, color: theme.colors.foreground }}>
        {label}
      </Text>
      <View style={{ flex: 1, minWidth: 24 }}>
        <LimitBar theme={theme} percent={percent} />
      </View>
      <Text
        style={{
          width: 34,
          textAlign: "right",
          fontSize: FONT.body,
          fontWeight: "600",
          color: hot ? limitColor(theme, percent) : theme.colors.foreground,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatPercentUsed(percent)}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          width: 78,
          fontSize: FONT.caption,
          color: theme.colors.foregroundMuted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {reset}
      </Text>
    </View>
  );
}

/** A manual refresh, still limited to the minimum interval. Nothing while the feature is off. */
export function LimitsRefreshButton({ theme }: { theme: PluginTheme }) {
  const { data: state } = useClaudeLimits();
  const refresh = useRefreshLimits();
  const now = useNow(30_000);
  if (!state?.enabled) return null;
  const busy = state.refreshing || refresh.isPending;
  const waitMs = state.nextManualAt !== null ? state.nextManualAt - now : 0;
  const disabled = busy || waitMs > 0;
  const label = busy
    ? "Refreshing..."
    : waitMs > 0
      ? `Refresh in ${Math.max(1, Math.ceil(waitMs / 60_000))}m`
      : "Refresh";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        waitMs > 0 && !busy
          ? `Plan limits can be refreshed ${formatIn(state.nextManualAt ?? now, now)}`
          : "Refresh plan limits"
      }
      disabled={disabled}
      onPress={() => refresh.mutate()}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: hovered && !disabled ? theme.colors.surface2 : undefined,
        opacity: disabled ? 0.6 : 1,
      })}
    >
      <Icon name="RefreshCw" size={12} color={theme.colors.foregroundMuted} />
      <Text style={{ fontSize: FONT.caption, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The plan limits block. `compact` is the popover's: a title row with the refresh button and
 * one line for each limit; the full form, for the Details screen card, leaves the title and refresh
 * button to the card. Renders nothing while the feature is off.
 */
export function ClaudeLimitsSection({
  theme,
  compact = false,
}: {
  theme: PluginTheme;
  compact?: boolean;
}) {
  const { data: state, error, isPending } = useClaudeLimits();
  const now = useNow(30_000);
  if (isPending || (!state && !error) || (state && !state.enabled)) return null;

  const note = (text: string, color = theme.colors.foregroundMuted) => (
    <Text style={{ fontSize: FONT.caption, color }}>{text}</Text>
  );
  const problem = state ? problemText(state) : null;
  const limits = state?.limits ?? null;
  const updated = state?.fetchedAt ? `Updated ${formatAgo(state.fetchedAt, now)}` : null;
  const scope = limits?.partial
    ? "Only the 5-hour and weekly limits: /usage shows no others for this sign-in."
    : "Only the 5-hour and weekly limits, the same two /usage shows for a setup token.";

  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      {compact ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: FONT.title, color: theme.colors.foreground }}>
              Claude plan limits
            </Text>
            <LimitsRefreshButton theme={theme} />
          </View>
        </>
      ) : null}
      {!state
        ? note(
            `Plan limits are unavailable: ${error?.message ?? "no answer"}`,
            theme.colors.statusDanger,
          )
        : null}
      {problem ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
          <View style={{ paddingTop: 1 }}>
            <Icon name="CircleAlert" size={12} color={theme.colors.statusWarning} />
          </View>
          <Text style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.statusWarning }}>
            {problem}
          </Text>
        </View>
      ) : null}
      {state && !limits && !problem
        ? note(state.refreshing ? "Running Claude Code's /usage..." : "No plan limits read yet.")
        : null}
      {limits && compact ? (
        <>
          <CompactWindowRow theme={theme} label="5-hour" span={limits.fiveHour} now={now} />
          <CompactWindowRow theme={theme} label="Weekly" span={limits.sevenDay} now={now} />
        </>
      ) : null}
      {limits && !compact ? (
        <>
          <WindowRow
            theme={theme}
            label="Current session (5 hours)"
            span={limits.fiveHour}
            now={now}
          />
          <WindowRow
            theme={theme}
            label="Current week (all models)"
            span={limits.sevenDay}
            now={now}
          />
        </>
      ) : null}
      {limits && state?.error
        ? note(`Showing older numbers: ${state.error}`, theme.colors.statusWarning)
        : null}
      {compact
        ? note([updated, scope].filter(Boolean).join(" · "))
        : note(
            [
              updated,
              state?.method ? `from ${METHOD_LABEL[state.method]} on the daemon host.` : null,
              scope,
            ]
              .filter(Boolean)
              .join(" "),
          )}
    </View>
  );
}

/** The Details screen's single line while the feature is off. */
export function ClaudeLimitsOffNote({ theme }: { theme: PluginTheme }) {
  const { data } = useClaudeLimits();
  if (!data || data.enabled) return null;
  return (
    <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
      Claude plan limits (5-hour and weekly) are off. Turn them on in this plugin's settings.
    </Text>
  );
}
