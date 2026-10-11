import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  return () => {};
}
