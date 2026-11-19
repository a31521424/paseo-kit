import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HOST_SCREEN_ID, HostScreen, HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: HOST_SCREEN_ID, title: "Host monitor", Component: HostScreen });
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  return () => {};
}
