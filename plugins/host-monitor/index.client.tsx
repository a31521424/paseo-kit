import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LatencyItem } from "./client/latency";
import { HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  client.addSidebarFooterItem({ id: "host-latency", title: "Latency", Component: LatencyItem });
  return () => {};
}
