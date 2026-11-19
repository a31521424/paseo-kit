import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  addUsage,
  EMPTY_USAGE,
  mergeModels,
  type ChildAgentUsage,
  type SessionMatch,
  type SessionUsage,
  type sessionDetailRpc,
  type sessionUsageRpc,
} from "../shared/usage";
import type { AgentStore } from "./agent-store";
import type { ClaudeLogs } from "./claude-logs";
import type { ReportCache } from "./report";
import type { SubagentPricer } from "./subagents";

type PaseoApi = PluginHandlerContext["paseo"];

// A provider session id rarely changes once an agent has one; a resume or refresh can replace it.
const SESSION_ID_TTL_MS = 5 * 60_000;
// Paseo labels agents started from inside another agent (`paseo run`, MCP) with their parent.
const PARENT_LABEL = "paseo.parent-agent-id";
const MAX_CHILDREN = 100;

interface CachedSessionId {
  /** null: the agent has no provider session yet. */
  sessionId: string | null;
  at: number;
}

/**
 * Paseo agents carry their provider's session handle: a Claude Code session UUID, which is
 * ccusage's session key, or a Codex thread id, which ends ccusage's rollout file name
 * (`rollout-<time>-<thread id>`, sometimes under a `YYYY/MM/DD/` path).
 */
export function sessionKeyMatches(ccusageId: string, providerSessionId: string): boolean {
  if (ccusageId === providerSessionId) return true;
  return ccusageId.endsWith(`-${providerSessionId}`) || ccusageId.endsWith(`/${providerSessionId}`);
}

/** One session for the whole conversation: the current session's id, every segment's usage. */
function combine(sessionId: string, segments: SessionUsage[]): SessionUsage {
  const [first] = segments;
  return {
    id: first && segments.length === 1 ? first.id : sessionId,
    agent: first?.agent ?? "claude",
    usage: segments.reduce((total, segment) => addUsage(total, segment.usage), EMPTY_USAGE),
    models: mergeModels(segments.map((segment) => segment.models)),
    lastActivity:
      segments
        .map((segment) => segment.lastActivity)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null,
  };
}

interface Lookup {
  match: SessionMatch;
  /** The provider sessions of the conversation, newest first; empty without a session id. */
  chain: string[];
}

export function createSessionMatcher(
  cache: ReportCache,
  logs: ClaudeLogs,
  pricer: SubagentPricer,
  store: AgentStore,
) {
  const sessionIds = new Map<string, CachedSessionId>();

  async function providerSessionId(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const cached = sessionIds.get(agentId);
    if (cached && cached.sessionId && Date.now() - cached.at < SESSION_ID_TTL_MS) {
      return cached.sessionId;
    }
    const result = await paseo.agents.ref(agentId).refresh();
    // Read only the id: the persistence record also carries launch config with credentials.
    const persistence = result?.agent.persistence;
    const sessionId = persistence?.nativeHandle || persistence?.sessionId || null;
    sessionIds.set(agentId, { sessionId, at: Date.now() });
    return sessionId;
  }

  /** `exclude`: sessions already counted elsewhere, such as a parent's history a child forked. */
  async function lookup(
    agentId: string,
    sessionId: string | null,
    sessions: SessionUsage[],
    exclude: ReadonlySet<string> = new Set(),
  ): Promise<Lookup> {
    if (!sessionId) return { match: { status: "unknown", agentId }, chain: [] };
    // Only Claude Code logs fork; other providers' ids are not in the log index and stay alone.
    const chain = await logs.chain(sessionId).catch(() => [sessionId]);
    const current = exclude.has(sessionId)
      ? undefined
      : sessions.find((candidate) => sessionKeyMatches(candidate.id, sessionId));
    const earlier = chain
      .slice(1)
      .filter((id) => !exclude.has(id))
      .map((id) => sessions.find((candidate) => candidate.id === id))
      .filter((session): session is SessionUsage => session !== undefined);
    const segments = current ? [current, ...earlier] : earlier;
    if (segments.length === 0) {
      return { match: { status: "pending", agentId, providerSessionId: sessionId }, chain };
    }
    return {
      match: {
        status: "matched",
        agentId,
        providerSessionId: sessionId,
        session: combine(sessionId, segments),
        earlierSegments: earlier.length,
      },
      chain,
    };
  }

  async function lookupAll(
    agentIds: readonly string[],
    paseo: PaseoApi,
    exclude?: ReadonlySet<string>,
  ): Promise<Lookup[]> {
    const sessions = await cache.sessions();
    const ids = await Promise.all(
      agentIds.map((agentId) => providerSessionId(paseo, agentId).catch(() => null)),
    );
    return Promise.all(
      agentIds.map((agentId, index) => lookup(agentId, ids[index] ?? null, sessions, exclude)),
    );
  }

  async function children(
    agentId: string,
    paseo: PaseoApi,
    parentChain: readonly string[],
  ): Promise<ChildAgentUsage[]> {
    let listFailed = false;
    const [listed, stored] = await Promise.all([
      paseo.agents
        .list({
          filter: { labels: { [PARENT_LABEL]: agentId }, includeArchived: true },
          page: { limit: MAX_CHILDREN },
        })
        .then(({ entries }) => entries.map((entry) => entry.agent))
        .catch((error: unknown) => {
          listFailed = true;
          console.warn("[ccusage-stats] Listing child agents failed", error);
          return [];
        }),
      store.children(agentId).catch((error: unknown) => {
        console.warn("[ccusage-stats] Reading stored agents failed", error);
        return [];
      }),
    ]);
    // The list leaves out agents whose project was removed; the stored records fill them in.
    const listedIds = new Set(listed.map((agent) => agent.id));
    const hidden = stored.filter((agent) => !listedIds.has(agent.id));
    const exclude = new Set(parentChain);
    const sessions = await cache.sessions();
    const [listedLookups, hiddenLookups] = await Promise.all([
      lookupAll(
        listed.map((agent) => agent.id),
        paseo,
        exclude,
      ),
      Promise.all(hidden.map((agent) => lookup(agent.id, agent.sessionId, sessions, exclude))),
    ]);
    const unknown = (id: string) => ({ status: "unknown" as const, agentId: id });
    return [
      ...listed.map((agent, index) => ({
        agentId: agent.id,
        title: agent.title ?? null,
        provider: agent.provider,
        archived: Boolean(agent.archivedAt),
        unlisted: false,
        match: listedLookups[index]?.match ?? unknown(agent.id),
      })),
      ...hidden.map((agent, index) => ({
        agentId: agent.id,
        title: agent.title,
        provider: agent.provider,
        archived: agent.archived,
        // When the list itself failed, a missing agent says nothing about its project.
        unlisted: !listFailed,
        match: hiddenLookups[index]?.match ?? unknown(agent.id),
      })),
    ]
      .sort((a, b) => costOf(b.match) - costOf(a.match))
      .slice(0, MAX_CHILDREN);
  }

  return {
    async resolve(
      { agentIds }: RpcInput<typeof sessionUsageRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionUsageRpc>> {
      const lookups = await lookupAll([...new Set(agentIds)], paseo);
      return { generatedAt: Date.now(), sessions: lookups.map((entry) => entry.match) };
    },

    async detail(
      { agentId }: RpcInput<typeof sessionDetailRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionDetailRpc>> {
      const [own] = await lookupAll([agentId], paseo);
      const match = own?.match ?? { status: "unknown" as const, agentId };
      let subagentsError: string | null = null;
      const subagents = await logs
        .subagents(own?.chain ?? [])
        .then((found) => pricer.usage(found))
        .catch((error: unknown) => {
          subagentsError = error instanceof Error ? error.message : String(error);
          return [];
        });
      const childAgents = await children(agentId, paseo, own?.chain ?? []).catch(
        (error: unknown) => {
          console.warn("[ccusage-stats] Listing child agents failed", error);
          return [];
        },
      );
      return { generatedAt: Date.now(), match, subagents, subagentsError, children: childAgents };
    },

    /** A turn can start a new provider session; look the id up again next time. */
    forget(agentId: string) {
      sessionIds.delete(agentId);
    },
  };
}

function costOf(match: SessionMatch): number {
  return match.status === "matched" ? match.session.usage.cost : -1;
}
