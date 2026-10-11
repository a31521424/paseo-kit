import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionMatch, SessionUsage, sessionUsageRpc } from "../shared/usage";
import type { ReportCache } from "./report";

type PaseoApi = PluginHandlerContext["paseo"];

// A provider session id rarely changes once an agent has one; a resume or refresh can replace it.
const SESSION_ID_TTL_MS = 5 * 60_000;

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

export function createSessionMatcher(cache: ReportCache) {
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

  function match(
    agentId: string,
    sessionId: string | null,
    sessions: SessionUsage[],
  ): SessionMatch {
    if (!sessionId) return { status: "unknown", agentId };
    const session = sessions.find((candidate) => sessionKeyMatches(candidate.id, sessionId));
    return session
      ? { status: "matched", agentId, providerSessionId: sessionId, session }
      : { status: "pending", agentId, providerSessionId: sessionId };
  }

  return {
    async resolve(
      { agentIds }: RpcInput<typeof sessionUsageRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionUsageRpc>> {
      const sessions = await cache.sessions();
      const unique = [...new Set(agentIds)];
      const ids = await Promise.all(
        unique.map((agentId) => providerSessionId(paseo, agentId).catch(() => null)),
      );
      return {
        generatedAt: Date.now(),
        sessions: unique.map((agentId, index) => match(agentId, ids[index] ?? null, sessions)),
      };
    },
    /** A turn can start a new provider session; look the id up again next time. */
    forget(agentId: string) {
      sessionIds.delete(agentId);
    },
  };
}
