import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import type { PeriodKind, SessionUsage, UsagePeriod } from "../shared/usage";
import { Legend, PERIOD_OPTIONS, PeriodBars, Segmented, SwatchDot } from "./charts";
import { agentSwatch, useUsageReport, type UsageReport } from "./data";
import {
  agentLabel,
  CURRENT_LABEL,
  formatAgo,
  formatCost,
  formatPercent,
  formatPeriodLong,
  formatTokens,
  shortSessionId,
} from "./format";
import { AgentList, Composition, FONT, Headline } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

const MAX_CONTENT_WIDTH = 880;

function Card({
  theme,
  title,
  trailing,
  children,
}: {
  theme: PluginTheme;
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            flex: 1,
            fontSize: FONT.title,
            fontWeight: "600",
            color: theme.colors.foreground,
          }}
        >
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

function Stat({
  theme,
  label,
  value,
  detail,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 120, gap: 2 }}>
      <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 18,
          fontWeight: "600",
          color: theme.colors.foreground,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      {detail ? (
        <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Cache reads are billed far below fresh input, so their share explains most of the cost. */
function Stats({ theme, period }: { theme: PluginTheme; period: UsagePeriod }) {
  const { usage } = period;
  const prompt = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const perMillion = usage.totalTokens > 0 ? usage.cost / (usage.totalTokens / 1_000_000) : 0;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12, columnGap: 16 }}>
      <Stat
        theme={theme}
        label="Cost"
        value={formatCost(usage.cost)}
        detail={`${formatCost(perMillion)} per 1M tokens`}
      />
      <Stat
        theme={theme}
        label="Cache hit rate"
        value={prompt > 0 ? formatPercent(usage.cacheReadTokens / prompt) : "—"}
        detail="of prompt tokens read from cache"
      />
      <Stat
        theme={theme}
        label="Output"
        value={formatTokens(usage.outputTokens)}
        detail="tokens generated"
      />
      <Stat
        theme={theme}
        label="Agents"
        value={`${period.agents.length}`}
        detail={`${new Set(period.agents.flatMap((a) => a.models.map((m) => m.model))).size} models`}
      />
    </View>
  );
}

function SessionRow({
  theme,
  order,
  session,
}: {
  theme: PluginTheme;
  order: readonly string[];
  session: SessionUsage;
}) {
  const topModel = session.models[0]?.model;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
      <SwatchDot swatch={agentSwatch(theme, order, session.agent)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
          {agentLabel(session.agent)}
          <Text style={{ color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>
            {"  "}
            {shortSessionId(session.id)}
          </Text>
        </Text>
        <Text
          numberOfLines={1}
          style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}
        >
          {[topModel, session.lastActivity ? formatAgo(Date.parse(session.lastActivity)) : null]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      <Text
        style={{
          fontSize: FONT.body,
          color: theme.colors.foreground,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatTokens(session.usage.totalTokens)}
      </Text>
      <Text
        style={{
          width: 52,
          textAlign: "right",
          fontSize: FONT.body,
          color: theme.colors.foregroundMuted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatCost(session.usage.cost)}
      </Text>
    </View>
  );
}

function Body({
  theme,
  compact,
  report,
}: {
  theme: PluginTheme;
  compact: boolean;
  report: UsageReport;
}) {
  const [kind, setKind] = useState<PeriodKind>("daily");
  const [picked, setPicked] = useState<number | null>(null);
  const all = report[kind];
  // A phone shows half the columns so each stays wide enough to press.
  const periods = compact ? all.slice(-Math.ceil(all.length / 2)) : all;
  const selected = picked !== null && picked < periods.length ? picked : periods.length - 1;
  const period = periods[selected];
  const changeKind = (next: PeriodKind) => {
    setKind(next);
    setPicked(null);
  };
  const periodTitle = period
    ? selected === periods.length - 1
      ? CURRENT_LABEL[kind]
      : formatPeriodLong(kind, period.period)
    : "";

  return (
    <View style={{ gap: compact ? 12 : 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Segmented
          theme={theme}
          options={PERIOD_OPTIONS}
          value={kind}
          onChange={changeKind}
          accessibilityLabel="Period"
        />
        <Text
          style={{
            flex: 1,
            fontSize: FONT.caption,
            color: theme.colors.foregroundMuted,
            textAlign: "right",
          }}
        >
          Updated {formatAgo(report.generatedAt)} · {report.timezone}
        </Text>
      </View>
      {report.refreshError ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
          <Text style={{ flex: 1, fontSize: FONT.body, color: theme.colors.statusWarning }}>
            Showing older numbers: {report.refreshError}
          </Text>
        </View>
      ) : null}

      <Card theme={theme} title="Tokens">
        <Headline
          theme={theme}
          kind={kind}
          periods={periods}
          index={selected}
          heroSize={compact ? 26 : 30}
        />
        <PeriodBars
          theme={theme}
          kind={kind}
          periods={periods}
          order={report.agents}
          selected={selected}
          onSelect={setPicked}
          height={compact ? 110 : 150}
          labelEvery={kind === "daily" ? 7 : kind === "weekly" ? 2 : compact ? 2 : 1}
        />
        <Legend theme={theme} order={report.agents} periods={periods} />
      </Card>

      {period ? (
        <>
          <Card theme={theme} title={periodTitle}>
            <Stats theme={theme} period={period} />
            <Composition theme={theme} usage={period.usage} />
          </Card>
          <Card
            theme={theme}
            title="By agent"
            trailing={
              <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
                Press an agent for its models
              </Text>
            }
          >
            <AgentList theme={theme} order={report.agents} period={period} expandable />
          </Card>
        </>
      ) : null}

      <Card theme={theme} title="Recent sessions">
        {report.recentSessions.length === 0 ? (
          <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
            No sessions yet.
          </Text>
        ) : (
          <View>
            {report.recentSessions.map((session) => (
              <SessionRow
                key={`${session.agent}:${session.id}`}
                theme={theme}
                order={report.agents}
                session={session}
              />
            ))}
          </View>
        )}
      </Card>

      <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
        Read by ccusage from local agent logs on this host. Costs are estimates from ccusage's
        built-in pricing table, not your bill.
      </Text>
    </View>
  );
}

export function UsageScreen({ theme, layout }: PluginScreenProps) {
  const { data, error, isPending, refetch, isRefetching } = useUsageReport();
  const padding = layout.compact ? 16 : 24;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, alignItems: "center" }}
    >
      <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH }}>
        {data ? (
          <Body theme={theme} compact={layout.compact} report={data} />
        ) : (
          <View style={{ gap: 12, paddingVertical: 48, alignItems: "center" }}>
            <Icon
              name={isPending ? "Hourglass" : "CircleAlert"}
              size={20}
              color={isPending ? theme.colors.foregroundMuted : theme.colors.statusDanger}
            />
            <Text
              style={{ fontSize: FONT.title, color: theme.colors.foreground, textAlign: "center" }}
            >
              {isPending ? "Reading usage logs..." : "Could not read usage"}
            </Text>
            {error ? (
              <Text
                style={{
                  fontSize: FONT.body,
                  color: theme.colors.foregroundMuted,
                  textAlign: "center",
                }}
              >
                {error.message}
              </Text>
            ) : null}
            {!isPending ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try again"
                disabled={isRefetching}
                onPress={() => void refetch()}
                style={({ hovered }: HoverState) => ({
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor: hovered ? theme.colors.surface1 : theme.colors.surface2,
                })}
              >
                <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
                  {isRefetching ? "Trying..." : "Try again"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
