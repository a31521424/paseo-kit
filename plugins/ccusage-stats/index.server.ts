import v8 from "node:v8";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAgentStore } from "./server/agent-store";
import { createClaudeLogs } from "./server/claude-logs";
import { createLimitsReader, stopInteractiveSessions } from "./server/claude-usage";
import { createReportCache } from "./server/report";
import { createSessionMatcher } from "./server/sessions";
import { createSubagentPricer } from "./server/subagents";
import {
  claudeLimitsRpc,
  DEFAULT_SETTINGS,
  refreshClaudeLimitsRpc,
  settingsDefinition,
} from "./shared/limits";
import { sessionDetailRpc, sessionUsageRpc, usageReportRpc } from "./shared/usage";

// The plugin process validates every daemon message with one generated function of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Once it is hot, V8's Maglev compiler
// optimizes it on a worker thread, taking about 500 MB of native memory per compile, and again after
// each deopt; glibc keeps that memory, so the process grew past 2.6 GB. Turbofan already skips a
// function this large, so without Maglev it stays in the interpreter. The flag must be set before
// the function gets hot, and this bundle is evaluated before the daemon client connects.
v8.setFlagsFromString("--no-maglev");

export default function contribute(server: PluginServerContext) {
  const cache = createReportCache();
  const pricer = createSubagentPricer(cache.timezone);
  const matcher = createSessionMatcher(cache, createClaudeLogs(), pricer, createAgentStore());
  server.handle(usageReportRpc, () => cache.read());
  server.handle(sessionUsageRpc, (input, { paseo }) => matcher.resolve(input, paseo));
  server.handle(sessionDetailRpc, (input, { paseo }) => matcher.detail(input, paseo));

  // Claude plan limits: off until turned on in the plugin settings.
  const limits = createLimitsReader(DEFAULT_SETTINGS.claudeLimits);
  const settings = server.registerSettings(settingsDefinition);
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") limits.configure(state.values.claudeLimits);
    else console.warn(`[ccusage-stats] Ignoring invalid settings: ${state.error}`);
  };
  const settingsReady = settings.read().then(applySettings, (error: unknown) => {
    console.error("[ccusage-stats] Could not read settings", error);
  });
  const unsubscribe = settings.subscribe(applySettings);
  server.handle(claudeLimitsRpc, async () => {
    await settingsReady;
    return limits.read();
  });
  server.handle(refreshClaudeLimitsRpc, async () => {
    await settingsReady;
    return limits.refresh();
  });

  // A finished turn has written new usage to the agent's logs.
  server.on("agent.turn_ended", (event) => {
    matcher.forget(event.agent.id);
    cache.invalidate();
  });
  return () => {
    unsubscribe();
    stopInteractiveSessions();
    cache.stop();
  };
}
