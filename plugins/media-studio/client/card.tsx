import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useTranslation, useWorkspace, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { z } from "zod";
import type { cardSchema } from "../shared/cards";
import { baseName, formatDuration, mediaKindOf } from "../shared/media";
import { messages } from "./i18n";
import { MediaViewer } from "./player";
import { usePoster, useProbe } from "./queries";
import { openInMediaPanel } from "./state";
import { IconButton, kindIcon } from "./ui";

function Tile({ theme, path, cwd, selected, onPress }: { theme: PluginTheme; path: string; cwd: string | null; selected: boolean; onPress(): void }) {
  const probe = useProbe(path, cwd);
  const poster = usePoster(probe.data, 320);
  const { colors } = theme;
  const kind = probe.data?.kind ?? mediaKindOf(path) ?? "video";
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={baseName(path)} onPress={onPress} style={{ width: 148, gap: 4 }}>
      {(state) => (
        <>
          <View
            style={{
              width: 148,
              height: 84,
              borderRadius: 8,
              overflow: "hidden",
              backgroundColor: colors.surface2,
              borderWidth: 2,
              borderColor: selected ? colors.accent : (state as { hovered?: boolean }).hovered ? colors.border : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {poster.data ? (
              <Image source={{ uri: poster.data }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
            ) : (
              <Icon name={probe.isError ? "FileX" : kindIcon(kind)} size={22} color={probe.isError ? colors.statusDanger : colors.foregroundMuted} />
            )}
            {probe.data?.duration ? (
              <View style={{ position: "absolute", right: 5, bottom: 5, paddingHorizontal: 5, height: 16, justifyContent: "center", borderRadius: 4, backgroundColor: "rgba(0,0,0,0.7)" }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatDuration(probe.data.duration)}</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 11, fontWeight: selected ? "600" : "400" }}>
            {baseName(path)}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * The chat card for media an agent showed with preview_media, or that a turn created. One file
 * opens straight into the inline player; several start as a strip of thumbnails.
 */
export function MediaCard({ agentId, item, theme, layout }: PluginTimelineItemProps<z.output<typeof cardSchema>>) {
  const { t } = useTranslation(messages);
  const data = item.data;
  const agentCwd = useAgent(agentId, (agent) => agent.cwd);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const workspaceRoot = useWorkspace(workspaceId ?? "", (workspace) => workspace.directory);
  const cwd = data.cwd ?? agentCwd ?? null;
  const [selected, setSelected] = useState<number | null>(data.paths.length === 1 ? 0 : null);
  const { colors } = theme;
  const count = data.paths.length + data.more;
  const changedOnly = data.source === "turn" && data.shown === 0;
  const mixed = data.source === "turn" && data.shown > 0 && count > data.shown;
  const title =
    data.title?.trim() ||
    (changedOnly ? t("card.turnTitle", { count }) : mixed ? t("card.turnMixed", { count }) : count === 1 ? t("card.title") : t("card.titleMany", { count }));
  const open = (path: string | null) => {
    if (workspaceId) openInMediaPanel(workspaceId, path);
  };

  return (
    <View
      style={{
        marginVertical: 6,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        backgroundColor: colors.surface0,
        padding: layout.compact ? 10 : 12,
        gap: 10,
        maxWidth: 780,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" }}>
          <Icon name={changedOnly ? "FolderClock" : "Clapperboard"} size={15} color={colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {title}
          </Text>
          {count > 1 || data.title?.trim() ? (
            <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
              {t("card.files", { count })}
            </Text>
          ) : null}
        </View>
        {workspaceId ? <IconButton theme={theme} icon="PanelRightOpen" size="sm" label={t("card.openPanel")} onPress={() => open(null)} /> : null}
      </View>
      {data.note?.trim() ? <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{data.note.trim()}</Text> : null}
      {data.state === "failed" ? (
        <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{data.error ?? t("card.failed")}</Text>
      ) : null}
      {data.paths.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {data.paths.map((path, index) => (
            <Tile key={path} theme={theme} path={path} cwd={cwd} selected={selected === index} onPress={() => setSelected(selected === index ? null : index)} />
          ))}
          {data.more > 0 ? (
            <Pressable onPress={() => open(null)} style={{ width: 84, height: 84, borderRadius: 8, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{t("card.more", { count: data.more })}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {selected !== null && data.paths[selected] ? (
        <MediaViewer
          key={data.paths[selected]}
          theme={theme}
          compact={layout.compact}
          path={data.paths[selected]!}
          cwd={cwd}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot ?? cwd}
          agentId={agentId}
          variant="inline"
          onOpenInPanel={workspaceId ? (path) => open(path) : undefined}
        />
      ) : null}
    </View>
  );
}
