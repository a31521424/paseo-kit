import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { PeriodKind, UsagePeriod } from "../shared/usage";
import { agentSwatch, foldAgents, OTHER_AGENT, type Swatch } from "./data";
import { agentLabel, formatPeriodLong, formatPeriodShort, formatTokens } from "./format";

// Thin marks with a hairline of surface between neighbours, so segments read apart without outlines.
const SEGMENT_GAP = 2;

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

/** A compact segmented control: a recessed track with the selected option raised. */
export function Segmented<Value extends string>({
  theme,
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange(value: Value): void;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{
        flexDirection: "row",
        padding: 2,
        gap: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={({ hovered }: HoverState) => ({
              minWidth: 28,
              paddingVertical: 3,
              paddingHorizontal: 8,
              borderRadius: 6,
              alignItems: "center" as const,
              backgroundColor: selected
                ? theme.colors.surface0
                : hovered
                  ? theme.colors.surface1
                  : undefined,
            })}
          >
            <Text
              style={{
                fontSize: 12,
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontWeight: selected ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const PERIOD_OPTIONS: readonly SegmentedOption<PeriodKind>[] = [
  { value: "daily", label: "Day" },
  { value: "weekly", label: "Week" },
  { value: "monthly", label: "Month" },
];

export function SwatchDot({ swatch, size = 8 }: { swatch: Swatch; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        backgroundColor: swatch.color,
        opacity: swatch.opacity,
      }}
    />
  );
}

export interface ShareSegment {
  key: string;
  value: number;
  swatch: Swatch;
}

/** A horizontal 100% bar: each segment's width is its share. An empty bar shows only the track. */
export function ShareBar({
  theme,
  segments,
  height = 6,
}: {
  theme: PluginTheme;
  segments: readonly ShareSegment[];
  height?: number;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  return (
    <View
      style={{
        flexDirection: "row",
        height,
        gap: visible.length > 1 ? SEGMENT_GAP : 0,
        borderRadius: height / 2,
        overflow: "hidden",
        backgroundColor: visible.length === 0 ? theme.colors.surface2 : undefined,
      }}
    >
      {visible.map((segment) => (
        <View
          key={segment.key}
          style={{
            flexGrow: segment.value,
            flexBasis: 0,
            // Keep tiny shares visible as a sliver rather than vanishing.
            minWidth: 2,
            backgroundColor: segment.swatch.color,
            opacity: segment.swatch.opacity,
          }}
        />
      ))}
    </View>
  );
}

/**
 * Today against a typical day: the fill is today's total, split by agent, and a tick marks the
 * average. The track spans twice the average, so the tick sits mid-track until today passes
 * double; then the track stretches to today and the tick slides left. A default average gets a
 * muted tick, since it says nothing about this machine. Segments and average share one unit.
 */
export function PaceBar({
  theme,
  segments,
  average,
  estimated = false,
  height = 6,
}: {
  theme: PluginTheme;
  segments: readonly ShareSegment[];
  average: number;
  estimated?: boolean;
  height?: number;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0);
  const scale = Math.max(total, average * 2, 1);
  const tickHeight = height + 4;
  return (
    <View style={{ height: tickHeight, justifyContent: "center" }}>
      <View
        style={{
          height,
          borderRadius: height / 2,
          // Outlined like host-monitor's meters, so the empty part of the track reads as a track.
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        }}
      >
        {total > 0 ? (
          <View style={{ width: `${(total / scale) * 100}%`, minWidth: 2 }}>
            <ShareBar theme={theme} segments={segments} height={height - 2} />
          </View>
        ) : null}
      </View>
      <View
        style={{
          position: "absolute",
          left: `${(average / scale) * 100}%`,
          width: 2,
          height: tickHeight,
          marginLeft: -1,
          borderRadius: 1,
          backgroundColor: estimated ? theme.colors.foregroundMuted : theme.colors.foreground,
        }}
      />
    </View>
  );
}

export function agentSegments(
  theme: PluginTheme,
  order: readonly string[],
  period: UsagePeriod | undefined,
  measure: "totalTokens" | "cost" = "totalTokens",
): ShareSegment[] {
  if (!period) return [];
  return foldAgents(period.agents, order).map((agent) => ({
    key: agent.agent,
    value: agent.usage[measure],
    swatch: agentSwatch(theme, order, agent.agent),
  }));
}

/**
 * Stacked columns, one per period, agents bottom-up in legend order. The selected column is
 * full strength and the rest recede; pressing a column selects it.
 */
export function PeriodBars({
  theme,
  kind,
  periods,
  order,
  selected,
  onSelect,
  height,
  labelEvery,
}: {
  theme: PluginTheme;
  kind: PeriodKind;
  periods: readonly UsagePeriod[];
  order: readonly string[];
  selected: number;
  onSelect(index: number): void;
  height: number;
  /** Label every Nth column, counted back from the newest. */
  labelEvery: number;
}) {
  const peak = Math.max(1, ...periods.map((period) => period.usage.totalTokens));
  const columnGap = periods.length > 20 ? 2 : 4;
  const lastIndex = periods.length - 1;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap: columnGap }}>
        {periods.map((period, index) => {
          const isSelected = index === selected;
          const barHeight = (period.usage.totalTokens / peak) * height;
          const segments = agentSegments(theme, order, period).filter((s) => s.value > 0);
          return (
            <Pressable
              key={period.period}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${formatPeriodLong(kind, period.period)}: ${formatTokens(period.usage.totalTokens)} tokens`}
              onPress={() => onSelect(index)}
              // The whole column height is the hit target, not just the bar.
              style={({ hovered }: HoverState) => ({
                flex: 1,
                height: "100%" as const,
                justifyContent: "flex-end" as const,
                borderRadius: 3,
                backgroundColor: hovered && !isSelected ? theme.colors.surface2 : undefined,
              })}
            >
              {segments.length === 0 ? (
                <View
                  style={{ height: 2, borderRadius: 1, backgroundColor: theme.colors.surface2 }}
                />
              ) : (
                <View
                  style={{
                    height: Math.max(barHeight, 3),
                    // Bottom-up: the heaviest agent sits on the baseline.
                    flexDirection: "column-reverse",
                    gap: barHeight > segments.length * 4 ? 1 : 0,
                    borderTopLeftRadius: 3,
                    borderTopRightRadius: 3,
                    overflow: "hidden",
                    opacity: isSelected ? 1 : 0.45,
                  }}
                >
                  {segments.map((segment) => (
                    <View
                      key={segment.key}
                      style={{
                        flexGrow: segment.value,
                        flexBasis: 0,
                        backgroundColor: segment.swatch.color,
                        opacity: segment.swatch.opacity,
                      }}
                    />
                  ))}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: columnGap }}>
        {periods.map((period, index) => {
          const labelled = (lastIndex - index) % labelEvery === 0 || index === selected;
          return (
            <View
              key={period.period}
              style={{ flex: 1, alignItems: "center", overflow: "visible" }}
            >
              {labelled ? (
                <Text
                  numberOfLines={1}
                  style={{
                    // Wider than its column so "Oct 5" fits; neighbours are unlabelled.
                    width: 48,
                    textAlign: "center",
                    fontSize: 10,
                    color:
                      index === selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {formatPeriodShort(kind, period.period)}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** One line per agent present in the window: swatch and name. Identity never rests on color alone. */
export function Legend({
  theme,
  order,
  periods,
}: {
  theme: PluginTheme;
  order: readonly string[];
  periods: readonly UsagePeriod[];
}) {
  const present = new Set(
    periods.flatMap((period) => foldAgents(period.agents, order).map((a) => a.agent)),
  );
  const keys = [
    ...order.filter((agent) => present.has(agent)),
    ...(present.has(OTHER_AGENT) ? [OTHER_AGENT] : []),
  ];
  if (keys.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 }}>
      {keys.map((agent) => (
        <View key={agent} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <SwatchDot swatch={agentSwatch(theme, order, agent)} />
          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
            {agentLabel(agent)}
          </Text>
        </View>
      ))}
    </View>
  );
}
