import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, useTabState, useTranslation, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View, type FlatList as NativeFlatList, type TextInput as NativeTextInput } from "react-native";
import { z } from "zod";
import { formatBytes, formatDuration, joinPath, mediaKindOf, relativeTo } from "../shared/media";
import { listRpc, probeRpc, statusRpc, uploadPendingRpc, type MediaEntry, type PendingUpload } from "../shared/rpc";
import { settingsDefinition } from "../shared/settings";
import { messages } from "./i18n";
import { MediaViewer } from "./player";
import { useEntryPoster } from "./queries";
import { clearFinishedTransfers, dismissTransfer, onUploaded, useOpenRequest, useTransfers, type Transfer } from "./state";
import type { WebFile } from "./web";
import { discardPending, matchesPending, resumePending, uploadFiles } from "./transfers";
import { Button, Chip, IconButton, Kbd, Message, NO_OUTLINE, ProgressBar, Segmented, kindIcon, timeAgo } from "./ui";
import { attachDropTarget, focusIsFree, isShown, isWeb, listenForKeys, pickFiles } from "./web";

const tabStateSchema = z.object({
  selected: z.string().nullable(),
  view: z.enum(["recent", "folder"]),
  /** Folder shown in the folder view; null is the location's root. */
  dir: z.string().nullable(),
  /** Root other than the workspace, such as alias:/path on an SSH host. */
  location: z.string().nullable(),
  filter: z.enum(["all", "video", "audio", "image"]),
  recentLocations: z.array(z.string()),
  /** The file shown before the current one, offered for A/B comparison. */
  previous: z.string().nullable().default(null),
});
type TabState = z.infer<typeof tabStateSchema>;
const DEFAULT_STATE: TabState = { selected: null, view: "recent", dir: null, location: null, filter: "all", recentLocations: [], previous: null };

function remotePrefix(path: string): string | null {
  const match = /^([^/:]+):\//.exec(path);
  return match ? match[1]! : null;
}

function EntryRow({
  theme,
  entry,
  root,
  selected,
  showFolder,
  locale,
  onPress,
}: {
  theme: PluginTheme;
  entry: MediaEntry;
  root: string;
  selected: boolean;
  showFolder: boolean;
  locale: string;
  onPress(): void;
}) {
  const { colors } = theme;
  const visual = entry.kind === "video" || entry.kind === "image";
  const timed = entry.kind === "video" || entry.kind === "audio";
  const poster = useEntryPoster(entry.path, entry.modifiedAt, 160, visual);
  const probe = useEntryDuration(entry, timed);
  const relative = relativeTo(root, entry.path);
  const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
  const isDir = entry.kind === "directory";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 8,
        paddingRight: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: selected ? colors.surface2 : state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent",
      })}
    >
      <View style={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, backgroundColor: selected ? colors.accent : "transparent" }} />
      {isDir ? (
        <View style={{ width: 76, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon name="Folder" size={22} color={colors.foregroundMuted} />
        </View>
      ) : (
        <View style={{ width: 76, height: 44, borderRadius: 6, overflow: "hidden", backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" }}>
          {poster.data ? (
            <Image source={{ uri: poster.data }} resizeMode="cover" style={{ width: 76, height: 44 }} />
          ) : (
            <Icon name={kindIcon(entry.kind)} size={18} color={colors.foregroundMuted} />
          )}
          {probe ? (
            <View style={{ position: "absolute", right: 3, bottom: 3, paddingHorizontal: 4, borderRadius: 3, backgroundColor: "rgba(0,0,0,0.7)" }}>
              <Text style={{ color: "#fff", fontSize: 9, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{probe}</Text>
            </View>
          ) : null}
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "500" }}>
          {entry.name}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {[isDir ? null : formatBytes(entry.size), timeAgo(entry.modifiedAt, locale), showFolder && folder ? folder : null].filter(Boolean).join("  ·  ")}
        </Text>
      </View>
      {isDir ? <Icon name="ChevronRight" size={15} color={colors.foregroundMuted} /> : null}
    </Pressable>
  );
}

/** Duration for a list row, from the daemon's cached probe; only rows on screen ask. */
function useEntryDuration(entry: MediaEntry, enabled: boolean): string | null {
  const probe = useRpc(probeRpc);
  const query = useQuery({
    queryKey: ["media-studio", "probe", entry.path, null, entry.modifiedAt],
    queryFn: () => probe({ path: entry.path }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return query.data?.duration ? formatDuration(query.data.duration) : null;
}

/** Where the list comes from: the workspace, a recent folder, or an SSH host. */
function SourcePicker({
  theme,
  open,
  onOpenChange,
  current,
  recent,
  remoteHosts,
  onChoose,
}: {
  theme: PluginTheme;
  open: boolean;
  onOpenChange(open: boolean): void;
  current: string | null;
  recent: readonly string[];
  remoteHosts: readonly string[];
  onChoose(location: string | null): void;
}) {
  const { t } = useTranslation(messages);
  const { colors } = theme;
  const [draft, setDraft] = useState("");
  const options: { value: string | null; label: string; icon: string }[] = [
    { value: null, label: t("panel.workspace"), icon: "FolderGit2" },
    ...[...new Set([...recent, ...remoteHosts.map((host) => `${host}:~`)])].map((value) => ({
      value,
      label: value,
      icon: remotePrefix(value) ? "Server" : "Folder",
    })),
  ];
  return (
    <Modal title={t("panel.source")} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {options.map((option) => {
          const selected = option.value === current;
          return (
            <Pressable
              key={option.value ?? "workspace"}
              accessibilityRole="button"
              onPress={() => onChoose(option.value)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 8,
                backgroundColor: selected || pressed ? colors.surface2 : "transparent",
              })}
            >
              <Icon name={option.icon} size={16} color={selected ? colors.accent : colors.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>
                {option.label}
              </Text>
              {selected ? <Icon name="Check" size={15} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginTop: 8 }}>{t("panel.otherLocation")}</Text>
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={remoteHosts[0] ? `${remoteHosts[0]}:/path/to/renders` : "/path/to/footage"}
            placeholderTextColor={colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => draft.trim() && onChoose(draft.trim())}
            style={{ flex: 1, height: 34, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, color: colors.foreground, fontSize: 13 }}
          />
          <Button theme={theme} primary label={t("panel.go")} disabled={!draft.trim()} onPress={() => onChoose(draft.trim())} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function shortLocation(location: string): string {
  const host = remotePrefix(location);
  const rest = host ? location.slice(host.length + 1) : location;
  const name = rest.replace(/\/+$/, "").split("/").pop() || rest;
  return host ? `${host} · ${name}` : name;
}

/** Re-renders every second while `active`, for countdowns. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function TransferRow({ theme, transfer, onShow }: { theme: PluginTheme; transfer: Transfer; onShow(path: string): void }) {
  const { t } = useTranslation(messages);
  const { colors } = theme;
  useTicker(transfer.status === "retrying");
  const progress = transfer.total > 0 ? transfer.done / transfer.total : transfer.status === "done" ? 1 : 0;
  const amounts = `${formatBytes(transfer.done)} / ${formatBytes(transfer.total)}`;
  const resumed = transfer.resumedFrom > 0 ? ` · ${t("transfers.resumedFrom", { size: formatBytes(transfer.resumedFrom) })}` : "";
  const seconds = transfer.retryAt ? Math.max(0, Math.ceil((transfer.retryAt - Date.now()) / 1000)) : 0;
  const status =
    transfer.status === "running"
      ? amounts + resumed
      : transfer.status === "retrying"
        ? `${seconds > 0 ? t("transfers.retrying", { seconds }) : t("transfers.reconnecting")} · ${amounts}`
        : transfer.status === "paused"
          ? t("transfers.paused", { amounts })
          : transfer.status === "done"
            ? t("transfers.done") + resumed
            : transfer.status === "canceled"
              ? t("transfers.canceled")
              : transfer.kind === "upload" && transfer.resume
                ? t("transfers.failedKept", { error: transfer.error ?? t("transfers.failed") })
                : (transfer.error ?? t("transfers.failed"));
  const active = transfer.status === "running" || transfer.status === "retrying" || transfer.status === "paused";
  return (
    <View style={{ gap: 4, paddingVertical: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={transfer.kind === "upload" ? "Upload" : "Download"} size={13} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, flex: 1 }}>
          {transfer.name}
        </Text>
        {transfer.status === "done" && transfer.resultPath ? (
          <Button theme={theme} compact icon="Eye" accessibilityLabel={t("transfers.show")} onPress={() => onShow(transfer.resultPath!)} />
        ) : null}
        {transfer.pause ? <Button theme={theme} compact icon="Pause" accessibilityLabel={t("transfers.pause")} onPress={transfer.pause} /> : null}
        {transfer.resume ? <Button theme={theme} compact icon="Play" accessibilityLabel={t("transfers.resume")} onPress={transfer.resume} /> : null}
        {(active || transfer.resume) && transfer.cancel ? (
          <Button theme={theme} compact icon="X" accessibilityLabel={t("transfers.cancel")} onPress={transfer.cancel} />
        ) : (
          <Button theme={theme} compact icon="X" accessibilityLabel={t("transfers.dismiss")} onPress={() => dismissTransfer(transfer.id)} />
        )}
      </View>
      <ProgressBar
        theme={theme}
        value={progress}
        tone={transfer.status === "failed" ? "danger" : transfer.status === "done" ? "success" : "accent"}
      />
      <Text
        numberOfLines={2}
        style={{
          color: transfer.status === "failed" ? colors.statusDanger : transfer.status === "retrying" ? colors.statusWarning : colors.foregroundMuted,
          fontSize: 10,
        }}
      >
        {status}
      </Text>
    </View>
  );
}

/** Uploads the daemon still holds part of, so they can continue after a reload or restart. */
function PendingUploads({
  theme,
  uploads,
  root,
  locale,
  onResume,
  onDiscard,
}: {
  theme: PluginTheme;
  uploads: readonly PendingUpload[];
  root: string;
  locale: string;
  onResume(upload: PendingUpload): void;
  onDiscard(upload: PendingUpload): void;
}) {
  const { t } = useTranslation(messages);
  const { colors } = theme;
  if (uploads.length === 0) return null;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, padding: 10, gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{t("pending.title")}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{t("pending.hint")}</Text>
      {uploads.slice(0, 6).map((upload) => (
        <View key={upload.uploadId} style={{ gap: 4, paddingVertical: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="CloudUpload" size={13} color={colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, flex: 1 }}>
              {upload.name}
            </Text>
            {isWeb ? <Button theme={theme} compact icon="Play" label={t("pending.resume")} onPress={() => onResume(upload)} /> : null}
            <Button theme={theme} compact icon="Trash2" accessibilityLabel={t("pending.discard")} onPress={() => onDiscard(upload)} />
          </View>
          <ProgressBar theme={theme} value={upload.size > 0 ? upload.receivedBytes / upload.size : 0} />
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 10 }}>
            {t("pending.progress", {
              done: formatBytes(upload.receivedBytes),
              total: formatBytes(upload.size),
              dir: relativeTo(root, upload.dir) || "/",
              when: timeAgo(upload.updatedAt, locale),
            })}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function MediaPanel({ theme, layout, workspaceId, tab }: PluginWorkspacePanelProps) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const settings = useSettings(settingsDefinition);
  const uploadFolder = settings.status === "ready" ? settings.values.uploadFolder : "uploads";
  const [state, setState] = useTabState(tab, tabStateSchema, DEFAULT_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const update = (patch: Partial<TabState>) => {
    const current = stateRef.current;
    const next = { ...current, ...patch };
    // Remembers the file being left, so the viewer can flip back to it at the same moment.
    if (patch.selected && current.selected && patch.selected !== current.selected) next.previous = current.selected;
    stateRef.current = next;
    setState(next);
  };
  const previous = state.previous && state.selected && state.previous !== state.selected ? state.previous : null;
  const compare =
    previous && mediaKindOf(previous) && mediaKindOf(previous) === mediaKindOf(state.selected!)
      ? { path: previous, name: previous.split("/").pop() ?? previous, onSelect: (path: string) => update({ selected: path }) }
      : null;
  const list = useRpc(listRpc);
  const status = useRpc(statusRpc);
  const transfers = useTransfers();
  const [dropActive, setDropActive] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [viewerHeight, setViewerHeight] = useState(0);
  const [search, setSearch] = useState("");
  const rootRef = useRef<View>(null);
  const searchRef = useRef<NativeTextInput>(null);
  const listRef = useRef<NativeFlatList<MediaEntry>>(null);
  const { colors } = theme;

  const request = useOpenRequest(workspaceId);
  useEffect(() => {
    if (request) update({ selected: request.path });
    // Only a new request moves the selection.
  }, [request?.seq]);

  const base = state.location ?? workspaceRoot ?? null;
  const listing = useQuery({
    queryKey: ["media-studio", "list", base, state.view, state.view === "folder" ? state.dir : null],
    queryFn: () => list({ root: base!, mode: state.view, dir: state.view === "folder" ? state.dir : null, limit: 400 }),
    enabled: !!base,
    refetchInterval: state.view === "recent" ? 10_000 : 20_000,
  });
  const hosts = useQuery({ queryKey: ["media-studio", "status"], queryFn: () => status({}), staleTime: 60_000 });

  useEffect(() => onUploaded(() => void queryClient.invalidateQueries({ queryKey: ["media-studio", "list"] })), [queryClient]);

  const searched = useMemo(() => {
    const all = listing.data?.entries ?? [];
    const query = search.trim().toLowerCase();
    return query ? all.filter((entry) => entry.name.toLowerCase().includes(query)) : all;
  }, [listing.data, search]);
  const counts = useMemo(() => {
    const result = { all: 0, video: 0, audio: 0, image: 0 };
    for (const entry of searched) {
      if (entry.kind === "directory") continue;
      result.all += 1;
      result[entry.kind] += 1;
    }
    return result;
  }, [searched]);
  const entries = useMemo(
    () => (state.filter === "all" ? searched : searched.filter((entry) => entry.kind === "directory" || entry.kind === state.filter)),
    [searched, state.filter],
  );

  const uploadDir = state.view === "folder" ? (listing.data?.dir ?? base) : base ? joinPath(base, uploadFolder || "uploads") : null;

  const pendingRpc = useRpc(uploadPendingRpc);
  const pending = useQuery({
    queryKey: ["media-studio", "pending", base],
    queryFn: () => pendingRpc({ root: base }),
    enabled: !!base,
    refetchInterval: 10_000,
  });
  const activeUploadIds = useMemo(
    () => new Set(transfers.filter((transfer) => transfer.status !== "done" && transfer.status !== "canceled").map((transfer) => transfer.uploadId)),
    [transfers],
  );
  const unfinished = (pending.data?.uploads ?? []).filter((upload) => !activeUploadIds.has(upload.uploadId));
  const transferStates = transfers.map((transfer) => transfer.status).join();
  useEffect(() => {
    void pending.refetch();
    // Refresh when a transfer changes state: a paused or failed upload shows up here once dismissed.
  }, [transferStates]);

  const reportUploaded = (paths: string[]) => {
    if (paths.length === 0) return;
    toast.show(t("transfers.uploaded", { count: paths.length }), { variant: "success" });
    if (paths.length === 1) update({ selected: paths[0]! });
    void pending.refetch();
  };

  /** New files go to the upload folder; a file that matches an unfinished upload resumes it there. */
  const startUpload = (files: readonly WebFile[]) => {
    if (files.length === 0) return;
    const fresh: WebFile[] = [];
    for (const file of files) {
      const match = unfinished.find((upload) => matchesPending(file, upload));
      if (match) void resumePending(match, file).then(reportUploaded);
      else fresh.push(file);
    }
    if (fresh.length > 0 && uploadDir) void uploadFiles(fresh, uploadDir).then(reportUploaded);
  };

  const resumeFromList = (upload: PendingUpload) => {
    void pickFiles().then((files) => {
      if (files.length === 0) return undefined;
      const file = files.find((candidate) => matchesPending(candidate, upload));
      if (!file) {
        toast.error(t("pending.wrongFile", { name: upload.name, size: formatBytes(upload.size) }));
        return undefined;
      }
      void resumePending(upload, file).then(reportUploaded);
      return undefined;
    });
  };

  const discardFromList = (upload: PendingUpload) => {
    void discardPending(upload)
      .then(() => {
        toast.show(t("pending.discarded"), { variant: "default", durationMs: 1500 });
        return pending.refetch();
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    if (!isWeb) return;
    return attachDropTarget(rootRef.current, { onFiles: startUpload, onHover: setDropActive });
  });

  const chooseLocation = (location: string | null) => {
    const recent = location ? [location, ...state.recentLocations.filter((entry) => entry !== location)].slice(0, 6) : state.recentLocations;
    update({ location, dir: null, recentLocations: recent, view: location ? "folder" : state.view });
  };

  const listRoot = state.location ?? workspaceRoot ?? "";
  const currentDir = listing.data?.dir ?? base ?? "";
  const crumbs = useMemo(() => {
    if (!base || state.view !== "folder") return [];
    const relative = relativeTo(base, currentDir);
    if (relative === currentDir || !relative) return [];
    return relative.split("/").filter(Boolean);
  }, [base, currentDir, state.view]);

  const narrow = layout.compact;
  const showList = !narrow || !state.selected;
  const showViewer = !!state.selected && (!narrow || !!state.selected);
  const visibleTransfers = transfers.slice(0, 6);
  const remoteHosts = hosts.data?.remoteHosts ?? [];

  const fileEntries = entries.filter((entry) => entry.kind !== "directory");
  const selectedIndex = fileEntries.findIndex((entry) => entry.path === state.selected);
  // Short form for the chip, alias and last folder: the full location is in the picker.
  const sourceLabel = state.location ? shortLocation(state.location) : t("panel.workspace");

  // Up and Down walk the file list, / focuses the search, while the panel is on screen and
  // nothing else has focus. Space, J, K, L, I and O belong to the player.
  const keyState = useRef({ fileEntries, selectedIndex, entries });
  keyState.current = { fileEntries, selectedIndex, entries };
  useEffect(() => {
    if (!isWeb) return;
    return listenForKeys((key) => {
      if (!isShown(rootRef.current) || !focusIsFree(rootRef.current)) return false;
      const { fileEntries: list, selectedIndex: index } = keyState.current;
      if (key.code === "Slash") {
        searchRef.current?.focus();
        return true;
      }
      if (key.code !== "ArrowDown" && key.code !== "ArrowUp") return false;
      if (list.length === 0) return false;
      const next = key.code === "ArrowDown" ? Math.min(list.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
      update({ selected: list[next]!.path });
      listRef.current?.scrollToIndex({ index: Math.max(0, keyState.current.entries.indexOf(list[next]!)), viewPosition: 0.5, animated: true });
      return true;
    });
  }, []);

  const filterOptions: { value: TabState["filter"]; label: string; icon?: string }[] = [
    { value: "all", label: t("panel.all") },
    { value: "video", label: t("panel.video"), icon: "Film" },
    { value: "audio", label: t("panel.audio"), icon: "AudioLines" },
    { value: "image", label: t("panel.image"), icon: "Image" },
  ];

  const listColumn = (
    <View style={{ width: narrow ? "100%" : 330, flexShrink: 0, borderRightWidth: narrow ? 0 : 1, borderRightColor: colors.border, flex: narrow ? 1 : undefined }}>
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>{t("panel.title")}</Text>
          {listing.data ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{counts.all}</Text> : null}
          <View style={{ flex: 1 }} />
          <IconButton theme={theme} icon="RefreshCw" size="sm" label={t("panel.refresh")} onPress={() => void listing.refetch()} />
          {isWeb ? (
            <Button theme={theme} compact primary icon="Upload" label={t("panel.upload")} disabled={!uploadDir} onPress={() => void pickFiles().then(startUpload)} />
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Segmented
            theme={theme}
            value={state.view}
            onChange={(view) => update({ view, dir: null })}
            options={[
              { value: "recent", label: t("panel.recent"), icon: "Clock" },
              { value: "folder", label: t("panel.folders"), icon: "FolderTree" },
            ]}
          />
          <View style={{ flex: 1, minWidth: 0, alignItems: "flex-end" }}>
            <Chip
              theme={theme}
              icon={state.location && remotePrefix(state.location) ? "Server" : "FolderGit2"}
              label={sourceLabel}
              trailingIcon="ChevronDown"
              active={!!state.location}
              onPress={() => setSourceOpen(true)}
              accessibilityLabel={t("panel.source")}
            />
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 32, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.surface1 }}>
          <Icon name="Search" size={14} color={colors.foregroundMuted} />
          <TextInput
            ref={searchRef}
            value={search}
            onChangeText={setSearch}
            placeholder={t("panel.search")}
            placeholderTextColor={colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[{ flex: 1, height: 30, color: colors.foreground, fontSize: 13 }, NO_OUTLINE]}
          />
          {search ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("panel.clearSearch")} onPress={() => setSearch("")}>
              <Icon name="X" size={14} color={colors.foregroundMuted} />
            </Pressable>
          ) : isWeb ? (
            <Kbd theme={theme}>/</Kbd>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 0, marginHorizontal: -4 }}>
          {filterOptions.map((option) => (
            <Chip
              key={option.value}
              dense
              theme={theme}
              icon={option.icon}
              label={option.label}
              count={listing.data ? counts[option.value] : undefined}
              active={state.filter === option.value}
              onPress={() => update({ filter: option.value })}
            />
          ))}
        </View>
        {state.view === "folder" && base ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Pressable accessibilityRole="button" onPress={() => update({ dir: null })}>
                <Text style={{ color: crumbs.length ? colors.accent : colors.foreground, fontSize: 12, fontWeight: "500" }}>
                  {remotePrefix(base) ?? (relativeTo(workspaceRoot, base) === base ? base.split("/").filter(Boolean).at(-1) ?? "/" : t("panel.workspace"))}
                </Text>
              </Pressable>
              {crumbs.map((crumb, index) => (
                <View key={`${index}:${crumb}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Icon name="ChevronRight" size={12} color={colors.foregroundMuted} />
                  <Pressable accessibilityRole="button" onPress={() => update({ dir: joinPath(base, crumbs.slice(0, index + 1).join("/")) })}>
                    <Text style={{ color: index === crumbs.length - 1 ? colors.foreground : colors.accent, fontSize: 12, fontWeight: "500" }}>{crumb}</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}
      </View>
      <View style={{ height: 1, backgroundColor: colors.border }} />

      {!base ? (
        <Message theme={theme} loading text={t("viewer.loading")} />
      ) : listing.isError ? (
        <Message theme={theme} tone="danger" icon="TriangleAlert" text={listing.error instanceof Error ? listing.error.message : String(listing.error)} />
      ) : listing.isPending ? (
        <Message theme={theme} loading text={t("panel.scanning")} />
      ) : entries.length === 0 ? (
        <Message
          theme={theme}
          icon={search ? "SearchX" : "Clapperboard"}
          text={search ? t("panel.noMatch", { query: search }) : state.view === "recent" ? t("panel.emptyRecent") : t("panel.emptyFolder")}
        />
      ) : (
        <FlatList
          ref={listRef}
          data={entries}
          keyExtractor={(entry) => entry.path}
          contentContainerStyle={{ padding: 6, gap: 1 }}
          onScrollToIndexFailed={() => undefined}
          renderItem={({ item }) => (
            <EntryRow
              theme={theme}
              entry={item}
              root={listRoot}
              locale={locale}
              showFolder={state.view === "recent"}
              selected={item.path === state.selected}
              onPress={() => (item.kind === "directory" ? update({ dir: item.path }) : update({ selected: item.path }))}
            />
          )}
          ListFooterComponent={
            listing.data?.truncated ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, padding: 10 }}>{t("panel.truncated")}</Text> : null
          }
        />
      )}

      <PendingUploads theme={theme} uploads={unfinished} root={base ?? ""} locale={locale} onResume={resumeFromList} onDiscard={discardFromList} />

      {visibleTransfers.length > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600", flex: 1, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("transfers.title")}</Text>
            <Pressable onPress={clearFinishedTransfers} accessibilityRole="button">
              <Text style={{ color: colors.accent, fontSize: 11 }}>{t("transfers.clear")}</Text>
            </Pressable>
          </View>
          {visibleTransfers.map((transfer) => (
            <TransferRow key={transfer.id} theme={theme} transfer={transfer} onShow={(path) => update({ selected: path })} />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View ref={rootRef} style={{ flex: 1, flexDirection: narrow ? "column" : "row", backgroundColor: colors.surface0 }}>
      {showList ? listColumn : null}
      {showViewer && !narrow && viewerHeight >= 520 ? (
        <View style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 16 }} onLayout={(event) => setViewerHeight(event.nativeEvent.layout.height)}>
          <MediaViewer theme={theme} compact={false} path={state.selected!} workspaceId={workspaceId} workspaceRoot={workspaceRoot} agentId={null} variant="panel" fill compare={compare} />
        </View>
      ) : showViewer ? (
        <ScrollView
          style={{ flex: 1 }}
          onLayout={(event) => setViewerHeight(event.nativeEvent.layout.height)}
          contentContainerStyle={{ padding: narrow ? 12 : 20, gap: 12 }}
        >
          {narrow ? (
            <View style={{ flexDirection: "row" }}>
              <Button theme={theme} compact icon="ArrowLeft" label={t("panel.back")} onPress={() => update({ selected: null })} />
            </View>
          ) : null}
          <MediaViewer theme={theme} compact={narrow} path={state.selected!} workspaceId={workspaceId} workspaceRoot={workspaceRoot} agentId={null} variant="panel" compare={compare} />
        </ScrollView>
      ) : !narrow ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 }}>
          <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: colors.surface1, alignItems: "center", justifyContent: "center" }}>
            <Icon name="Clapperboard" size={26} color={colors.foregroundMuted} />
          </View>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>{t("panel.pick")}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, textAlign: "center", maxWidth: 360 }}>{isWeb ? t("panel.pickHint") : t("panel.pickHintNative")}</Text>
          {isWeb ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 4 }}>
              {(
                [
                  [["↑", "↓"], t("shortcuts.browse")],
                  [["Space"], t("shortcuts.play")],
                  [["I", "O"], t("shortcuts.marks")],
                  [["/"], t("shortcuts.search")],
                ] as [string[], string][]
              ).map(([keys, label]) => (
                <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {keys.map((key) => (
                    <Kbd key={key} theme={theme}>
                      {key}
                    </Kbd>
                  ))}
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <SourcePicker
        theme={theme}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        current={state.location}
        recent={state.recentLocations}
        remoteHosts={remoteHosts}
        onChoose={(location) => {
          chooseLocation(location);
          setSourceOpen(false);
        }}
      />
      {dropActive ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            top: 8,
            bottom: 8,
            borderWidth: 2,
            borderStyle: "dashed",
            borderColor: colors.accent,
            borderRadius: 10,
            backgroundColor: colors.surface1,
            opacity: 0.92,
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon name="Upload" size={28} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: 14 }}>{t("panel.dropHere", { dir: uploadDir ? relativeTo(workspaceRoot, uploadDir) : "" })}</Text>
        </View>
      ) : null}
    </View>
  );
}
