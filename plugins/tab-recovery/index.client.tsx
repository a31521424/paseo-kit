import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ClosedAgentsPanel } from "./client/closed-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "closed",
    title: "Closed agents",
    icon: "ArchiveRestore",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ClosedAgentsPanel,
  });
  client.addCommandCenterItem({
    id: "reopen-closed-agent",
    title: "Reopen a closed agent",
    icon: "ArchiveRestore",
    keywords: ["closed", "archived", "restore", "undo", "tab", "unarchive"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("closed");
    },
  });
  return () => {};
}
