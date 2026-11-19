import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageScreen } from "./client/screen";
import { contributeSessionPills, SESSION_PANEL_ID } from "./client/session";
import { SessionUsagePanel } from "./client/session-panel";
import { UsageSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Token usage", Component: UsageScreen });
  client.addSidebarFooterItem({
    id: "usage-today",
    title: "Token usage",
    Component: UsageSidebarItem,
  });
  client.addWorkspacePanel({
    id: SESSION_PANEL_ID,
    title: "Session usage",
    icon: "Coins",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: SessionUsagePanel,
  });
  client.addCommandCenterItem({
    id: "open-session-usage",
    title: "Open session usage",
    icon: "Coins",
    keywords: ["ccusage", "tokens", "cost", "session", "subagents"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(SESSION_PANEL_ID);
    },
  });
  client.addCommandCenterItem({
    id: "open-usage",
    title: "Open token usage",
    icon: "Coins",
    keywords: ["ccusage", "tokens", "cost", "spend"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "usage" });
    },
  });
  return contributeSessionPills(client);
}
