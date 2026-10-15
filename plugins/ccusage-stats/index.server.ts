import v8 from "node:v8";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createReportCache } from "./server/report";
import { createSessionMatcher } from "./server/sessions";
import { sessionUsageRpc, usageReportRpc } from "./shared/usage";

// The plugin process validates every daemon message with one generated function of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Once it is hot, V8's Maglev compiler
// optimizes it on a worker thread, taking about 500 MB of native memory per compile, and again after
// each deopt; glibc keeps that memory, so the process grew past 2.6 GB. Turbofan already skips a
// function this large, so without Maglev it stays in the interpreter. The flag must be set before
// the function gets hot, and this bundle is evaluated before the daemon client connects.
v8.setFlagsFromString("--no-maglev");

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
