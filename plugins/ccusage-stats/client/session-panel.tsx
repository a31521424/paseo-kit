import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import {
  addUsage,
  EMPTY_USAGE,
  type ChildAgentUsage,
  type ModelUsage,
  type SubagentUsage,
  type Usage,
} from "../shared/usage";
import { ShareBar, SwatchDot, type ShareSegment } from "./charts";
import { useSessionDetail, type SessionDetail, type Swatch } from "./data";
import {
  agentLabel,
  formatAgo,
  formatCost,
  formatPercent,
  formatTokens,
  shortSessionId,
} from "./format";
import { Card, Stat } from "./screen";
import { Composition, FONT } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

const MAX_CONTENT_WIDTH = 960;
// From this width the panel lays its cards out in two columns and shows every token column.
const WIDE_MIN_WIDTH = 640;
// Longer lists start collapsed.
const SUBAGENTS_SHOWN = 6;
const CHILDREN_SHOWN = 8;

function subtract(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(a.inputTokens - b.inputTokens, 0),
    outputTokens: Math.max(a.outputTokens - b.outputTokens, 0),
    cacheCreationTokens: Math.max(a.cacheCreationTokens - b.cacheCreationTokens, 0),
    cacheReadTokens: Math.max(a.cacheReadTokens - b.cacheReadTokens, 0),
    totalTokens: Math.max(a.totalTokens - b.totalTokens, 0),
    cost: Math.max(a.cost - b.cost, 0),
  };
}

function sumUsage(usages: readonly Usage[]): Usage {
  return usages.reduce(addUsage, EMPTY_USAGE);
}

function Muted({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>{children}</Text>
  );
}

function Numbers({ theme, usage, share }: { theme: PluginTheme; usage: Usage; share?: number }) {
  const number = { fontSize: FONT.body, fontVariant: ["tabular-nums" as const] };
  return (
    <>
      {share !== undefined ? (
        <Text
          style={[number, { width: 40, textAlign: "right", color: theme.colors.foregroundMuted }]}
        >
          {formatPercent(share)}
        </Text>
      ) : null}
      <Text style={[number, { width: 52, textAlign: "right", color: theme.colors.foreground }]}>
        {formatTokens(usage.totalTokens)}
      </Text>
      <Text style={[number, { width: 56, textAlign: "right", color: theme.colors.foreground }]}>
        {formatCost(usage.cost)}
      </Text>
    </>
  );
}

function Row({
  theme,
  swatch,
  title,
  detail,
  usage,
  share,
}: {
  theme: PluginTheme;
  swatch?: Swatch;
  title: string;
  detail?: string | null;
  usage: Usage;
  share?: number;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
      {swatch ? <SwatchDot swatch={swatch} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
          {title}
        </Text>
        {detail ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      <Numbers theme={theme} usage={usage} share={share} />
    </View>
  );
}

function ColumnHeader({ theme, share }: { theme: PluginTheme; share?: boolean }) {
  const label = {
    fontSize: FONT.caption,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1 }} />
      {share ? <Text style={[label, { width: 40 }]}>Share</Text> : null}
      <Text style={[label, { width: 52 }]}>Tokens</Text>
      <Text style={[label, { width: 56 }]}>Cost</Text>
    </View>
  );
}

function Notice({
  theme,
  icon,
  color,
  children,
}: {
  theme: PluginTheme;
  icon: string;
  color?: string;
  children: ReactNode;
}) {
  const tint = color ?? theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={13} color={tint} />
      </View>
      <Text style={{ flex: 1, fontSize: FONT.caption, color: tint }}>{children}</Text>
    </View>
  );
}

function ShowAllToggle({
  theme,
  total,
  showAll,
  onToggle,
}: {
  theme: PluginTheme;
  total: number;
  showAll: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onToggle}
      style={({ hovered }: HoverState) => ({
        alignSelf: "flex-start",
        marginTop: 4,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text style={{ fontSize: FONT.caption, color: theme.colors.foreground }}>
        {showAll ? "Show fewer" : `Show all ${total}`}
      </Text>
    </Pressable>
  );
}

function Overview({
  theme,
  usage,
  childTotal,
  childCount,
}: {
  theme: PluginTheme;
  usage: Usage;
  childTotal: Usage;
  childCount: number;
}) {
  const prompt = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const perMillion = usage.totalTokens > 0 ? usage.cost / (usage.totalTokens / 1_000_000) : 0;
  return (
    <Card theme={theme} title="This session">
      <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12, columnGap: 16 }}>
        <Stat
          theme={theme}
          label="Cost"
          value={formatCost(usage.cost)}
          detail={`${formatCost(perMillion)} per 1M tokens`}
        />
        <Stat
          theme={theme}
          label="Tokens"
          value={formatTokens(usage.totalTokens)}
          detail={`${formatTokens(usage.outputTokens)} generated`}
        />
        <Stat
          theme={theme}
          label="Cache hit rate"
          value={prompt > 0 ? formatPercent(usage.cacheReadTokens / prompt) : "—"}
          detail="of prompt tokens read from cache"
        />
        {childTotal.totalTokens > 0 ? (
          <Stat
            theme={theme}
            label="With child agents"
            value={formatCost(usage.cost + childTotal.cost)}
            detail={`+${formatCost(childTotal.cost)} across ${childCount} ${childCount === 1 ? "agent" : "agents"}`}
          />
        ) : null}
      </View>
      <Composition theme={theme} usage={usage} />
    </Card>
  );
}

function subagentTitle(subagent: SubagentUsage): string {
  return subagent.description ?? subagent.type ?? shortSessionId(subagent.id);
}

function subagentDetail(subagent: SubagentUsage): string {
  return [
    subagent.description ? subagent.type : null,
    subagent.models[0]?.model,
    subagent.lastActivity ? formatAgo(Date.parse(subagent.lastActivity)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The session total split into the main conversation and its Task subagents, plus child agents. */
function Breakdown({
  theme,
  usage,
  subagents,
  subagentsError,
  childTotal,
  childCount,
}: {
  theme: PluginTheme;
  usage: Usage;
  subagents: readonly SubagentUsage[];
  subagentsError: string | null;
  childTotal: Usage;
  childCount: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const subagentTotal = sumUsage(subagents.map((subagent) => subagent.usage));
  const main = subtract(usage, subagentTotal);
  const swatches = {
    main: { color: theme.colors.accent, opacity: 1 },
    subagents: { color: theme.colors.accent, opacity: 0.45 },
    children: { color: theme.colors.foregroundMuted, opacity: 0.6 },
  } satisfies Record<string, Swatch>;
  const grand = Math.max(usage.cost + childTotal.cost, Number.EPSILON);
  const segments: ShareSegment[] = [
    { key: "main", value: main.cost, swatch: swatches.main },
    { key: "subagents", value: subagentTotal.cost, swatch: swatches.subagents },
    { key: "children", value: childTotal.cost, swatch: swatches.children },
  ];
  const shown = showAll ? subagents : subagents.slice(0, SUBAGENTS_SHOWN);

  return (
    <Card theme={theme} title="Where it went" trailing={<Muted theme={theme}>Share of cost</Muted>}>
      <ShareBar theme={theme} segments={segments} height={8} />
      <View>
        <ColumnHeader theme={theme} share />
        <Row
          theme={theme}
          swatch={swatches.main}
          title="Main conversation"
          usage={main}
          share={main.cost / grand}
        />
        {subagents.length > 0 ? (
          <Row
            theme={theme}
            swatch={swatches.subagents}
            title={`Subagents (${subagents.length})`}
            detail="Claude Code Task agents"
            usage={subagentTotal}
            share={subagentTotal.cost / grand}
          />
        ) : null}
        {childCount > 0 ? (
          <Row
            theme={theme}
            swatch={swatches.children}
            title={`Child agents (${childCount})`}
            detail="Started through Paseo"
            usage={childTotal}
            share={childTotal.cost / grand}
          />
        ) : null}
      </View>
      {subagentsError ? (
        <Notice theme={theme} icon="TriangleAlert" color={theme.colors.statusWarning}>
          Subagent costs are unavailable: {subagentsError}. The session total still includes them.
        </Notice>
      ) : null}
      {subagents.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text
            style={{
              fontSize: FONT.caption,
              fontWeight: "600",
              color: theme.colors.foregroundMuted,
            }}
          >
            SUBAGENTS
          </Text>
          {shown.map((subagent) => (
            <Row
              key={subagent.id}
              theme={theme}
              title={subagentTitle(subagent)}
              detail={subagentDetail(subagent)}
              usage={subagent.usage}
            />
          ))}
          {subagents.length > SUBAGENTS_SHOWN ? (
            <ShowAllToggle
              theme={theme}
              total={subagents.length}
              showAll={showAll}
              onToggle={() => setShowAll((value) => !value)}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Models({
  theme,
  models,
  wide,
}: {
  theme: PluginTheme;
  models: readonly ModelUsage[];
  wide: boolean;
}) {
  const columns: { key: string; label: string; value: (usage: Usage) => string; width: number }[] =
    wide
      ? [
          { key: "input", label: "Input", value: (u) => formatTokens(u.inputTokens), width: 52 },
          { key: "output", label: "Output", value: (u) => formatTokens(u.outputTokens), width: 52 },
          {
            key: "write",
            label: "Cache write",
            value: (u) => formatTokens(u.cacheCreationTokens),
            width: 72,
          },
          {
            key: "read",
            label: "Cache read",
            value: (u) => formatTokens(u.cacheReadTokens),
            width: 72,
          },
          { key: "cost", label: "Cost", value: (u) => formatCost(u.cost), width: 56 },
        ]
      : [
          { key: "tokens", label: "Tokens", value: (u) => formatTokens(u.totalTokens), width: 52 },
          { key: "cost", label: "Cost", value: (u) => formatCost(u.cost), width: 56 },
        ];
  const cell = {
    fontSize: FONT.body,
    textAlign: "right" as const,
    fontVariant: ["tabular-nums" as const],
  };
  return (
    <Card theme={theme} title="Models">
      {models.length === 0 ? (
        <Muted theme={theme}>No model usage recorded.</Muted>
      ) : (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }} />
            {columns.map((column) => (
              <Text
                key={column.key}
                style={{
                  width: column.width,
                  fontSize: FONT.caption,
                  color: theme.colors.foregroundMuted,
                  textAlign: "right",
                }}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {models.map((model) => (
            <View
              key={model.model}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}
            >
              <Text
                numberOfLines={1}
                style={{ flex: 1, fontSize: FONT.body, color: theme.colors.foreground }}
              >
                {model.model}
              </Text>
              {columns.map((column) => (
                <Text
                  key={column.key}
                  style={[cell, { width: column.width, color: theme.colors.foreground }]}
                >
                  {column.value(model.usage)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

function childStatus(child: ChildAgentUsage): string {
  const parts = [agentLabel(child.provider)];
  if (child.unlisted) parts.push("project removed");
  else if (child.archived) parts.push("archived");
  if (child.match.status === "pending") parts.push("no usage recorded yet");
  if (child.match.status === "unknown") parts.push("no provider session");
  if (child.match.status === "matched" && child.match.session.lastActivity) {
    parts.push(formatAgo(Date.parse(child.match.session.lastActivity)));
  }
  return parts.join(" · ");
}

function Children({
  theme,
  children,
}: {
  theme: PluginTheme;
  children: readonly ChildAgentUsage[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? children : children.slice(0, CHILDREN_SHOWN);
  return (
    <Card theme={theme} title={`Child agents (${children.length})`}>
      <Muted theme={theme}>
        Agents this agent started through Paseo. Each has its own session, so their usage is not
        part of this session's total.
      </Muted>
      <View>
        <ColumnHeader theme={theme} />
        {shown.map((child) => (
          <Row
            key={child.agentId}
            theme={theme}
            title={child.title ?? "Untitled agent"}
            detail={childStatus(child)}
            usage={child.match.status === "matched" ? child.match.session.usage : EMPTY_USAGE}
          />
        ))}
      </View>
      {children.length > CHILDREN_SHOWN ? (
        <ShowAllToggle
          theme={theme}
          total={children.length}
          showAll={showAll}
          onToggle={() => setShowAll((value) => !value)}
        />
      ) : null}
    </Card>
  );
}

function Header({ theme, detail }: { theme: PluginTheme; detail: SessionDetail }) {
  const { match } = detail;
  const facts =
    match.status === "matched"
      ? [
          `${agentLabel(match.session.agent)} session ${shortSessionId(match.providerSessionId)}`,
          match.session.lastActivity
            ? `last activity ${formatAgo(Date.parse(match.session.lastActivity))}`
            : null,
        ]
      : match.status === "pending"
        ? [`Session ${shortSessionId(match.providerSessionId)}`]
        : [];
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.foreground }}>
        Session usage
      </Text>
      {facts.length > 0 ? <Muted theme={theme}>{facts.filter(Boolean).join(" · ")}</Muted> : null}
      {match.status === "matched" && match.earlierSegments > 0 ? (
        <Notice theme={theme} icon="History">
          Includes {match.earlierSegments} earlier{" "}
          {match.earlierSegments === 1 ? "session" : "sessions"} this conversation was resumed or
          forked from.
        </Notice>
      ) : null}
    </View>
  );
}

function Body({
  theme,
  detail,
  wide,
}: {
  theme: PluginTheme;
  detail: SessionDetail;
  wide: boolean;
}) {
  const { match, subagents, subagentsError, children } = detail;
  const childTotal = sumUsage(
    children.map((child) =>
      child.match.status === "matched" ? child.match.session.usage : EMPTY_USAGE,
    ),
  );
  const childCard = children.length > 0 ? <Children theme={theme} children={children} /> : null;

  if (match.status !== "matched") {
    return (
      <View style={{ gap: 12 }}>
        <Card theme={theme} title="This session">
          <Muted theme={theme}>
            {match.status === "pending"
              ? "No usage recorded yet. ccusage reads Claude Code, Codex and other supported agents' logs; usage appears after the first turn."
              : "This agent has not started a provider session yet."}
          </Muted>
        </Card>
        {childCard}
      </View>
    );
  }

  const { usage, models } = match.session;
  const overview = (
    <Overview theme={theme} usage={usage} childTotal={childTotal} childCount={children.length} />
  );
  const breakdown =
    subagents.length > 0 || children.length > 0 || subagentsError ? (
      <Breakdown
        theme={theme}
        usage={usage}
        subagents={subagents}
        subagentsError={subagentsError}
        childTotal={childTotal}
        childCount={children.length}
      />
    ) : null;
  const modelCard = <Models theme={theme} models={models} wide={wide} />;

  if (!wide) {
    return (
      <View style={{ gap: 12 }}>
        {overview}
        {breakdown}
        {childCard}
        {modelCard}
      </View>
    );
  }
  // Wide: the split and the child agents side by side, then the model table across the panel.
  return (
    <View style={{ gap: 12 }}>
      {overview}
      {breakdown && childCard ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>{breakdown}</View>
          <View style={{ flex: 1, minWidth: 0 }}>{childCard}</View>
        </View>
      ) : (
        (breakdown ?? childCard)
      )}
      {modelCard}
    </View>
  );
}

/** The agent panel the session pill opens. */
export function SessionUsagePanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const { data, error, isPending } = useSessionDetail(agentId);
  const [width, setWidth] = useState(0);
  const padding = layout.compact ? 12 : 16;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, alignItems: "center" }}
    >
      <View
        style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, gap: 12 }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {data ? (
          <>
            <Header theme={theme} detail={data} />
            <Body theme={theme} detail={data} wide={!layout.compact && width >= WIDE_MIN_WIDTH} />
            <Muted theme={theme}>
              Read by ccusage from local agent logs on this host. Costs are estimates from ccusage's
              built-in pricing table, not your bill. Updated {formatAgo(data.generatedAt)}.
            </Muted>
          </>
        ) : (
          <View style={{ gap: 8, paddingVertical: 48, alignItems: "center" }}>
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
            {error ? <Muted theme={theme}>{error.message}</Muted> : null}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
