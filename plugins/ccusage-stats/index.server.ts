import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createReportCache } from "./server/report";
import { createSessionMatcher } from "./server/sessions";
import { sessionUsageRpc, usageReportRpc } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  const cache = createReportCache();
  const matcher = createSessionMatcher(cache);
  server.handle(usageReportRpc, () => cache.read());
  server.handle(sessionUsageRpc, (input, { paseo }) => matcher.resolve(input, paseo));
  // A finished turn has written new usage to the agent's logs.
  server.on("agent.turn_ended", (event) => {
    matcher.forget(event.agent.id);
    cache.invalidate();
  });
  return () => cache.stop();
}
