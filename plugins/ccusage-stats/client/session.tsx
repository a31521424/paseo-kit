import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { sessionUsageRpc, type SessionMatch } from "../shared/usage";
import { useSessionUsage } from "./data";
import { agentLabel, formatAgo, formatCost, formatTokens, shortSessionId } from "./format";
import { Composition, FONT } from "./summary";

const PILL_ID = "session-usage";
const PILL_REFRESH_MS = 60_000;
// The daemon refreshes its report a few seconds after a turn ends; ask after that.
const AFTER_TURN_DELAY_MS = 8_000;

function SessionUsageContent({ theme, layout, ...target }: PluginButtonContentProps) {
  const agentId = target.context === "agent" ? target.agentId : "";
  const { data, error, isPending } = useSessionUsage(agentId);
  const rootStyle = { gap: 12, padding: layout.compact ? 4 : 0, minWidth: 260 };
  const note = (text: string, color = theme.colors.foregroundMuted) => (
    <Text style={{ fontSize: FONT.body, color }}>{text}</Text>
  );

  if (!data) {
    return (
      <View style={rootStyle}>
        {isPending
          ? note("Reading usage logs...")
          : note(error?.message ?? "Usage is unavailable.", theme.colors.statusDanger)}
      </View>
    );
  }
  if (data.status === "unknown") {
    return (
      <View style={rootStyle}>{note("This agent has not started a provider session yet.")}</View>
    );
  }
  if (data.status === "pending") {
    return (
      <View style={rootStyle}>
        {note(`No usage recorded yet for session ${shortSessionId(data.providerSessionId)}.`)}
        {note(
          "ccusage reads Claude Code, Codex and other supported agents' logs. Usage appears after the first turn.",
        )}
      </View>
    );
  }

  const { session } = data;
  return (
    <View style={rootStyle}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          This session
        </Text>
        <View
          style={{ flexDirection: "row", alignItems: "baseline", columnGap: 8, flexWrap: "wrap" }}
        >
          <Text
            style={{
              fontSize: 22,
              fontWeight: "600",
              color: theme.colors.foreground,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatTokens(session.usage.totalTokens)}
          </Text>
          <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>tokens</Text>
          <Text
            style={{
              fontSize: FONT.title,
              color: theme.colors.foreground,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatCost(session.usage.cost)}
          </Text>
        </View>
      </View>
      <Composition theme={theme} usage={session.usage} />
      {session.models.length > 0 ? (
        <View style={{ gap: 4 }}>
          {session.models.map((model) => (
            <View key={model.model} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                numberOfLines={1}
                style={{ flex: 1, fontSize: FONT.body, color: theme.colors.foreground }}
              >
                {model.model}
              </Text>
              <Text
                style={{
                  fontSize: FONT.body,
                  color: theme.colors.foreground,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatTokens(model.usage.totalTokens)}
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
                {formatCost(model.usage.cost)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Link" size={12} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          {agentLabel(session.agent)} session {shortSessionId(session.id)}
          {session.lastActivity
            ? ` · last activity ${formatAgo(Date.parse(session.lastActivity))}`
            : ""}
        </Text>
      </View>
    </View>
  );
}

function pillLabel(match: SessionMatch | undefined): {
  visible: boolean;
  label?: string;
  title?: string;
} {
  if (match?.status !== "matched" || match.session.usage.totalTokens <= 0)
    return { visible: false };
  const { usage } = match.session;
  return {
    visible: true,
    label: formatTokens(usage.totalTokens),
    title: `Session usage: ${formatTokens(usage.totalTokens)} tokens, ${formatCost(usage.cost)}`,
  };
}

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  status?: string;
  archivedAt?: string | null;
}

/**
 * A composer pill per agent with this session's token total. Pills stay hidden until ccusage has
 * usage for the agent's provider session, so agents ccusage cannot read show nothing.
 */
export function contributeSessionPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const statuses = new Map<string, string | undefined>();
  const lifetime = new AbortController();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    const agentIds = [...pills.keys()];
    if (agentIds.length === 0 || lifetime.signal.aborted) return;
    try {
      const { sessions } = await client.rpc(sessionUsageRpc, { agentIds: agentIds.slice(0, 200) });
      if (lifetime.signal.aborted) return;
      for (const match of sessions) pills.get(match.agentId)?.update(pillLabel(match));
    } catch (error) {
      if (!lifetime.signal.aborted)
        console.warn("[ccusage-stats] Session usage refresh failed", error);
    }
  };

  const scheduleRefresh = (delay: number) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delay);
  };

  const register = (agent: AgentLike) => {
    if (lifetime.signal.aborted || !agent.workspaceId || agent.archivedAt) return false;
    const previous = statuses.get(agent.id);
    statuses.set(agent.id, agent.status);
    if (pills.has(agent.id)) {
      // A turn just finished: its usage is in the logs now.
      if (previous === "running" && agent.status !== "running")
        scheduleRefresh(AFTER_TURN_DELAY_MS);
      return false;
    }
    pills.set(
      agent.id,
      client.addComposerPill({
        id: PILL_ID,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Session token usage",
          icon: "Coins",
          visible: false,
          behavior: { kind: "popover", Content: SessionUsageContent },
        },
      }),
    );
    return true;
  };

  const unregister = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    statuses.delete(agentId);
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    statuses.clear();
  };

  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
          void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            if (update.agent.archivedAt) unregister(update.agent.id);
            else if (register(update.agent)) scheduleRefresh(1_000);
            return;
          }
          unregister(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted)
        console.error("[ccusage-stats] Agent observation failed", error);
    });

  const interval = setInterval(() => void refresh(), PILL_REFRESH_MS);

  return () => {
    lifetime.abort();
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    removeAll();
  };
}
