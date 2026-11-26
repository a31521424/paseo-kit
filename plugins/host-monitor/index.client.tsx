import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DisplayScreen, DisplaySettings } from "./client/settings";
import { HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  client.addSettingsScreen({
    id: "display",
    title: "Display",
    icon: "SlidersHorizontal",
    Component: DisplaySettings,
  });
  client.addScreen({ id: "display", title: "Host monitor display", Component: DisplayScreen });
  return () => {};
}
