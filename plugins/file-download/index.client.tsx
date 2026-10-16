import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createHostCheck, downloadFile, downloadFocusedFile, NOT_A_FILE } from "./client/downloads";
import { createHistoryPanel } from "./client/history-panel";
import { NoticeHost } from "./client/notice-host";
import { listenForSaveShortcut, readFocusedTab } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const ownsServer = createHostCheck(client.rpc);

  client.addCommandCenterItem({
    id: "download-current-file",
    title: "Download current file",
    icon: "Download",
    keywords: ["download", "save", "file", "export"],
    context: "workspace",
    onSelect() {
      const focused = readFocusedTab();
      // Paseo shows a thrown error as a toast.
      if (!focused?.filePath) throw new Error(NOT_A_FILE);
      void downloadFile(client.rpc, focused.workspaceId, focused.filePath);
    },
  });
  client.addCommandCenterItem({
    id: "open-downloads",
    title: "Open downloads",
    icon: "FolderDown",
    keywords: ["download", "history", "files"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("downloads");
    },
  });
  client.addWorkspacePanel({
    id: "downloads",
    title: "Downloads",
    icon: "FolderDown",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: createHistoryPanel(client.rpc),
  });
  client.addSidebarFooterItem({ id: "notices", title: "Download notices", Component: NoticeHost });

  return listenForSaveShortcut((event) => {
    if (downloadFocusedFile(client.rpc, ownsServer)) event.preventDefault();
  });
}
