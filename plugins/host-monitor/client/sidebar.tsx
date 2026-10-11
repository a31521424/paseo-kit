import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import type { hostStatsRpc } from "../shared/stats";
import { formatBytes, formatCompactRate, formatPercent, formatRate, formatUptime } from "./format";
import { Sparkline, loadColor, scaleToPeak, useHostStats } from "./stats";

// Geometry follows the built-in usage summary in the same footer.
const ICON_SIZE = 14;
const FONT_SIZE = 12;
const ICON_GAP = 6;
const METRIC_GAP = 10;
const MIN_METER_WIDTH = 16;
const METER_GAP = 4;
const METER_COUNT = 2;
const METER_HEIGHT = 6;
// A load above zero always shows a sliver, so a nearly idle meter is not mistaken for an empty one.
const MIN_FILL_WIDTH = 2;

type HostStats = RpcOutput<typeof hostStatsRpc>;

/** Meters when everything fits, else plain numbers, else CPU and RAM alone. */
type LineLayout = "meters" | "plain" | "compact";

interface Metric {
  icon: string;
  text: string;
  percent?: number;
  droppable?: boolean;
}

function metricsOf(stats: HostStats): Metric[] {
  const { current, memory, network } = stats;
  const memoryPercent = (memory.usedBytes / memory.totalBytes) * 100;
  const metrics: Metric[] = [
    { icon: "Cpu", text: formatPercent(current.cpuPercent), percent: current.cpuPercent },
    { icon: "MemoryStick", text: formatPercent(memoryPercent), percent: memoryPercent },
  ];
  if (network) {
    metrics.push(
      { icon: "ArrowDown", text: formatCompactRate(current.rxBytesPerSec), droppable: true },
      { icon: "ArrowUp", text: formatCompactRate(current.txBytesPerSec), droppable: true },
    );
  }
  return metrics;
}

// The widest text a slot can hold: rounded percents top out at 100%, compact rates at 4 characters.
const SLOT_TEMPLATES = ["100%", "888K", "8.8M"];
// Used until the templates are measured.
const ESTIMATED_SLOT_WIDTH = FONT_SIZE * 2.6;
const TEXT_GAP = 4;

function MetricLine({
  theme,
  metrics,
  layout,
  slotWidth,
}: {
  theme: PluginTheme;
  metrics: readonly Metric[];
  layout: LineLayout;
  slotWidth: number;
}) {
  const shown = layout === "compact" ? metrics.filter((m) => !m.droppable) : metrics;
  return shown.map((metric, index) => {
    const metered = layout === "meters" && metric.percent !== undefined;
    return (
      <View
        key={metric.icon}
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginLeft: index === 0 ? 0 : METRIC_GAP,
          // Meter slots share the leftover width, so the line fills the row.
          flexGrow: metered ? 1 : 0,
          flexShrink: metered ? 1 : 0,
        }}
      >
        <Icon name={metric.icon} size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        {metered ? (
          <View
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: 0,
              minWidth: MIN_METER_WIDTH,
              height: METER_HEIGHT,
              marginLeft: ICON_GAP,
              borderRadius: METER_HEIGHT / 2,
              // The outline keeps an empty meter visible on surfaces close to the track color.
              borderWidth: 1,
              borderColor: theme.colors.border,
              overflow: "hidden",
              backgroundColor: theme.colors.surface2,
            }}
          >
            <View
              style={{
                height: "100%",
                width: `${Math.min(Math.max(metric.percent ?? 0, 0), 100)}%`,
                minWidth: (metric.percent ?? 0) > 0 ? MIN_FILL_WIDTH : 0,
                backgroundColor: loadColor(theme, metric.percent ?? 0),
              }}
            />
          </View>
        ) : null}
        {/* A fixed, right-aligned slot: changing digits never move anything around them. */}
        <Text
          numberOfLines={1}
          style={{
            width: slotWidth,
            marginLeft: metered ? METER_GAP : TEXT_GAP,
            textAlign: "right",
            color:
              metric.percent !== undefined && metric.percent >= 70
                ? loadColor(theme, metric.percent)
                : theme.colors.foreground,
            fontSize: FONT_SIZE,
            fontVariant: ["tabular-nums"],
          }}
        >
          {metric.text}
        </Text>
      </View>
    );
  });
}

/** Width of a meterless line of `count` metrics; depends only on fixed sizes, never on values. */
function lineWidth(count: number, slotWidth: number): number {
  return count * (ICON_SIZE + TEXT_GAP + slotWidth) + Math.max(count - 1, 0) * METRIC_GAP;
}

function chooseLayout(available: number | null, metrics: readonly Metric[], slotWidth: number): LineLayout {
  if (available === null) return "plain";
  const plain = lineWidth(metrics.length, slotWidth);
  const meterCount = metrics.filter((m) => m.percent !== undefined).length;
  if (plain + meterCount * (ICON_GAP + MIN_METER_WIDTH + METER_GAP - TEXT_GAP) <= available) {
    return "meters";
  }
  if (plain <= available) return "plain";
  return "compact";
}

function triggerStyle(theme: PluginTheme) {
  return ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => ({
    width: "100%" as const,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    overflow: "hidden" as const,
    minHeight: 28,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: hovered ? theme.colors.surface2 : undefined,
  });
}

function describe(stats: HostStats): string {
  const { current, memory, network } = stats;
  const parts = [
    `CPU ${formatPercent(current.cpuPercent)}`,
    `memory ${formatPercent((memory.usedBytes / memory.totalBytes) * 100)}`,
  ];
  if (network) {
    parts.push(
      `download ${formatRate(current.rxBytesPerSec)}`,
      `upload ${formatRate(current.txBytesPerSec)}`,
    );
  }
  return `Host status: ${parts.join(", ")}`;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

export function HostStatusItem({ theme, openPopover }: PluginSidebarItemProps) {
  const { data } = useHostStats();
  const [available, setAvailable] = useState<number | null>(null);
  const [measuredSlot, setMeasuredSlot] = useState<number | null>(null);
  const onAvailable = useCallback((e: LayoutChangeEvent) => setAvailable(layoutWidth(e)), []);
  const onTemplate = useCallback((e: LayoutChangeEvent) => {
    const width = Math.ceil(layoutWidth(e));
    setMeasuredSlot((current) => Math.max(current ?? 0, width));
  }, []);

  // Like the built-in usage summary: nothing until there is something to show.
  if (!data) return null;
  const metrics = metricsOf(data);
  const slotWidth = measuredSlot ?? ESTIMATED_SLOT_WIDTH;
  const layout = chooseLayout(available, metrics, slotWidth);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={describe(data)}
      onPress={() => openPopover(HostPopover)}
      style={triggerStyle(theme)}
    >
      <View
        style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", overflow: "hidden" }}
        onLayout={onAvailable}
      >
        <MetricLine theme={theme} metrics={metrics} layout={layout} slotWidth={slotWidth} />
      </View>
      {/* Off-screen templates fix the slot width once, independent of live values. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", top: 0, left: 0, width: 10_000, opacity: 0 }}
      >
        {SLOT_TEMPLATES.map((template) => (
          <Text
            key={template}
            onLayout={onTemplate}
            style={{ alignSelf: "flex-start", fontSize: FONT_SIZE, fontVariant: ["tabular-nums"] }}
          >
            {template}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

interface PreviewRowProps {
  theme: PluginTheme;
  icon: string;
  label: string;
  value: string;
  color: string;
  values: readonly number[];
}

function PreviewRow({ theme, icon, label, value, color, values }: PreviewRowProps) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: ICON_GAP }}>
        <Icon name={icon} size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: FONT_SIZE }}>
          {label}
        </Text>
        <Text
          style={{ color: theme.colors.foreground, fontSize: FONT_SIZE, fontVariant: ["tabular-nums"] }}
        >
          {value}
        </Text>
      </View>
      <Sparkline values={values} color={color} height={18} />
    </View>
  );
}

function HostPopover({ theme, layout }: PluginPopoverProps) {
  const { data } = useHostStats();
  const rootStyle = {
    gap: 10,
    padding: layout.compact ? 16 : 12,
    minWidth: 240,
    backgroundColor: theme.colors.surface1,
  };
  if (!data) {
    return (
      <View style={rootStyle}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE }}>Loading...</Text>
      </View>
    );
  }

  const { current, history, memory, network } = data;
  const memoryPercent = (memory.usedBytes / memory.totalBytes) * 100;

  return (
    <View style={rootStyle}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: FONT_SIZE + 1 }}>{data.hostname}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE - 1 }}>
          up {formatUptime(data.uptimeSeconds)} · load{" "}
          {data.loadAverage.map((n) => n.toFixed(2)).join(" ")}
        </Text>
      </View>
      <PreviewRow
        theme={theme}
        icon="Cpu"
        label={`CPU · ${data.cpuCount} cores`}
        value={formatPercent(current.cpuPercent)}
        color={loadColor(theme, current.cpuPercent)}
        values={history.map((s) => s.cpuPercent)}
      />
      <PreviewRow
        theme={theme}
        icon="MemoryStick"
        label={`RAM · ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
        value={formatPercent(memoryPercent)}
        color={loadColor(theme, memoryPercent)}
        values={history.map((s) => s.memoryPercent)}
      />
      {network ? (
        <>
          <PreviewRow
            theme={theme}
            icon="ArrowDown"
            label="Download"
            value={formatRate(current.rxBytesPerSec)}
            color={theme.colors.accent}
            values={scaleToPeak(history, (s) => s.rxBytesPerSec)}
          />
          <PreviewRow
            theme={theme}
            icon="ArrowUp"
            label="Upload"
            value={formatRate(current.txBytesPerSec)}
            color={theme.colors.accent}
            values={scaleToPeak(history, (s) => s.txBytesPerSec)}
          />
        </>
      ) : null}
    </View>
  );
}
