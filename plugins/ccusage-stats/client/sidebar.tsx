import type { PluginTheme } from "@getpaseo/plugin";
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
import type { PeriodKind } from "../shared/usage";
import { agentSegments, Legend, PERIOD_OPTIONS, PeriodBars, Segmented, ShareBar } from "./charts";
import { useUsageReport, type UsageReport } from "./data";
import { formatAgo, formatCost, formatTokens } from "./format";
import { AgentList, FONT, Headline } from "./summary";

// Geometry follows the built-in usage summary and host-monitor in the same footer.
const ICON_SIZE = 14;
const ICON_GAP = 6;
const TEXT_GAP = 8;
const MIN_METER_WIDTH = 24;
// Below these widths the meter, then the cost, drop out. Estimated from 12px tabular digits.
const WIDTH_FOR_COST = 120;
const WIDTH_FOR_METER = 170;
// Columns shown in the popover for each period kind.
const POPOVER_PERIODS: Record<PeriodKind, number> = { daily: 14, weekly: 8, monthly: 6 };

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function triggerStyle(theme: PluginTheme) {
  return ({ hovered }: HoverState) => ({
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

function todayOf(report: UsageReport) {
  return report.daily[report.daily.length - 1];
}

export function UsageSidebarItem({ theme, openPopover }: PluginSidebarItemProps) {
  const { data, error } = useUsageReport();
  const [available, setAvailable] = useState<number | null>(null);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setAvailable(event.nativeEvent.layout.width),
    [],
  );

  // Like the built-in usage summary: nothing until there is something to show.
  if (!data && !error) return null;
  const today = data ? todayOf(data) : undefined;
  const width = available ?? WIDTH_FOR_COST;
  const label = today
    ? `Token usage today: ${formatTokens(today.usage.totalTokens)} tokens, ${formatCost(today.usage.cost)}`
    : "Token usage unavailable";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => openPopover(UsagePopover)}
      style={triggerStyle(theme)}
    >
      <View
        onLayout={onLayout}
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <Icon name="Coins" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        {today && data ? (
          <>
            <Text
              numberOfLines={1}
              style={{
                marginLeft: ICON_GAP,
                fontSize: FONT.body,
                color: theme.colors.foreground,
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatTokens(today.usage.totalTokens)}
            </Text>
            {width >= WIDTH_FOR_METER ? (
              <View style={{ flex: 1, minWidth: MIN_METER_WIDTH, marginLeft: TEXT_GAP }}>
                <ShareBar theme={theme} segments={agentSegments(theme, data.agents, today)} />
              </View>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {width >= WIDTH_FOR_COST ? (
              <Text
                numberOfLines={1}
                style={{
                  marginLeft: TEXT_GAP,
                  fontSize: FONT.body,
                  color: theme.colors.foregroundMuted,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatCost(today.usage.cost)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text
            numberOfLines={1}
            style={{
              marginLeft: ICON_GAP,
              fontSize: FONT.body,
              color: theme.colors.foregroundMuted,
            }}
          >
            Usage unavailable
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function UsagePopover({ theme, layout, openScreen }: PluginPopoverProps) {
  const { data, error, isPending } = useUsageReport();
  const [kind, setKind] = useState<PeriodKind>("daily");
  const [picked, setPicked] = useState<number | null>(null);
  const rootStyle = {
    gap: 12,
    padding: layout.compact ? 16 : 12,
    width: layout.compact ? undefined : 320,
    backgroundColor: theme.colors.surface1,
  };

  if (!data) {
    return (
      <View style={rootStyle}>
        <Text style={{ fontSize: FONT.title, color: theme.colors.foreground }}>Token usage</Text>
        <Text
          style={{
            fontSize: FONT.body,
            color: isPending ? theme.colors.foregroundMuted : theme.colors.statusDanger,
          }}
        >
          {isPending ? "Reading usage logs..." : (error?.message ?? "Usage is unavailable.")}
        </Text>
      </View>
    );
  }

  const periods = data[kind].slice(-POPOVER_PERIODS[kind]);
  const selected = picked !== null && picked < periods.length ? picked : periods.length - 1;
  const changeKind = (next: PeriodKind) => {
    setKind(next);
    setPicked(null);
  };

  return (
    <View style={rootStyle}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: FONT.title, color: theme.colors.foreground }}>
          Token usage
        </Text>
        <Segmented
          theme={theme}
          options={PERIOD_OPTIONS}
          value={kind}
          onChange={changeKind}
          accessibilityLabel="Period"
        />
      </View>
      <Headline theme={theme} kind={kind} periods={periods} index={selected} heroSize={22} />
      <PeriodBars
        theme={theme}
        kind={kind}
        periods={periods}
        order={data.agents}
        selected={selected}
        onSelect={setPicked}
        height={52}
        labelEvery={kind === "daily" ? 7 : kind === "weekly" ? 4 : 3}
      />
      <Legend theme={theme} order={data.agents} periods={periods} />
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
      <AgentList theme={theme} order={data.agents} period={periods[selected]} />
      <Footer theme={theme} report={data} onMore={() => openScreen({ screenId: "usage" })} />
    </View>
  );
}

function Footer({
  theme,
  report,
  onMore,
}: {
  theme: PluginTheme;
  report: UsageReport;
  onMore(): void;
}) {
  return (
    <View style={{ gap: 6 }}>
      {report.refreshError ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
          <Text
            numberOfLines={2}
            style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.statusWarning }}
          >
            Showing older numbers: {report.refreshError}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          Updated {formatAgo(report.generatedAt)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open usage details"
          onPress={onMore}
          style={({ hovered }: HoverState) => ({
            flexDirection: "row" as const,
            alignItems: "center" as const,
            gap: 2,
            paddingVertical: 3,
            paddingLeft: 8,
            paddingRight: 4,
            borderRadius: 6,
            backgroundColor: hovered ? theme.colors.surface2 : undefined,
          })}
        >
          <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>Details</Text>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
  );
}
