import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, usePaseo, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatTimecode, formatTimecodeShort, relativeTo } from "../shared/media";
import { grabRpc, notesAddRpc, type MediaInfo } from "../shared/rpc";
import { messages } from "./i18n";
import { Chip, IconButton, NO_OUTLINE } from "./ui";
import { isMac, isWeb } from "./web";

const PARENT_LABEL = "paseo.parent-agent-id";

interface AgentOption {
  id: string;
  title: string;
  status: string;
}

/** The workspace's agents, top-level ones first, most recently active first. */
function useWorkspaceAgents(workspaceId: string | null) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["media-studio", "agents", workspaceId],
    enabled: !!workspaceId,
    refetchInterval: 8000,
    queryFn: async (): Promise<AgentOption[]> => {
      const result = await paseo.agents.list({ page: { limit: 200 } });
      return result.entries
        .map((entry) => entry.agent)
        .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
        // Top-level agents first, then subagents; each group most recently active first.
        .sort((a, b) => {
          const sub = Number(!!a.labels?.[PARENT_LABEL]) - Number(!!b.labels?.[PARENT_LABEL]);
          return sub || Date.parse(b.lastUserMessageAt ?? b.updatedAt) - Date.parse(a.lastUserMessageAt ?? a.updatedAt);
        })
        .map((agent) => ({ id: agent.id, title: agent.title || agent.provider, status: agent.status }));
    },
  });
}

export interface ReviewTarget {
  info: MediaInfo;
  time: number;
  inPoint: number | null;
  outPoint: number | null;
}

/** The text an agent receives: file, timecodes in both forms, and the note. */
export function composeNote(target: ReviewTarget, note: string, workspaceRoot: string | null, framePath: string | null): string {
  const { info, time, inPoint, outPoint } = target;
  const fps = info.fps;
  const seconds = (value: number) => `${value.toFixed(3)} s`;
  const lines = [`[Media review] ${relativeTo(workspaceRoot, info.path)}`];
  if (info.kind !== "image") lines.push(`At: ${formatTimecode(time, fps)} (${seconds(time)})`);
  if (inPoint !== null || outPoint !== null) {
    const from = inPoint ?? 0;
    const to = outPoint ?? info.duration ?? from;
    lines.push(`Range: ${formatTimecode(from, fps)} - ${formatTimecode(to, fps)} (${seconds(from)} - ${seconds(to)}, ${seconds(Math.max(0, to - from))})`);
  }
  if (fps) lines.push(`Frame rate: ${fps} fps`);
  if (framePath) lines.push(`Frame: ${relativeTo(workspaceRoot, framePath)} (attached)`);
  lines.push("", note.trim());
  return lines.join("\n");
}

/**
 * A note for an agent about the current moment: timecode, optional in and out range, and the frame
 * attached as an image (also saved as a PNG in the workspace so the agent can open it again).
 */
export function ReviewBox({
  theme,
  target,
  workspaceId,
  workspaceRoot,
  agentId,
  compact,
  stacked,
}: {
  theme: PluginTheme;
  target: ReviewTarget;
  workspaceId: string | null;
  workspaceRoot: string | null;
  /** Fixed target, as in a chat card. Null: pick from the workspace's agents. */
  agentId: string | null;
  compact?: boolean;
  /** Narrow column: the send row goes under the chips. */
  stacked?: boolean;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const paseo = usePaseo();
  const grab = useRpc(grabRpc);
  const addNote = useRpc(notesAddRpc);
  const queryClient = useQueryClient();
  const agents = useWorkspaceAgents(agentId ? null : workspaceId);
  const fixedStatus = useAgent(agentId ?? "", (agent) => agent.status);
  const fixedTitle = useAgent(agentId ?? "", (agent) => agent.title);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [attachFrame, setAttachFrame] = useState(target.info.hasVideo);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const sendingRef = useRef(false);
  const { colors } = theme;

  const options = agents.data ?? [];
  useEffect(() => {
    if (!agentId && !picked && options[0]) setPicked(options[0].id);
  }, [agentId, picked, options]);

  const targetId = agentId ?? picked;
  const option = options.find((entry) => entry.id === targetId);
  const status = agentId ? fixedStatus : (option?.status ?? null);
  const title = agentId ? (fixedTitle ?? t("review.thisAgent")) : (option?.title ?? "");
  const busy = status === "running" || status === "initializing";
  // A working agent gets the note too: it joins the current turn ("steer") instead of stopping it,
  // so an editor can keep reviewing while the agent renders.
  const canSend = !!targetId && note.trim().length > 0 && !sending && !!workspaceRoot;

  async function send() {
    if (!canSend || !targetId || !workspaceRoot || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      let images: { data: string; mimeType: string }[] | undefined;
      let framePath: string | null = null;
      if (attachFrame && target.info.hasVideo) {
        const frame = await grab({ path: target.info.path, time: target.info.kind === "image" ? 0 : target.time, root: workspaceRoot });
        framePath = frame.path;
        images = [{ data: frame.base64, mimeType: frame.mimeType }];
      }
      const steering = busy;
      await paseo.agents.ref(targetId).send(composeNote(target, note, workspaceRoot, framePath), {
        ...(images ? { images } : {}),
        ...(steering ? { activeTurnBehavior: "steer" as const } : {}),
      });
      const ranged = target.inPoint !== null || target.outPoint !== null;
      await addNote({
        path: target.info.path,
        note: {
          fileModifiedAt: target.info.modifiedAt,
          time: target.time,
          inPoint: ranged ? (target.inPoint ?? 0) : null,
          outPoint: ranged ? (target.outPoint ?? target.info.duration ?? target.time) : null,
          text: note.trim(),
          agentTitle: title || null,
          framePath,
        },
      }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ["media-studio", "notes", target.info.path] });
      setNote("");
      toast.show(steering ? t("review.steered", { name: title }) : t("review.sent", { name: title }), { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const fps = target.info.fps;
  const short = (value: number) => formatTimecodeShort(value, fps, target.info.duration);
  const ranged = target.inPoint !== null || target.outPoint !== null;
  const from = target.inPoint ?? 0;
  const to = target.outPoint ?? target.info.duration ?? 0;
  const where =
    target.info.kind === "image"
      ? null
      : ranged
        ? `${short(from)} → ${short(to)} · ${short(Math.max(0, to - from))}`
        : short(target.time);
  const hint = !targetId ? t("review.noAgent") : busy ? t("review.busy") : null;

  return (
    <View

      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        backgroundColor: colors.surface1,
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: 6,
        gap: 4,
      }}
    >
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder={target.info.kind === "image" ? t("review.placeholderImage") : t("review.placeholder")}
        placeholderTextColor={colors.foregroundMuted}
        multiline
        {...({
          onKeyPress: (event: { nativeEvent: { key?: string; metaKey?: boolean; ctrlKey?: boolean }; preventDefault?: () => void }) => {
            const { key, metaKey, ctrlKey } = event.nativeEvent;
            if (key === "Enter" && (metaKey || ctrlKey)) {
              event.preventDefault?.();
              void send();
            }
          },
        } as object)}

        style={[{ minHeight: compact ? 22 : 40, maxHeight: 160, color: colors.foreground, fontSize: 13, paddingVertical: 2 }, NO_OUTLINE]}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
        {where ? <Chip theme={theme} icon={ranged ? "SquareSplitHorizontal" : "Clock"} label={where} mono /> : null}
        {target.info.hasVideo ? (
          <Chip
            theme={theme}
            icon={attachFrame ? "ImagePlus" : "ImageOff"}
            label={target.info.kind === "image" ? t("review.attachImage") : t("review.attachFrame")}
            active={attachFrame}
            onPress={() => setAttachFrame((value) => !value)}
          />
        ) : null}
        {targetId ? (
          <Chip
            theme={theme}
            icon="Bot"
            label={title}
            trailingIcon={!agentId && options.length > 1 ? "ChevronDown" : undefined}
            onPress={!agentId && options.length > 1 ? () => setPicking(true) : undefined}
            accessibilityLabel={t("review.chooseAgent")}
          />
        ) : null}
        {stacked ? null : <View style={{ flex: 1 }} />}
        {stacked ? (
          <View style={{ flexBasis: "100%", height: 0 }} />
        ) : null}
        {stacked ? <View style={{ flex: 1 }} /> : null}
        {hint ? (
          <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 11, flexShrink: 1, marginRight: 6 }}>
            {hint}
          </Text>
        ) : isWeb && !compact ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginRight: 6 }}>{t("review.sendHint", { key: isMac ? "⌘" : "Ctrl" })}</Text>
        ) : null}
        {sending ? (
          <View style={{ width: 30, height: 30, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : (
          <IconButton theme={theme} icon="ArrowUp" label={t("review.send")} primary size="md" disabled={!canSend} onPress={() => void send()} />
        )}
      </View>
      <Modal title={t("review.chooseAgent")} open={picking} onOpenChange={setPicking}>
        <Modal.Content>
          {options.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              onPress={() => {
                setPicked(entry.id);
                setPicking(false);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 8,
                backgroundColor: entry.id === targetId || pressed ? colors.surface2 : "transparent",
              })}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: entry.status === "running" ? colors.statusWarning : entry.status === "error" ? colors.statusDanger : colors.statusSuccess,
                }}
              />
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, flex: 1 }}>
                {entry.title}
              </Text>
              {entry.id === targetId ? <Icon name="Check" size={15} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </Modal.Content>
      </Modal>
    </View>
  );
}
