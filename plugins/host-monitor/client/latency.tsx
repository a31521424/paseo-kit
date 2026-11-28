import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginPopoverProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { hostPingRpc } from "../shared/stats";
import { triggerStyle } from "./sidebar";
import { Sparkline, severityColor, type Severity } from "./stats";

const PING_MS = 2000;
// A ping still pending after this counts as lost, so a dead link turns red instead of freezing.
const TIMEOUT_MS = 5000;
const HISTORY = 30;
// The sparkline scale never drops below this, so small jitter on a fast link stays flat.
const SCALE_FLOOR_MS = 200;
const QUERY_KEY = ["host-ping"];

interface Latency {
  /** Latest round trip, or null when that ping failed or timed out. */
  ms: number | null;
  error: string | null;
  /** Last HISTORY results, oldest first; null marks a lost ping. */
  history: (number | null)[];
  sent: number;
  lost: number;
  lastOkAt: number | null;
}

export function latencySeverity(ms: number): Severity {
  if (ms >= 400) return "critical";
  if (ms >= 150) return "warning";
  return "normal";
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No response within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Round trip from this app to the daemon and back; a new ping starts 2 s after the last one settles. */
export function useLatency() {
  const ping = useRpc(hostPingRpc);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<Latency> => {
      let ms: number | null = null;
      let error: string | null = null;
      // Monotonic clock: a system clock change during the ping must not skew the reading.
      const started = performance.now();
      try {
        await withTimeout(ping({}), TIMEOUT_MS);
        ms = performance.now() - started;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const previous = queryClient.getQueryData<Latency>(QUERY_KEY);
      return {
        ms,
        error,
        history: [...(previous?.history ?? []), ms].slice(-HISTORY),
        sent: (previous?.sent ?? 0) + 1,
        lost: (previous?.lost ?? 0) + (ms === null ? 1 : 0),
        lastOkAt: ms === null ? previous?.lastOkAt ?? null : Date.now(),
      };
    },
    refetchInterval: PING_MS,
    // Opening the popover must not start an extra measurement between interval ticks.
    staleTime: Infinity,
    retry: false,
    // Keep probing while offline so a lost link shows as disconnected instead of a stale value.
    networkMode: "always",
  });
}

function toneOf(theme: PluginTheme, ms: number | null): string {
  return ms === null ? theme.colors.statusDanger : severityColor(theme, latencySeverity(ms));
}

function statusOf(ms: number | null): string {
  if (ms === null) return "Disconnected";
  return { normal: "Normal", warning: "Slow", critical: "Very slow" }[latencySeverity(ms)];
}

function scaled(history: readonly (number | null)[]): (number | null)[] {
  const peak = Math.max(SCALE_FLOOR_MS, ...history.map((v) => v ?? 0));
  return history.map((v) => (v === null ? null : (v / peak) * 100));
}

export function LatencyItem({ theme, openPopover }: PluginSidebarItemProps) {
  const { data } = useLatency();
  if (!data) return null;
  const { ms } = data;
  const value = ms === null ? "Disconnected" : formatLatency(ms);
  const tone = toneOf(theme, ms);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={ms === null ? "Host disconnected, press for latency details" : `Host latency ${value}, press for details`}
      onPress={() => openPopover(LatencyPopover)}
      style={triggerStyle(theme)}
    >
      <Icon name="Activity" size={14} color={ms === null ? tone : theme.colors.foregroundMuted} />
      <Text style={{ marginLeft: 6, fontSize: 12, color: theme.colors.foregroundMuted }}>Latency</Text>
      <Text
        numberOfLines={1}
        style={{ marginLeft: 6, fontSize: 12, fontWeight: "600", color: ms !== null && ms < 150 ? theme.colors.foreground : tone, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
        <Sparkline values={scaled(data.history)} color={tone} height={10} />
      </View>
    </Pressable>
  );
}

function StatRow({ theme, label, value, color }: { theme: PluginTheme; label: string; value: string; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: color ?? theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

function secondsAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ${seconds % 60} s ago`;
}

function LatencyPopover({ theme, layout }: PluginPopoverProps) {
  const { data } = useLatency();
  const root = { gap: 12, padding: layout.compact ? 16 : 12, minWidth: 260, backgroundColor: theme.colors.surface1 };
  if (!data) {
    return (
      <View style={root}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Measuring…</Text>
      </View>
    );
  }
  const { ms, history, sent, lost, lastOkAt, error } = data;
  const tone = toneOf(theme, ms);
  const ok = history.filter((v): v is number => v !== null);
  const recentLost = history.length - ok.length;
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  if (ok.length > 1) jitter /= ok.length - 1;
  const avg = ok.length > 0 ? ok.reduce((sum, v) => sum + v, 0) / ok.length : null;

  return (
    <View style={root}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Connection latency</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Round-trip time through Paseo plugin RPC</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: tone, fontSize: 28, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {ms === null ? "Disconnected" : formatLatency(ms)}
        </Text>
        {ms !== null ? <Text style={{ color: tone, fontSize: 13 }}>{statusOf(ms)}</Text> : null}
      </View>
      <Sparkline values={scaled(history)} color={tone} height={40} />
      <View style={{ gap: 6 }}>
        <StatRow
          theme={theme}
          label={`Last ${history.length} · min / avg / max`}
          value={ok.length > 0 ? `${Math.round(Math.min(...ok))} / ${Math.round(avg ?? 0)} / ${Math.round(Math.max(...ok))} ms` : "—"}
        />
        <StatRow theme={theme} label="Jitter (successive successful samples)" value={ok.length > 1 ? `${Math.round(jitter)} ms` : "—"} />
        <StatRow
          theme={theme}
          label="Recent lost"
          value={`${recentLost} / ${history.length}`}
          color={recentLost > 0 ? theme.colors.statusWarning : undefined}
        />
        <StatRow
          theme={theme}
          label="Lost since monitoring started"
          value={`${lost} / ${sent} (${sent > 0 ? ((lost / sent) * 100).toFixed(1) : "0"}%)`}
          color={lost > 0 ? theme.colors.statusWarning : undefined}
        />
        <StatRow theme={theme} label="Last success" value={lastOkAt === null ? "None yet" : secondsAgo(lastOkAt)} />
        {ms === null && error ? (
          // Stacked so a long error wraps instead of pushing past a narrow sheet.
          <View style={{ gap: 2 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Failure reason</Text>
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
          </View>
        ) : null}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        A new measurement starts 2 seconds after the previous one finishes. Slow from 150 ms, very slow from 400 ms; no response within 5 seconds means disconnected. Lost counts RPC failures or timeouts, not network packet loss.
      </Text>
    </View>
  );
}
