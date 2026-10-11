import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startSampler } from "./server/sampler";
import { hostStatsRpc } from "./shared/stats";

export default function contribute(server: PluginServerContext) {
  const sampler = startSampler();
  server.handle(hostStatsRpc, () => sampler.read());
  return () => sampler.stop();
}
