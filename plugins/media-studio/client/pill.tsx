import { settingsRpc } from "@getpaseo/plugin";
import type { PluginButtonRegistration, PluginClientContext, PluginText } from "@getpaseo/plugin/client";
import { projectSummaryRpc, type ProjectSummary } from "../shared/rpc";
import { settingsDefinition } from "../shared/settings";
import { messages } from "./i18n";
import { openInMediaPanel } from "./state";

const PILL_ID = "media";
const REFRESH_MS = 90_000;
// Files the agent wrote are on disk once its turn ends; a short wait lets renders finish closing.
const AFTER_TURN_DELAY_MS = 3_000;

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  cwd?: string | null;
  status?: string;
  archivedAt?: string | null;
}

function pillState(summary: ProjectSummary | undefined, enabled: boolean) {
  if (!enabled || !summary?.isMedia) return { visible: false };
  const { video, audio, image } = summary;
  return {
    visible: true,
    label: messages.message("pill.label", { count: video + audio + image }),
    title: messages.message("pill.title", { video, audio, image }),
  };
}

/**
 * A composer pill per agent whose folder looks like a media project, with the media count; it
 * opens the media panel. Pills start hidden, so agents in code folders never show one.
 */
export function contributeMediaPills(client: PluginClientContext): () => void {
  const agents = new Map<string, { cwd: string; status?: string; pill: PluginButtonRegistration<PluginText> }>();
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let freshDirs = new Set<string>();

  const enabled = async () => {
    const stored = await client.rpc(settingsRpc(settingsDefinition.id).read, {}).catch(() => null);
    const parsed = stored?.status === "ready" ? settingsDefinition.schema.safeParse(stored.values) : null;
    return parsed?.success ? parsed.data.composerPill : true;
  };

  const refresh = async () => {
    const dirs = [...new Set([...agents.values()].map((agent) => agent.cwd))].slice(0, 200);
    if (dirs.length === 0 || lifetime.signal.aborted) return;
    const fresh = freshDirs;
    freshDirs = new Set();
    try {
      const show = await enabled();
      // Folders that just had a turn scan again; the rest may answer from the daemon's cache.
      const [stale, cached] = await Promise.all([
        fresh.size ? client.rpc(projectSummaryRpc, { dirs: [...fresh], fresh: true }) : { projects: [] },
        client.rpc(projectSummaryRpc, { dirs: dirs.filter((dir) => !fresh.has(dir)), fresh: false }),
      ]);
      if (lifetime.signal.aborted) return;
      const byDir = new Map([...cached.projects, ...stale.projects].map((summary) => [summary.dir, summary]));
      for (const agent of agents.values()) agent.pill.update(pillState(byDir.get(agent.cwd), show));
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[media-studio] Media pill refresh failed", error);
    }
  };

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delay);
  };

  const unregister = (agentId: string) => {
    agents.get(agentId)?.pill.remove();
    agents.delete(agentId);
  };

  /** True when the pills need a refresh: a new agent, a new folder, or a finished turn. */
  const register = (agent: AgentLike): boolean => {
    if (lifetime.signal.aborted || !agent.workspaceId || !agent.cwd || agent.archivedAt) {
      unregister(agent.id);
      return false;
    }
    const known = agents.get(agent.id);
    if (known && known.cwd === agent.cwd) {
      const finished = known.status === "running" && agent.status !== "running";
      known.status = agent.status;
      if (finished) freshDirs.add(agent.cwd);
      return finished;
    }
    if (known) unregister(agent.id);
    const { workspaceId } = agent;
    const pill = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button: {
        title: messages.message("commands.open"),
        icon: "Clapperboard",
        visible: false,
        behavior: { kind: "action", onPress: () => openInMediaPanel(workspaceId, null) },
      },
    });
    agents.set(agent.id, { cwd: agent.cwd, status: agent.status, pill });
    return true;
  };

  const removeAll = () => {
    for (const agent of agents.values()) agent.pill.remove();
    agents.clear();
  };

  // The list subscription delivers the agents, then updates, and a fresh snapshot after a reconnect.
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
          if (update.kind !== "upsert") {
            unregister(update.agentId);
            return;
          }
          if (register(update.agent)) schedule(AFTER_TURN_DELAY_MS);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[media-studio] Agent observation failed", error);
    });

  const interval = setInterval(() => void refresh(), REFRESH_MS);
  return () => {
    lifetime.abort();
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    removeAll();
  };
}
