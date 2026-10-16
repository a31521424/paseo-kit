import type { PluginTheme } from "@getpaseo/plugin";
import { useWorkspace, type PluginClientContext, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, FlatList, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  clearFinishedRecords,
  downloadFile,
  removeRecord,
  useDownloadRecords,
  type DownloadRecord,
} from "./downloads";
import { formatAgo, formatBytes, formatPercent } from "./format";
import { SAVE_SHORTCUT } from "./web";

type Rpc = PluginClientContext["rpc"];

/** The downloads started in this window, newest first. Opened from the Command Center only. */
export function createHistoryPanel(rpc: Rpc) {
  return function HistoryPanel({ theme, layout }: PluginWorkspacePanelProps) {
    const records = useDownloadRecords();
    const padding = layout.compact ? 12 : 16;
    const muted = theme.colors.foregroundMuted;
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding, paddingBottom: 8 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>Downloads</Text>
            <Text style={{ color: muted, fontSize: 12 }}>
              Files saved with {SAVE_SHORTCUT} or "Download current file" since this page loaded. Cleared on reload.
            </Text>
          </View>
          {records.some((record) => record.status !== "downloading") ? (
            <Pressable
              accessibilityRole="button"
              onPress={clearFinishedRecords}
              style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
        {records.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
            <Icon name="Download" size={24} color={muted} />
            <Text style={{ color: muted, textAlign: "center", maxWidth: 360 }}>
              No downloads yet. Open a file preview and press {SAVE_SHORTCUT}.
            </Text>
          </View>
        ) : (
          <FlatList
            data={records}
            keyExtractor={(record) => record.id}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => <RecordRow theme={theme} compact={layout.compact} record={item} rpc={rpc} />}
          />
        )}
      </View>
    );
  };
}

function RecordRow({
  theme,
  compact,
  record,
  rpc,
}: {
  theme: PluginTheme;
  compact: boolean;
  record: DownloadRecord;
  rpc: Rpc;
}) {
  const toast = useToast();
  const workspaceName = useWorkspace(record.workspaceId, (workspace) => ({ name: workspace.title ?? workspace.name }))?.name;
  const muted = theme.colors.foregroundMuted;
  const directory = record.path.includes("/") ? record.path.slice(0, record.path.lastIndexOf("/")) || "/" : "";
  const status =
    record.status === "downloading"
      ? record.total > 0
        ? `Downloading ${formatPercent(record.received, record.total)} of ${formatBytes(record.total)}`
        : "Preparing"
      : record.status === "failed"
        ? `Failed: ${record.error ?? "unknown error"}`
        : `${formatBytes(record.total)} · ${formatAgo(record.startedAt)}`;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: compact ? 12 : 16, paddingVertical: 8 }}
    >
      {record.status === "downloading" ? (
        <ActivityIndicator size="small" color={muted} />
      ) : (
        <Icon
          name={record.status === "failed" ? "CircleAlert" : "CircleCheck"}
          size={16}
          color={record.status === "failed" ? theme.colors.statusDanger : theme.colors.statusSuccess}
        />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
          {record.name}
        </Text>
        <Text numberOfLines={1} style={{ color: muted, fontSize: 11 }}>
          {[directory, workspaceName].filter(Boolean).join(" · ")}
        </Text>
        <Text
          numberOfLines={2}
          selectable
          style={{ color: record.status === "failed" ? theme.colors.statusDanger : muted, fontSize: 11 }}
        >
          {status}
        </Text>
      </View>
      <RowButton
        theme={theme}
        icon="RotateCcw"
        label={`Download ${record.name} again`}
        disabled={record.status === "downloading"}
        onPress={() => void downloadFile(rpc, record.workspaceId, record.path)}
      />
      <RowButton
        theme={theme}
        icon="Copy"
        label={`Copy path of ${record.name}`}
        onPress={() => {
          copyText(record.path).then(
            () => toast.show("Path copied", { variant: "success" }),
            () => toast.error("Could not copy the path."),
          );
        }}
      />
      <RowButton
        theme={theme}
        icon="X"
        label={`Remove ${record.name} from the list`}
        disabled={record.status === "downloading"}
        onPress={() => removeRecord(record.id)}
      />
    </View>
  );
}

function RowButton({
  theme,
  icon,
  label,
  onPress,
  disabled,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={(state) => ({
        padding: 6,
        borderRadius: 6,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}
