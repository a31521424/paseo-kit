import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CARD_KIND, CARD_MAX_FILES, CARD_VERSION, cardSchema, isPreviewToolName, parseToolInput, type CardData } from "./shared/cards";
import { AUDIO_EXTENSIONS, PANEL_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, joinPath } from "./shared/media";
import { settingsDefinition } from "./shared/settings";
import { MediaCard } from "./client/card";
import { MediaFilePanel } from "./client/file-panel";
import { messages } from "./client/i18n";
import { MediaPanel } from "./client/media-panel";
import { SettingsScreen } from "./client/settings-screen";
import { openInMediaPanel, setPluginClient } from "./client/state";
import { adoptUploads, handOverUploads, uploadFiles } from "./client/transfers";
import { isWeb, pickFiles } from "./client/web";

export default function contribute(client: PluginClientContext) {
  setPluginClient(client);
  void adoptUploads();

  client.addWorkspacePanel({
    id: "media",
    title: messages.message("panel.title"),
    icon: "Clapperboard",
    locations: ["workspace", "explorer"],
    Component: MediaPanel,
  });

  client.addFilePanel({
    id: "player",
    title: messages.message("panel.filePanel"),
    icon: "Clapperboard",
    files: { extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...PANEL_IMAGE_EXTENSIONS] },
    Component: MediaFilePanel,
  });

  // A preview_media tool call becomes a media card, already while the call runs.
  client.addTimelineTransformer({
    id: "preview-media",
    query: { itemType: "tool_call" },
    transform({ item }) {
      if (!isPreviewToolName(item.name)) return undefined;
      const detail = item.detail as { type: string; input?: unknown };
      const input = parseToolInput(detail.input);
      if (!input) return undefined;
      const data: CardData = {
        source: "tool",
        title: input.title ?? null,
        note: input.note ?? null,
        cwd: null,
        paths: input.paths.slice(0, CARD_MAX_FILES),
        more: Math.max(0, input.paths.length - CARD_MAX_FILES),
        shown: Math.min(input.paths.length, CARD_MAX_FILES),
        state: item.status === "failed" ? "failed" : item.status === "running" ? "running" : "done",
        error: item.status === "failed" && item.error ? String((item.error as { message?: string }).message ?? item.error) : null,
      };
      return { items: [{ type: "plugin", kind: CARD_KIND, version: CARD_VERSION, data }] };
    },
  });
  client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: cardSchema, Component: MediaCard });

  client.addSettingsScreen({ id: "settings", title: messages.message("settings.title"), icon: "Clapperboard", Component: SettingsScreen });

  client.addCommandCenterItem({
    id: "open-media",
    title: messages.message("commands.open"),
    icon: "Clapperboard",
    keywords: ["media", "video", "audio", "image", "preview", "player", "timeline", "footage", "bin", "视频", "音频", "素材"],
    context: "workspace",
    onSelect({ workspace }) {
      openInMediaPanel(workspace.id, null);
    },
  });

  if (isWeb) {
    client.addCommandCenterItem({
      id: "upload-media",
      title: messages.message("commands.upload"),
      icon: "Upload",
      keywords: ["upload", "footage", "import", "上传", "素材"],
      context: "workspace",
      async onSelect({ workspace, rpc }) {
        // The picker opens first, while the selection still counts as a user gesture.
        const picking = pickFiles();
        const stored = await rpc(settingsRpc(settingsDefinition.id).read, {}).catch(() => null);
        const parsed = stored?.status === "ready" ? settingsDefinition.schema.safeParse(stored.values) : null;
        const folder = parsed?.success ? parsed.data.uploadFolder : "uploads";
        const files = await picking;
        if (files.length === 0) return;
        openInMediaPanel(workspace.id, null);
        await uploadFiles(files, joinPath(workspace.directory, folder || "uploads"));
      },
    });
  }

  client.addSlashCommand({
    name: "media",
    description: messages.message("commands.slash"),
    argumentHint: messages.message("commands.slashHint"),
    context: "agent",
    onSubmit({ args, agent }) {
      const target = args.trim();
      if (!target) {
        openInMediaPanel(agent.workspaceId, null);
        return;
      }
      const remote = /^[A-Za-z0-9][A-Za-z0-9._-]*:/.test(target);
      const absolute = target.startsWith("/") || target.startsWith("~") || remote;
      openInMediaPanel(agent.workspaceId, absolute ? target : joinPath(agent.cwd, target));
    },
  });

  return () => {
    handOverUploads();
    setPluginClient(null);
  };
}
