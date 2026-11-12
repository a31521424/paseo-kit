import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { formatBytes, formatDuration, formatFps, formatTimecode, formatTimecodeShort, parseTimecode, relativeTo, snapToFrame } from "../shared/media";
import { imageRpc, loudnessRpc, streamCloseRpc, streamOpenRpc, streamReadRpc, type MediaInfo, type Quality, type ReviewNote } from "../shared/rpc";
import { settingsDefinition } from "../shared/settings";
import { messages } from "./i18n";
import { markResumeOnReturn, rememberPlayback, rememberedPlayback, takeResumeOnReturn } from "./playback";
import { useFileVersion, useFilmstrip, useFrame, useProbe, useWaveform } from "./queries";
import { NotesList, useNotes } from "./notes";
import { ReviewBox } from "./review";
import { Timeline } from "./timeline";
import { downloadFile } from "./transfers";
import { Badge, Group, IconButton, Kbd, Message, NO_OUTLINE, TextToggle } from "./ui";
import {
  StreamPlayer,
  VideoSurface,
  base64ToBytes,
  focusIsFree,
  isShown,
  isWeb,
  listenForKeys,
  supportsH264,
  supportsStreaming,
  toggleFullscreen,
  watchFrames,
  type KeyInfo,
  type StreamSession,
  type VideoLike,
} from "./web";

export interface ViewerProps {
  theme: PluginTheme;
  compact: boolean;
  /** A daemon path, or alias:/path on an SSH host. */
  path: string;
  cwd?: string | null;
  workspaceId: string | null;
  workspaceRoot: string | null;
  /** Notes go to this agent; null lets the user pick one of the workspace's agents. */
  agentId: string | null;
  variant: "panel" | "inline";
  /** Bumped by the caller when it knows the file changed. */
  version?: number;
  /** Shows the file in the Media panel; receives the resolved path. */
  onOpenInPanel?: (path: string) => void;
  /** Fill the parent's height: the picture grows into the free space instead of a fixed maximum. */
  fill?: boolean;
  /** Another file to flip to at the same moment, such as the previous version of a cut. */
  compare?: { path: string; name: string; onSelect(path: string): void } | null;
}

/** The largest box with `aspect` that fits in `area`. */
function fitBox(area: { width: number; height: number }, aspect: number): { width: number; height: number } {
  const width = Math.min(area.width, area.height * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

const QUALITIES: Quality[] = ["auto", "original", "1080", "720", "480"];
const RATES = [0.5, 1, 1.5, 2];

/** The player the keyboard controls: the one used last. */
let activePlayer: symbol | null = null;

/** Shows any media file: a streaming player for video and audio, a viewer for images. */
export function MediaViewer(props: ViewerProps) {
  const { t } = useTranslation(messages);
  const polled = useFileVersion(props.path, props.cwd, props.variant === "panel" ? 4000 : null);
  const version = (props.version ?? 0) + polled;
  const probe = useProbe(props.path, props.cwd, version);
  if (probe.isPending) return <Message theme={props.theme} loading text={t("viewer.loading")} style={props.fill ? { flex: 1 } : undefined} />;
  if (probe.isError || !probe.data) {
    return <Message theme={props.theme} tone="danger" icon="TriangleAlert" text={probe.error instanceof Error ? probe.error.message : t("viewer.unreadable")} />;
  }
  const info = probe.data;
  if (info.kind === "image") return <ImageViewer {...props} info={info} />;
  return <Player key={`${info.path}:${info.modifiedAt}`} {...props} info={info} />;
}


/** Where a file lives: its folder relative to the workspace, and the SSH host if it is remote. */
function describeLocation(path: string, workspaceRoot: string | null): { host: string | null; name: string; folder: string } {
  const host = /^[^/:]+:\//.test(path) ? path.slice(0, path.indexOf(":")) : null;
  const local = host ? path.slice(host.length + 1) : path;
  const relative = relativeTo(host ? null : workspaceRoot, local);
  const cut = relative.lastIndexOf("/");
  return { host, name: cut >= 0 ? relative.slice(cut + 1) : relative, folder: cut > 0 ? relative.slice(0, cut) : cut === 0 ? "/" : "" };
}

function metaChips(info: MediaInfo, mode: string | null): string[] {
  return [
    info.width && info.height ? `${info.width}×${info.height}` : null,
    formatFps(info.fps) || null,
    [info.videoCodec, info.audioCodec].filter(Boolean).join(" · ").toUpperCase() || null,
    info.kind === "audio" && info.sampleRate ? `${Math.round(info.sampleRate / 100) / 10} kHz` : null,
    info.duration ? formatDuration(info.duration) : null,
    formatBytes(info.size),
    mode,
  ].filter((part): part is string => !!part);
}

/** File name as the title, its folder and host below, the facts as quiet chips, actions on the right. */
function MediaHeader({
  theme,
  info,
  workspaceRoot,
  mode,
  actions,
}: {
  theme: PluginTheme;
  info: MediaInfo;
  workspaceRoot: string | null;
  mode: string | null;
  actions: ReactNode;
}) {
  const { colors } = theme;
  const where = describeLocation(info.path, workspaceRoot);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
            {where.name}
          </Text>
          {where.folder || where.host ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {where.host ? <Badge theme={theme} label={where.host} tone="accent" /> : null}
              {where.folder ? (
                <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}>
                  {where.folder}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>{actions}</View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        {metaChips(info, mode).map((chip) => (
          <View key={chip} style={{ height: 20, paddingHorizontal: 7, borderRadius: 5, justifyContent: "center", backgroundColor: colors.surface1 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{chip}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The dark stage around the picture, the same in every theme, like a monitor. */
const STAGE = "#0d0d10";

function SectionTitle({ theme, label, count, action }: { theme: PluginTheme; label: string; count?: number; action?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>{label}</Text>
      {count ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
      {action ? <View style={{ flex: 1, alignItems: "flex-end" }}>{action}</View> : null}
    </View>
  );
}

/** The notes as a plain list with timecodes, newest last, for a client, a colleague or another agent. */
export function notesAsText(info: MediaInfo, notes: readonly ReviewNote[], heading: string): string {
  const tc = (value: number) => formatTimecode(value, info.fps);
  const lines = [...notes]
    .sort((a, b) => (a.inPoint ?? a.time) - (b.inPoint ?? b.time))
    .map((note) => {
      const when = note.inPoint !== null ? `${tc(note.inPoint)} - ${tc(note.outPoint ?? info.duration ?? note.inPoint)}` : tc(note.time);
      const stale = note.fileModifiedAt !== info.modifiedAt ? " (earlier version)" : "";
      return `${when}${stale}  ${note.text}`;
    });
  return [`${info.name} — ${heading} (${notes.length})`, ...lines].join("\n");
}

function DetailsTable({ theme, info, workspaceRoot }: { theme: PluginTheme; info: MediaInfo; workspaceRoot: string | null }) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const rows: [string, string][] = [
    [t("details.resolution"), info.width && info.height ? `${info.width} × ${info.height}` : "-"],
    [t("details.framerate"), formatFps(info.fps) || "-"],
    [t("details.duration"), info.duration ? formatTimecode(info.duration, info.fps) : "-"],
    [t("details.video"), info.videoCodec?.toUpperCase() ?? "-"],
    [t("details.audio"), info.audioCodec ? `${info.audioCodec.toUpperCase()}${info.sampleRate ? ` · ${Math.round(info.sampleRate / 100) / 10} kHz` : ""}${info.channels ? ` · ${info.channels} ch` : ""}` : "-"],
    [t("details.bitrate"), info.bitRate ? `${(info.bitRate / 1_000_000).toFixed(1)} Mbps` : "-"],
    [t("details.size"), formatBytes(info.size)],
    [t("details.path"), relativeTo(workspaceRoot, info.path)],
  ];
  return (
    <View style={{ gap: 6 }}>
      {info.hasAudio ? <LoudnessRow theme={theme} info={info} /> : null}
      {rows.map(([label, value]) => (
        <View key={label} style={{ flexDirection: "row", gap: 10 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, width: 78 }}>{label}</Text>
          <Text selectable numberOfLines={label === rows.at(-1)![0] ? 3 : 1} style={{ color: colors.foreground, fontSize: 12, flex: 1, fontVariant: ["tabular-nums"] }}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Files this short are measured as soon as their details show; longer ones on request. */
const AUTO_LOUDNESS_SECONDS = 600;

/**
 * Integrated loudness, true peak and range, against what streaming and social platforms normalize
 * to (about −14 LUFS, true peak under −1 dBTP). The usual last check before a cut goes out.
 */
function LoudnessRow({ theme, info }: { theme: PluginTheme; info: MediaInfo }) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const measure = useRpc(loudnessRpc);
  const [asked, setAsked] = useState((info.duration ?? 0) <= AUTO_LOUDNESS_SECONDS);
  const query = useQuery({
    queryKey: ["media-studio", "loudness", info.path, info.modifiedAt],
    queryFn: () => measure({ path: info.path }),
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
  const result = query.data;
  const hints: string[] = [];
  if (result?.integrated !== null && result?.integrated !== undefined) {
    if (result.integrated > -13) hints.push(t("details.loudHint"));
    else if (result.integrated < -16) hints.push(t("details.quietHint"));
  }
  if (result?.truePeak !== null && result?.truePeak !== undefined && result.truePeak > -1) hints.push(t("details.peakHint"));
  const signed = (value: number) => (value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1));
  let body: ReactNode;
  if (!asked) {
    body = (
      <Pressable accessibilityRole="button" onPress={() => setAsked(true)}>
        <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>{t("details.measure")}</Text>
      </Pressable>
    );
  } else if (query.isPending) {
    body = <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{t("details.measuring")}</Text>;
  } else if (query.isError) {
    body = (
      <Text numberOfLines={2} style={{ color: colors.statusDanger, fontSize: 12 }}>
        {t("details.loudnessFailed", { error: query.error instanceof Error ? query.error.message : String(query.error) })}
      </Text>
    );
  } else {
    const parts = [
      result?.integrated !== null && result?.integrated !== undefined ? `${result.integrated.toFixed(1)} LUFS` : null,
      result?.truePeak !== null && result?.truePeak !== undefined ? `TP ${signed(result.truePeak)} dBTP` : null,
      result?.range !== null && result?.range !== undefined ? `LRA ${result.range.toFixed(1)} LU` : null,
    ].filter(Boolean);
    body = (
      <View style={{ flex: 1, gap: 3 }}>
        <Text selectable style={{ color: hints.length ? colors.statusWarning : colors.foreground, fontSize: 12, fontWeight: hints.length ? "600" : "400", fontVariant: ["tabular-nums"] }}>
          {parts.join(" · ") || "-"}
        </Text>
        {hints.map((hint) => (
          <Text key={hint} style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>
            {hint}
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, width: 78 }}>{t("details.loudness")}</Text>
      {body}
    </View>
  );
}

/**
 * Framing guides over the picture, for checking a cut before it goes out: action and title safe
 * areas; on vertical video the zones a short-video app covers with captions and buttons; on
 * horizontal video the 9:16, 4:5 and 1:1 crops the same footage often gets cut down to.
 */
function Guides({ aspect, compact }: { aspect: number; compact: boolean }) {
  const { t } = useTranslation(messages);
  const line = "rgba(255,255,255,0.55)";
  const zone = "rgba(255,90,90,0.16)";
  const label = { position: "absolute" as const, color: "rgba(255,255,255,0.85)", fontSize: compact ? 9 : 10, fontWeight: "600" as const };
  const box = (inset: string, style: object) => (
    <View pointerEvents="none" style={[{ position: "absolute", left: inset, right: inset, top: inset, bottom: inset, borderWidth: 1, borderColor: line }, style] as never} />
  );
  const crops: [number, string][] = aspect > 1.2 ? [[9 / 16, t("guides.crop916")], [4 / 5, t("guides.crop45")], [1, t("guides.crop11")]] : [];
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
      {box("3.5%", { borderStyle: "dashed", opacity: 0.6 })}
      {box("5%", {})}
      <View style={{ position: "absolute", left: "50%", top: "50%", width: 18, height: 1, marginLeft: -9, backgroundColor: line }} />
      <View style={{ position: "absolute", left: "50%", top: "50%", width: 1, height: 18, marginTop: -9, backgroundColor: line }} />
      {aspect < 0.8 ? (
        <>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "22%", backgroundColor: zone, borderTopWidth: 1, borderTopColor: "rgba(255,120,120,0.6)" }}>
            <Text style={[label, { left: 8, top: 4 }]}>{t("guides.caption")}</Text>
          </View>
          <View style={{ position: "absolute", right: 0, width: "15%", top: "38%", bottom: "22%", backgroundColor: zone, borderLeftWidth: 1, borderLeftColor: "rgba(255,120,120,0.6)" }}>
            <Text style={[label, { left: 4, top: 4 }]}>{t("guides.buttons")}</Text>
          </View>
        </>
      ) : null}
      {crops.map(([ratio, name], index) => {
        const share = ratio / aspect;
        return (
          <View
            key={name}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${Number((((1 - share) / 2) * 100).toFixed(2))}%` as `${number}%`,
              width: `${Number((share * 100).toFixed(2))}%` as `${number}%`,
              borderLeftWidth: 1,
              borderRightWidth: 1,
              borderColor: "rgba(110,190,255,0.9)",
              borderStyle: "dashed",
            }}
          >
            <View style={{ position: "absolute", left: 3, top: 6 + index * (compact ? 16 : 20), paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, backgroundColor: "rgba(0,0,0,0.55)" }}>
              <Text style={{ color: "rgba(170,220,255,1)", fontSize: compact ? 9 : 10, fontWeight: "700" }}>{name}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const SHORTCUTS: [string[], string][] = [
  [["Space", "K"], "shortcuts.play"],
  [["←", "→"], "shortcuts.frame"],
  [["⇧ ←", "⇧ →"], "shortcuts.second"],
  [["J"], "shortcuts.back"],
  [["L"], "shortcuts.faster"],
  [["I", "O"], "shortcuts.marks"],
  [["X"], "shortcuts.clear"],
  [["Home", "End"], "shortcuts.ends"],
  [["F"], "shortcuts.fullscreen"],
  [["T", "0–9"], "shortcuts.goto"],
  [["G"], "shortcuts.guides"],
  [["B"], "shortcuts.compare"],
  [["↑", "↓"], "shortcuts.browse"],
  [["/"], "shortcuts.search"],
];

function ShortcutsSheet({ theme, open, onOpenChange }: { theme: PluginTheme; open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation(messages);
  const { colors } = theme;
  return (
    <Modal title={t("shortcuts.title")} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{t("shortcuts.hint")}</Text>
        {SHORTCUTS.map(([keys, label]) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 }}>
            <View style={{ flexDirection: "row", gap: 4, width: 120 }}>
              {keys.map((key) => (
                <Kbd key={key} theme={theme}>
                  {key}
                </Kbd>
              ))}
            </View>
            <Text style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>{t(label as "shortcuts.play")}</Text>
          </View>
        ))}
      </Modal.Content>
    </Modal>
  );
}

/** Guides stay on across files and players once turned on, like a monitor overlay. */
let guidesOn = false;

function Player({ theme, compact, info, workspaceId, workspaceRoot, agentId, variant, onOpenInPanel, fill, compare }: ViewerProps & { info: MediaInfo }) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const settings = useSettings(settingsDefinition);
  const defaultQuality = settings.status === "ready" ? settings.values.quality : "auto";
  const [quality, setQuality] = useState<Quality | null>(null);
  const activeQuality = quality ?? defaultQuality;
  const streamOpen = useRpc(streamOpenRpc);
  const streamRead = useRpc(streamReadRpc);
  const streamClose = useRpc(streamCloseRpc);

  const inline = variant === "inline";
  const streaming = isWeb && supportsStreaming();
  const duration = info.duration ?? 0;
  const fps = info.fps;
  const frameStep = fps ? 1 / fps : 1 / 30;

  // Where this file was left, in this player or another one (the panel before its tab was hidden,
  // the same file before a re-render), and whether it was playing when its player went away.
  const remembered = useMemo(() => {
    const memory = rememberedPlayback(info.path);
    if (!memory) return null;
    const last = duration > 0 ? Math.max(0, duration - frameStep) : Number.POSITIVE_INFINITY;
    const within = (value: number | null) => (value !== null && value >= 0 && value <= last + frameStep ? value : null);
    return { ...memory, time: Math.min(Math.max(0, memory.time), last), inPoint: within(memory.inPoint), outPoint: within(memory.outPoint) };
  }, [info.path]);
  const resumeRef = useRef<boolean | null>(null);
  if (resumeRef.current === null) resumeRef.current = !inline && takeResumeOnReturn(info.path);
  const startAt = remembered?.time ?? 0;

  const [video, setVideo] = useState<VideoLike | null>(null);
  const [time, setTime] = useState(startAt);
  const timeRef = useRef(startAt);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [session, setSession] = useState<StreamSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inPoint, setInPoint] = useState<number | null>(remembered?.inPoint ?? null);
  const [outPoint, setOutPoint] = useState<number | null>(remembered?.outPoint ?? null);
  const [loop, setLoop] = useState(remembered?.loop ?? false);
  const [rate, setRate] = useState(remembered?.rate ?? 1);
  const [muted, setMuted] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showNote, setShowNote] = useState(!inline);
  const [guides, setGuides] = useState(!inline && guidesOn);
  const toggleGuides = () =>
    setGuides((value) => {
      guidesOn = !value;
      return !value;
    });
  /** Text of the timecode being typed to jump, or null when the timecode is just shown. */
  const [goto, setGotoState] = useState<string | null>(null);
  /** The box shows the current timecode, selected, so the first key typed replaces it. */
  const [gotoFresh, setGotoFresh] = useState(false);
  // Keys typed before the box takes focus still arrive through the player's key handler; the ref
  // keeps them in order between renders.
  const gotoRef = useRef<{ text: string; fresh: boolean } | null>(null);
  const setGoto = (text: string | null, fresh = false) => {
    gotoRef.current = text === null ? null : { text, fresh };
    setGotoState(text);
    setGotoFresh(fresh);
  };
  const typeGoto = (char: string) => {
    const current = gotoRef.current;
    setGoto(!current || current.fresh ? char : current.text + char);
  };
  const surfaceRef = useRef<View>(null);
  const rootRef = useRef<View>(null);
  const identity = useMemo(() => Symbol("player"), []);
  const loopRef = useRef({ loop, inPoint, outPoint });
  loopRef.current = { loop, inPoint, outPoint };

  const [stripWidth, setStripWidth] = useState(0);
  const frameCount = stripWidth > 900 ? 24 : stripWidth > 560 ? 16 : stripWidth > 300 ? 10 : 6;
  const filmstrip = useFilmstrip(info, frameCount);
  const waveform = useWaveform(info, 600);
  /** A seek outside the buffer: the frame there is shown as a still until the video catches up. */
  const [pendingSeek, setPendingSeek] = useState<number | null>(startAt > 0 && streaming && info.hasVideo ? startAt : null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const scrubFrame = useFrame(info, scrub ?? pendingSeek ?? (!streaming ? time : null), inline ? 640 : 1280);
  const hoverFrame = useFrame(info, hover, 240);

  // The streaming engine; a new one for each file version or quality, resuming where playback was.
  useEffect(() => {
    if (!video || !streaming) return;
    setError(null);
    setBuffered([]);
    const player = new StreamPlayer(
      video,
      {
        open: (start) => streamOpen({ path: info.path, start, quality: activeQuality, h264: supportsH264() }),
        read: async (sessionId) => {
          const result = await streamRead({ sessionId });
          return { bytes: result.base64 ? base64ToBytes(result.base64) : new Uint8Array(0), done: result.done };
        },
        close: (sessionId) => void streamClose({ sessionId }).catch(() => undefined),
      },
      duration,
      fps,
      info.hasVideo ? 40 : 120,
      { onSession: setSession, onBuffered: setBuffered, onError: setError },
      timeRef.current,
    );
    let resume: (() => void) | null = null;
    if (resumeRef.current) {
      resumeRef.current = false;
      activePlayer = identity;
      resume = () => void video.play().catch(() => undefined);
      video.addEventListener("canplay", resume, { once: true });
    }
    return () => {
      if (resume) video.removeEventListener("canplay", resume);
      player.destroy();
    };
    // The RPC functions are stable for the plugin session; only these inputs restart playback.
  }, [video, streaming, info.path, info.modifiedAt, activeQuality]);

  useEffect(() => {
    if (!video) return;
    const update = () => {
      timeRef.current = video.currentTime;
      setTime(video.currentTime);
    };
    const onPlay = () => {
      // Playing something else means the hidden panel should not start by itself later.
      markResumeOnReturn(null);
      playingRef.current = true;
      setPlaying(true);
    };
    const onPause = () => {
      playingRef.current = false;
      setPlaying(false);
    };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onEnded = () => {
      if (loopRef.current.loop) {
        video.currentTime = loopRef.current.inPoint ?? 0;
        void video.play().catch(() => undefined);
      }
    };
    const stopFrames = watchFrames(video, (mediaTime) => {
      const { loop: looping, inPoint: start, outPoint: end } = loopRef.current;
      if (looping && end !== null && mediaTime >= end) {
        video.currentTime = start ?? 0;
        return;
      }
      timeRef.current = mediaTime;
      setTime(mediaTime);
    });
    const events: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["playing", onPlaying],
      ["seeked", () => {
        update();
        setPendingSeek(null);
      }],
      ["timeupdate", update],
      ["ended", onEnded],
      ["canplay", onPlaying],
    ];
    for (const [name, handler] of events) video.addEventListener(name, handler);
    return () => {
      stopFrames();
      for (const [name, handler] of events) video.removeEventListener(name, handler);
    };
  }, [video]);

  // Remembers where this file is, for the next time a player shows it; on unmount also whether it
  // was playing, so the full-size player continues when its tab comes back.
  const playingRef = useRef(false);
  const memoryRef = useRef({ time, inPoint, outPoint, loop, rate, version: info.modifiedAt });
  memoryRef.current = { time, inPoint, outPoint, loop, rate, version: info.modifiedAt };
  // A new version of a file that was open: say so, since the picture changes under the playhead.
  useEffect(() => {
    if (inline || !remembered?.version || remembered.version === info.modifiedAt || Date.now() - remembered.savedAt > 10 * 60_000) return;
    toast.show(t("viewer.newVersion", { time: formatTimecode(startAt, fps) }), { durationMs: 3500 });
  }, []);
  useEffect(() => {
    if (!remembered && time === 0 && inPoint === null && outPoint === null && !loop && rate === 1) return;
    rememberPlayback(info.path, memoryRef.current);
  }, [time, inPoint, outPoint, loop, rate]);
  useEffect(
    () => () => {
      const memory = memoryRef.current;
      if (remembered || memory.time > 0 || memory.inPoint !== null || memory.outPoint !== null) rememberPlayback(info.path, memory, true);
      if (!inline && playingRef.current) markResumeOnReturn(info.path);
    },
    [],
  );

  useEffect(() => {
    if (video) video.playbackRate = rate;
  }, [video, rate]);
  useEffect(() => {
    if (video) video.muted = muted;
  }, [video, muted]);

  const seek = (target: number) => {
    const clamped = Math.max(0, Math.min(duration || target, target));
    timeRef.current = clamped;
    setTime(clamped);
    if (streaming && info.hasVideo && !buffered.some(([start, end]) => clamped >= start && clamped < end - 0.1)) setPendingSeek(clamped);
    if (video) video.currentTime = clamped;
  };
  const togglePlay = () => {
    activePlayer = identity;
    if (!video) return;
    if (video.paused) {
      if (duration && video.currentTime >= duration - 0.05) seek(inPoint ?? 0);
      void video.play().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    } else {
      video.pause();
    }
  };
  const step = (frames: number) => {
    video?.pause();
    seek(snapToFrame(timeRef.current, fps) + frames * frameStep + frameStep / 4);
  };
  const markIn = () => {
    const at = snapToFrame(timeRef.current, fps);
    setInPoint(at);
    if (outPoint !== null && outPoint <= at) setOutPoint(null);
  };
  const markOut = () => {
    const at = snapToFrame(timeRef.current, fps);
    setOutPoint(at);
    if (inPoint !== null && inPoint >= at) setInPoint(null);
  };

  /** Opens the other file at this moment, still playing if this one was. */
  const flipToCompare = () => {
    if (!compare) return;
    const other = rememberedPlayback(compare.path);
    rememberPlayback(compare.path, {
      time: timeRef.current,
      inPoint: other?.inPoint ?? null,
      outPoint: other?.outPoint ?? null,
      loop: other?.loop ?? loop,
      rate,
      version: other?.version,
    });
    if (playingRef.current) markResumeOnReturn(compare.path, true);
    compare.onSelect(compare.path);
  };
  const submitGoto = (text: string) => {
    const target = parseTimecode(text, fps, timeRef.current);
    setGoto(null);
    if (target === null) {
      if (text.trim()) toast.error(t("viewer.gotoInvalid", { text: text.trim() }));
      return;
    }
    activePlayer = identity;
    seek(snapToFrame(target, fps) + (fps ? frameStep / 4 : 0));
  };

  // Keyboard: the usual editor keys, for the player used last while it is on screen and nothing
  // else has focus. The handler reads the latest render through a ref, so it is registered once.
  const onKey = useRef<(key: KeyInfo) => boolean>(() => false);
  onKey.current = (key) => {
    if (activePlayer !== identity || !video?.isConnected || !isShown(video) || !focusIsFree(rootRef.current)) return false;
    if (key.altKey) return false;
    // The timecode box is open but has not taken focus yet.
    if (gotoRef.current !== null) {
      if (key.key === "Enter") submitGoto(gotoRef.current.text);
      else if (key.key === "Escape") setGoto(null);
      else if (key.key === "Backspace") setGoto(gotoRef.current.fresh ? "" : gotoRef.current.text.slice(0, -1));
      else if (/^[\d:;.+-]$/.test(key.key)) typeGoto(key.key);
      else return false;
      return true;
    }
    // Typing a number jumps there, as in an editor's timeline.
    if (!inline && streaming && /^[\d+-]$/.test(key.key)) {
      video.pause();
      setGoto(key.key);
      return true;
    }
    switch (key.code) {
      case "Space":
      case "KeyK":
        togglePlay();
        return true;
      case "ArrowLeft":
        if (key.shiftKey) seek(timeRef.current - 1);
        else step(-1);
        return true;
      case "ArrowRight":
        if (key.shiftKey) seek(timeRef.current + 1);
        else step(1);
        return true;
      case "KeyJ":
        seek(timeRef.current - 5);
        return true;
      case "KeyL":
        setRate((value) => (value >= 2 ? 1 : value >= 1 ? 2 : 1));
        if (video.paused) void video.play().catch(() => undefined);
        return true;
      case "KeyI":
        markIn();
        return true;
      case "KeyO":
        markOut();
        return true;
      case "KeyX":
        setInPoint(null);
        setOutPoint(null);
        return true;
      case "Home":
        seek(0);
        return true;
      case "End":
        seek(Math.max(0, duration - frameStep));
        return true;
      case "KeyF":
        toggleFullscreen(surfaceRef.current);
        return true;
      case "KeyT":
        video.pause();
        setGoto(formatTimecode(timeRef.current, fps), true);
        return true;
      case "KeyG":
        if (!info.hasVideo || inline) return false;
        toggleGuides();
        return true;
      case "KeyB":
        if (!compare) return false;
        flipToCompare();
        return true;
      default:
        return false;
    }
  };
  useEffect(() => {
    if (!streaming) return;
    if (!inline) activePlayer = identity;
    return listenForKeys((key) => onKey.current(key));
  }, [streaming, inline, identity]);


  const aspect = info.width && info.height ? info.width / info.height : 16 / 9;
  const maxHeight = inline ? (compact ? 200 : 280) : compact ? 260 : 460;
  const modeLabel =
    session?.mode === "copy" || session?.mode === "bridge"
      ? t("viewer.modeOriginal")
      : session?.mode === "transcode"
        ? t("viewer.modeProxy", { height: String(Math.min(session.width ?? 0, session.height ?? 0) || "") }) +
          (session.encoder && session.encoder !== "libx264" ? ` · ${session.encoder.replace("h264_", "").toUpperCase()}` : "")
        : null;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [rootWidth, setRootWidth] = useState(0);
  const wide = !!fill && rootWidth >= 1200;
  const notes = useNotes(info.path);
  const { locale } = useTranslation(messages);
  const jumpToNote = (note: ReviewNote) => {
    activePlayer = identity;
    if (note.inPoint !== null) {
      setInPoint(note.inPoint);
      setOutPoint(note.outPoint);
      seek(note.inPoint);
    } else seek(note.time);
  };
  const { colors } = theme;
  const download = () => {
    void downloadFile(info.path, info.size).catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : String(reason)));
  };
  const copyPath = () => {
    void copyText(info.path).then(() => toast.show(t("viewer.copiedPath"), { variant: "success", durationMs: 1200 }));
  };
  const copyTimecode = () => {
    void copyText(formatTimecode(time, fps)).then(() => toast.show(t("viewer.copied"), { variant: "success", durationMs: 1200 }));
  };
  const shownTime = duration > 0 ? Math.min(time, duration) : time;

  const markButton = (kind: "in" | "out") => {
    const value = kind === "in" ? inPoint : outPoint;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={kind === "in" ? t("viewer.markInLong") : t("viewer.markOutLong")}
        onPress={kind === "in" ? markIn : markOut}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          height: 30,
          paddingHorizontal: 8,
          borderRadius: 7,
          backgroundColor: pressed ? colors.surface2 : "transparent",
        })}
      >
        <Text style={{ color: value !== null ? colors.accent : colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>{kind === "in" ? "IN" : "OUT"}</Text>
        {value !== null && !inline ? (
          <Text style={{ color: colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{formatTimecodeShort(value, fps, info.duration)}</Text>
        ) : null}
      </Pressable>
    );
  };

  const reviewTarget = { info, time, inPoint, outPoint };
  return (
    <View
      ref={rootRef}
      style={fill ? { flex: 1, minHeight: 0, flexDirection: wide ? "row" : "column", gap: wide ? 20 : 12 } : { gap: inline ? 8 : 12 }}
      onLayout={fill ? (event) => setRootWidth(event.nativeEvent.layout.width) : undefined}
      onTouchStart={() => {
        activePlayer = identity;
      }}
      {...({ onPointerDown: () => (activePlayer = identity) } as object)}
    >
      <View style={fill ? { flex: 1, minHeight: 0, minWidth: 0, gap: 12 } : { gap: inline ? 8 : 12 }}>
      {!inline ? (
        <MediaHeader
          theme={theme}
          info={info}
          workspaceRoot={workspaceRoot}
          mode={modeLabel}
          actions={
            <>
              {compare ? <IconButton theme={theme} icon="ArrowLeftRight" label={t("viewer.compare", { name: compare.name })} onPress={flipToCompare} /> : null}
              <IconButton theme={theme} icon="Copy" label={t("viewer.copyPath")} onPress={copyPath} />
              {isWeb ? <IconButton theme={theme} icon="Download" label={t("viewer.download")} onPress={download} /> : null}
              {streaming ? <IconButton theme={theme} icon="Keyboard" label={t("shortcuts.title")} onPress={() => setShortcutsOpen(true)} /> : null}
            </>
          }
        />
      ) : null}

      {info.hasVideo ? (
        <View
          style={fill ? { flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center", backgroundColor: STAGE, borderRadius: 12, overflow: "hidden" } : undefined}
          onLayout={fill ? (event) => setStage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }) : undefined}
        >
        <View
          ref={surfaceRef}
          style={[
            { backgroundColor: "#000", borderRadius: fill ? 0 : inline ? 8 : 10, overflow: "hidden", alignSelf: "center" },
            fill && stage ? fitBox(stage, aspect) : { width: "100%", aspectRatio: aspect, maxHeight },
          ]}
        >
          {streaming ? <VideoSurface onElement={setVideo} /> : null}
          {scrubFrame.data && (scrub !== null || pendingSeek !== null || !streaming) ? (
            <Image source={{ uri: scrubFrame.data }} resizeMode="contain" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
          ) : null}
          {guides ? <Guides aspect={aspect} compact={!fill} /> : null}
          {streaming ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing ? t("viewer.pause") : t("viewer.play")}
              onPress={togglePlay}
              style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}
            >
              {error ? (
                <View style={{ maxWidth: "80%", padding: 12, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.72)", alignItems: "center", gap: 6 }}>
                  <Icon name="TriangleAlert" size={20} color={colors.statusDanger} />
                  <Text style={{ color: "#fff", fontSize: 12, textAlign: "center" }}>{error}</Text>
                </View>
              ) : waiting || !session || pendingSeek !== null ? (
                <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
                  <ActivityIndicator color="#fff" />
                </View>
              ) : !playing && scrub === null ? (
                <View style={{ width: inline ? 52 : 64, height: inline ? 52 : 64, borderRadius: 32, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="Play" size={inline ? 22 : 28} color="#fff" />
                </View>
              ) : null}
            </Pressable>
          ) : null}
        </View>
        </View>
      ) : streaming ? (
        <VideoSurface onElement={setVideo} hidden />
      ) : null}

      {!streaming ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{t("viewer.nativeHint")}</Text> : null}

      <View onLayout={(event) => setStripWidth(event.nativeEvent.layout.width)}>
        {duration > 0 ? (
          <Timeline
            theme={theme}
            duration={duration}
            fps={fps}
            time={time}
            inPoint={inPoint}
            outPoint={outPoint}
            buffered={buffered}
            frames={info.hasVideo ? filmstrip.data ?? [] : undefined}
            peaks={info.hasAudio ? waveform.data ?? [] : undefined}
            markers={inline ? undefined : (notes.data ?? []).filter((note) => note.fileModifiedAt === info.modifiedAt).map((note) => ({ time: note.inPoint ?? note.time, end: note.inPoint !== null ? note.outPoint : null }))}
            compact={inline}
            hoverUri={hoverFrame.data ?? null}
            onSeek={(target) => {
              activePlayer = identity;
              seek(target);
            }}
            onScrub={(target) => {
              setScrub(target);
              if (target !== null && video && streaming) {
                const inside = buffered.some(([start, end]) => target >= start && target <= end);
                if (inside) video.currentTime = target;
              }
            }}
            onHover={setHover}
          />
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {streaming ? (
          <Group theme={theme}>
            {!inline ? <IconButton theme={theme} icon="SkipBack" size="sm" label={t("viewer.toStart")} onPress={() => seek(inPoint ?? 0)} /> : null}
            <IconButton theme={theme} icon="ChevronLeft" size="sm" label={t("viewer.prevFrame")} onPress={() => step(-1)} />
            <IconButton theme={theme} icon={playing ? "Pause" : "Play"} primary size={inline ? "md" : "lg"} label={playing ? t("viewer.pause") : t("viewer.play")} onPress={togglePlay} />
            <IconButton theme={theme} icon="ChevronRight" size="sm" label={t("viewer.nextFrame")} onPress={() => step(1)} />
            {!inline ? <IconButton theme={theme} icon="SkipForward" size="sm" label={t("viewer.toEnd")} onPress={() => seek(outPoint ?? Math.max(0, duration - frameStep))} /> : null}
          </Group>
        ) : null}
        {goto !== null ? (
          <TextInput
            value={goto}
            onChangeText={(text) => setGoto(text)}
            autoFocus
            selectTextOnFocus={gotoFresh}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("viewer.gotoHint")}
            placeholderTextColor={colors.foregroundMuted}
            onSubmitEditing={() => submitGoto(goto)}
            onBlur={() => setGoto(null)}
            {...({
              onKeyPress: (event: { nativeEvent: { key?: string } }) => {
                if (event.nativeEvent.key === "Escape") setGoto(null);
              },
            } as object)}
            accessibilityLabel={t("viewer.goto")}
            style={[
              { width: 132, height: 30, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.accent, color: colors.foreground, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
              NO_OUTLINE,
            ]}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={inline ? t("viewer.copyTimecode") : t("viewer.goto")}
            onPress={inline || !streaming ? copyTimecode : () => {
              video?.pause();
              setGoto(formatTimecode(timeRef.current, fps), true);
            }}
            style={({ pressed }) => ({ paddingHorizontal: 6, height: 30, justifyContent: "center", borderRadius: 7, backgroundColor: pressed ? colors.surface2 : "transparent" })}
          >
            <Text style={{ color: colors.foreground, fontSize: inline ? 12 : 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
              {formatTimecode(shownTime, fps)}
              <Text style={{ color: colors.foregroundMuted, fontWeight: "400", fontSize: inline ? 11 : 12 }}> / {formatTimecode(duration, fps)}</Text>
            </Text>
          </Pressable>
        )}
        {!inline && goto === null ? <IconButton theme={theme} icon="Copy" size="sm" label={t("viewer.copyTimecode")} onPress={copyTimecode} /> : null}
        <Group theme={theme}>
          {markButton("in")}
          {markButton("out")}
          {inPoint !== null || outPoint !== null ? (
            <IconButton
              theme={theme}
              icon="X"
              size="sm"
              label={t("viewer.clearMarks")}
              onPress={() => {
                setInPoint(null);
                setOutPoint(null);
              }}
            />
          ) : null}
        </Group>
        <View style={{ flex: 1 }} />
        {streaming ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            <IconButton theme={theme} icon="Repeat" size="sm" active={loop} label={t("viewer.loop")} onPress={() => setLoop((value) => !value)} />
            {!inline ? (
              <>
                <TextToggle theme={theme} label={`${rate}×`} active={rate !== 1} accessibilityLabel={t("viewer.speed")} onPress={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]!)} />
                <IconButton theme={theme} icon={muted ? "VolumeX" : "Volume2"} size="sm" active={muted} label={t("viewer.mute")} onPress={() => setMuted((value) => !value)} />
                {info.hasVideo ? (
                  <TextToggle
                    theme={theme}
                    label={t(`quality.${activeQuality}`)}
                    active={activeQuality !== "auto"}
                    accessibilityLabel={t("viewer.quality")}
                    onPress={() => setQuality(QUALITIES[(QUALITIES.indexOf(activeQuality) + 1) % QUALITIES.length]!)}
                  />
                ) : null}
                {info.hasVideo ? <IconButton theme={theme} icon="Frame" size="sm" active={guides} label={t("viewer.guides")} onPress={toggleGuides} /> : null}
                {info.hasVideo ? <IconButton theme={theme} icon="Maximize" size="sm" label={t("viewer.fullscreen")} onPress={() => toggleFullscreen(surfaceRef.current)} /> : null}
              </>
            ) : null}
          </View>
        ) : null}
        {inline ? (
          <>
            <IconButton theme={theme} icon="MessageSquarePlus" size="sm" active={showNote} label={t("viewer.note")} onPress={() => setShowNote((value) => !value)} />
            {isWeb ? <IconButton theme={theme} icon="Download" size="sm" label={t("viewer.download")} onPress={download} /> : null}
            {onOpenInPanel ? <IconButton theme={theme} icon="PanelRightOpen" size="sm" label={t("viewer.openInPanel")} onPress={() => onOpenInPanel(info.path)} /> : null}
          </>
        ) : null}
      </View>

      {showNote && !wide ? (
        <ReviewBox theme={theme} compact={inline} target={reviewTarget} workspaceId={workspaceId} workspaceRoot={workspaceRoot} agentId={agentId} />
      ) : null}
      {!inline && !fill ? (
        <View style={{ gap: 6 }}>
          <SectionTitle
            theme={theme}
            label={t("notes.title")}
            count={notes.data?.length ?? 0}
            action={
              notes.data?.length ? (
                <IconButton
                  theme={theme}
                  icon="ClipboardCopy"
                  size="sm"
                  label={t("notes.copyAll")}
                  onPress={() => void copyText(notesAsText(info, notes.data ?? [], t("notes.title"))).then(() => toast.show(t("notes.copiedAll"), { variant: "success", durationMs: 1400 }))}
                />
              ) : null
            }
          />
          <NotesList theme={theme} info={info} notes={notes.data ?? []} onJump={jumpToNote} locale={locale} />
          <View style={{ height: 6 }} />
          <SectionTitle theme={theme} label={t("inspector.details")} />
          <DetailsTable theme={theme} info={info} workspaceRoot={workspaceRoot} />
        </View>
      ) : null}
      </View>
      {wide ? (
        <View style={{ width: 340, minHeight: 0, gap: 14, borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: 20 }}>
          <SectionTitle theme={theme} label={t("inspector.note")} />
          <ReviewBox theme={theme} stacked target={reviewTarget} workspaceId={workspaceId} workspaceRoot={workspaceRoot} agentId={agentId} />
          <SectionTitle
            theme={theme}
            label={t("notes.title")}
            count={notes.data?.length ?? 0}
            action={
              notes.data?.length ? (
                <IconButton
                  theme={theme}
                  icon="ClipboardCopy"
                  size="sm"
                  label={t("notes.copyAll")}
                  onPress={() => void copyText(notesAsText(info, notes.data ?? [], t("notes.title"))).then(() => toast.show(t("notes.copiedAll"), { variant: "success", durationMs: 1400 }))}
                />
              ) : null
            }
          />
          <ScrollView style={{ flex: 1, marginHorizontal: -10 }} contentContainerStyle={{ paddingBottom: 8 }}>
            <NotesList theme={theme} info={info} notes={notes.data ?? []} onJump={jumpToNote} locale={locale} />
          </ScrollView>
          <SectionTitle theme={theme} label={t("inspector.details")} />
          <DetailsTable theme={theme} info={info} workspaceRoot={workspaceRoot} />
        </View>
      ) : null}
      <ShortcutsSheet theme={theme} open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </View>
  );
}

function ImageViewer({ theme, compact, info, workspaceId, workspaceRoot, agentId, variant, onOpenInPanel, fill, compare }: ViewerProps & { info: MediaInfo }) {
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const { t } = useTranslation(messages);
  const toast = useToast();
  const load = useRpc(imageRpc);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const inline = variant === "inline";

  useEffect(() => {
    let active = true;
    setUri(null);
    setFailed(null);
    load({ path: info.path, maxSize: 2560 })
      .then((result) => {
        if (active) setUri(`data:${result.mimeType};base64,${result.base64}`);
        return undefined;
      })
      .catch((reason: unknown) => {
        if (active) setFailed(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [info.path, info.modifiedAt, load]);

  const aspect = info.width && info.height ? info.width / info.height : 4 / 3;
  const maxHeight = inline ? (compact ? 220 : 300) : compact ? 320 : 560;
  const { colors } = theme;
  const download = () => {
    void downloadFile(info.path, info.size).catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : String(reason)));
  };
  const actions = (
    <>
      {compare && !inline ? <IconButton theme={theme} icon="ArrowLeftRight" label={t("viewer.compare", { name: compare.name })} onPress={() => compare.onSelect(compare.path)} /> : null}
      {!inline && info.width ? (
        <IconButton theme={theme} icon={actualSize ? "Minimize2" : "Maximize2"} label={t("viewer.actualSize")} active={actualSize} onPress={() => setActualSize((value) => !value)} />
      ) : null}
      {!inline ? (
        <IconButton
          theme={theme}
          icon="Copy"
          label={t("viewer.copyPath")}
          onPress={() => void copyText(info.path).then(() => toast.show(t("viewer.copiedPath"), { variant: "success", durationMs: 1200 }))}
        />
      ) : null}
      {isWeb ? <IconButton theme={theme} icon="Download" label={t("viewer.download")} onPress={download} size={inline ? "sm" : "md"} /> : null}
      {onOpenInPanel ? <IconButton theme={theme} icon="PanelRightOpen" size="sm" label={t("viewer.openInPanel")} onPress={() => onOpenInPanel(info.path)} /> : null}
    </>
  );

  return (
    <View style={fill ? { flex: 1, gap: 12, minHeight: 0 } : { gap: inline ? 8 : 12 }}>
      {!inline ? <MediaHeader theme={theme} info={info} workspaceRoot={workspaceRoot} mode={null} actions={actions} /> : null}
      {failed ? (
        <Message theme={theme} tone="danger" icon="TriangleAlert" text={failed} />
      ) : !uri ? (
        <Message theme={theme} loading text={t("viewer.loading")} />
      ) : actualSize && info.width && info.height ? (
        <ScrollView horizontal style={{ maxHeight, borderRadius: 10, backgroundColor: colors.surface1 }}>
          <ScrollView style={{ maxHeight }}>
            <Image source={{ uri }} style={{ width: info.width, height: info.height }} />
          </ScrollView>
        </ScrollView>
      ) : fill ? (
        <View
          style={{ flex: 1, minHeight: 200, alignItems: "center", justifyContent: "center" }}
          onLayout={(event) => setStage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
        >
          {stage ? (
            <Pressable onPress={() => setActualSize(true)} accessibilityLabel={t("viewer.actualSize")}>
              <Image source={{ uri }} resizeMode="contain" style={[fitBox(stage, aspect), { borderRadius: 10, backgroundColor: colors.surface1 }]} />
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Pressable onPress={() => !inline && setActualSize(true)} accessibilityLabel={t("viewer.actualSize")}>
          <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", aspectRatio: aspect, maxHeight, borderRadius: inline ? 8 : 10, backgroundColor: colors.surface1 }} />
        </Pressable>
      )}
      {inline ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1, fontVariant: ["tabular-nums"] }}>
            {metaChips(info, null).join("  ·  ")}
          </Text>
          {actions}
        </View>
      ) : null}
      {!inline ? <ReviewBox theme={theme} target={{ info, time: 0, inPoint: null, outPoint: null }} workspaceId={workspaceId} workspaceRoot={workspaceRoot} agentId={agentId} /> : null}
    </View>
  );
}
