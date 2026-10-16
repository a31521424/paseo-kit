import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { closedAgentsRpc, restoreAgentRpc, type ClosedAgent } from "../shared/agents";

const REFRESH_MS = 5_000;
// How long to wait for a restored agent to show up as running before giving up on opening its tab.
const OPEN_TIMEOUT_MS = 15_000;

type Navigation = NonNullable<PluginWorkspacePanelProps["navigation"]>;

export function ClosedAgentsPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const listClosed = useRpc(closedAgentsRpc);
  const restore = useRpc(restoreAgentRpc);
  const toast = useToast();
  const closed = useQuery({
    queryKey: ["closed-agents", workspaceId],
    queryFn: () => listClosed({ workspaceId }),
    refetchInterval: REFRESH_MS,
  });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  async function reopen(agent: ClosedAgent) {
    if (restoring) return;
    setRestoring(agent.id);
    try {
      await restore({ workspaceId, agentId: agent.id });
      setOpening(agent.id);
      void closed.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRestoring(null);
    }
  }

  const padding = layout.compact ? 12 : 16;
  const muted = theme.colors.foregroundMuted;
  const agents = closed.data?.agents ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ gap: 4, paddingHorizontal: padding, paddingTop: padding, paddingBottom: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>Closed agents</Text>
        <Text style={{ color: muted, fontSize: 12 }}>
          Closing an agent's tab archives it. Reopen restores the agent and its tab with the full history.
        </Text>
      </View>
      {closed.isError ? (
        <Empty theme={theme} icon="TriangleAlert" text={String(closed.error)} />
      ) : !closed.data ? (
        <Empty theme={theme} loading text="Loading" />
      ) : agents.length === 0 ? (
        <Empty theme={theme} icon="ArchiveRestore" text="No closed agents in this workspace." />
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(agent) => agent.id}
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => (
            <AgentRow
              theme={theme}
              compact={layout.compact}
              agent={item}
              busy={restoring === item.id}
              disabled={restoring !== null && restoring !== item.id}
              onReopen={() => void reopen(item)}
            />
          )}
        />
      )}
      {opening ? (
        <OpenWhenRunning
          key={opening}
          agentId={opening}
          navigation={navigation}
          onDone={(opened) => {
            setOpening(null);
            if (!opened) toast.show("Agent restored. Open it from the sidebar.", { variant: "success" });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Opens the restored agent's tab once the app sees it running. Opening it while the app still
 * holds the agent as archived would let the workspace close the tab again right away.
 */
function OpenWhenRunning({
  agentId,
  navigation,
  onDone,
}: {
  agentId: string;
  navigation: Navigation | undefined;
  onDone(opened: boolean): void;
}) {
  const status = useAgent(agentId, (agent) => ({ status: agent.status }))?.status ?? null;
  // The parent passes a fresh callback on every render; the timeout must not restart with it.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const timer = setTimeout(() => done.current(false), OPEN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!navigation) {
      done.current(false);
    } else if (status && status !== "closed") {
      navigation.openAgent({ agentId });
      done.current(true);
    }
  }, [status, navigation, agentId]);
  return null;
}

function AgentRow({
  theme,
  compact,
  agent,
  busy,
  disabled,
  onReopen,
}: {
  theme: PluginTheme;
  compact: boolean;
  agent: ClosedAgent;
  busy: boolean;
  disabled: boolean;
  onReopen(): void;
}) {
  const muted = theme.colors.foregroundMuted;
  const model = agent.model ? `${agent.provider} · ${agent.model}` : agent.provider;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reopen ${agent.title ?? "untitled agent"}`}
      disabled={busy || disabled}
      onPress={onReopen}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: 10,
        opacity: disabled ? 0.5 : 1,
        backgroundColor:
          (state as { hovered?: boolean }).hovered || state.pressed ? theme.colors.surface1 : "transparent",
      })}
    >
      <Icon name="Bot" size={16} color={muted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {agent.title ?? "Untitled agent"}
        </Text>
        <Text numberOfLines={1} style={{ color: muted, fontSize: 11 }}>
          Closed {formatAgo(Date.parse(agent.archivedAt))} · {model}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={muted} />
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="RotateCcw" size={14} color={theme.colors.foreground} />
          {compact ? null : <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Reopen</Text>}
        </View>
      )}
    </Pressable>
  );
}

function Empty({ theme, text, icon, loading }: { theme: PluginTheme; text: string; icon?: string; loading?: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
      {loading ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
      {icon ? <Icon name={icon} size={24} color={theme.colors.foregroundMuted} /> : null}
      <Text selectable style={{ color: theme.colors.foregroundMuted, textAlign: "center", maxWidth: 360 }}>
        {text}
      </Text>
    </View>
  );
}

function formatAgo(timeMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timeMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timeMs).toLocaleDateString();
}
