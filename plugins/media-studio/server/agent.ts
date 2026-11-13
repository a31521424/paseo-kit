import { randomUUID } from "node:crypto";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { CARD_KIND, CARD_MAX_FILES, CARD_VERSION, PREVIEW_TOOL_NAME, type CardData } from "../shared/cards";
import { formatBytes, formatDuration, formatFps } from "../shared/media";
import type { MediaInfo } from "../shared/rpc";
import { parseProviders, type MediaStudioSettings } from "../shared/settings";
import { scanMedia } from "./files";
import { allowedRemoteHosts, locate } from "./hosts";
import { probe } from "./probe";

type Paseo = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1]["paseo"];

/** What an agent showed with the tool during its current turn. */
interface Shown {
  paths: string[];
  calls: { title: string | null; note: string | null }[];
}

const shownThisTurn = new Map<string, Shown>();

function describe(info: MediaInfo): string {
  const parts: string[] = [info.kind];
  if (info.duration) parts.push(formatDuration(info.duration));
  if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
  if (info.fps) parts.push(formatFps(info.fps));
  const codecs = [info.videoCodec, info.audioCodec].filter(Boolean).join("/");
  if (codecs) parts.push(codecs);
  parts.push(formatBytes(info.size));
  return parts.join(", ");
}

function previewMediaTool(remoteHosts: string[]) {
  const remote =
    remoteHosts.length > 0
      ? ` Files on an SSH host are written alias:/absolute/path; available aliases: ${remoteHosts.slice(0, 20).join(", ")}. ` +
        "Do not copy remote renders back just to show them."
      : "";
  return defineAgentTool({
    name: PREVIEW_TOOL_NAME,
    title: "Preview media",
    description:
      "Show image, video or audio files to the user inline in this chat, with a player, filmstrip and waveform timeline. " +
      "Call it right after you create or change a media file the user should review (a render, cut, export, extracted frame, " +
      "audio mix or generated image), and when the user asks to see one. The user can scrub, mark in and out points and " +
      "send timecoded notes back to you. Returns each file's duration, resolution, frame rate and codecs." +
      remote,
    input: z.object({
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(CARD_MAX_FILES)
        .describe("Media files to show: absolute, relative to your working directory, or alias:/path on an SSH host"),
      title: z.string().max(120).optional().describe("Short heading for the preview, such as 'Cut v3, trimmed intro'"),
      note: z.string().max(600).optional().describe("One or two sentences for the user: what changed and what to check"),
    }),
    async execute({ paths, title, note }, { agent }) {
      const lines: string[] = [];
      const items: { path: string; ok: boolean; info?: unknown; error?: string }[] = [];
      let shown = shownThisTurn.get(agent.id);
      if (!shown) shownThisTurn.set(agent.id, (shown = { paths: [], calls: [] }));
      for (const input of paths) {
        let file = input;
        try {
          const location = await locate(input, agent.cwd);
          file = location.ref;
          const { location: _location, videoProfile: _profile, videoLevel: _level, pixelFormat: _pixels, ...info } = await probe(location);
          lines.push(`- ${input}: ${describe(info)}`);
          items.push({ path: file, ok: true, info });
          if (!shown.paths.includes(file)) shown.paths.push(file);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lines.push(`- ${input}: not shown, ${message}`);
          items.push({ path: file, ok: false, error: message });
        }
      }
      const shownCount = items.filter((item) => item.ok).length;
      if (shownCount > 0) shown.calls.push({ title: title?.trim() || null, note: note?.trim() || null });
      return {
        text: shownCount > 0 ? `Shown to the user in the chat:\n${lines.join("\n")}` : `Nothing could be shown:\n${lines.join("\n")}`,
        structuredContent: { items },
        isError: shownCount === 0,
      };
    },
  });
}

interface Snapshot {
  cwd: string;
  startedAt: number;
  files: Map<string, string>;
  ready: Promise<void>;
}

/**
 * Gives agents the preview tool, and after each turn appends one card below the agent's reply with
 * the media the turn showed through the tool plus the media files it created or changed in the
 * agent's folder. Paseo folds a finished turn down to its last reply, which also folds the tool's
 * own card; the card after the reply keeps the turn's media in view.
 */
export function registerAgentFeatures(server: PluginServerContext, settings: () => MediaStudioSettings): void {
  server.addHook("agent.open.before", async ({ request }) => {
    const current = settings();
    if (!current.agentTool || request.purpose === "history") return;
    if (!parseProviders(current.agentToolProviders).includes(request.provider)) return;
    const remoteHosts = await allowedRemoteHosts().catch(() => []);
    return { ...request, tools: [...request.tools, previewMediaTool(remoteHosts)] };
  });

  const snapshots = new Map<string, Snapshot>();

  server.addHook("agent.turn.before", async ({ agent }) => {
    shownThisTurn.delete(agent.id);
    if (!settings().turnCards || !agent.cwd) return;
    const snapshot: Snapshot = { cwd: agent.cwd, startedAt: Date.now(), files: new Map(), ready: Promise.resolve() };
    snapshot.ready = scanMedia(agent.cwd)
      .then(({ files }) => {
        for (const file of files) snapshot.files.set(file.path, `${file.size}:${file.mtimeMs}`);
      })
      .catch(() => undefined);
    snapshots.set(agent.id, snapshot);
  });

  server.addHook("agent.turn.after", async ({ agent, turnId, outcome }, { paseo }) => {
    const snapshot = snapshots.get(agent.id);
    snapshots.delete(agent.id);
    const shown = shownThisTurn.get(agent.id) ?? { paths: [], calls: [] };
    shownThisTurn.delete(agent.id);
    if (!settings().turnCards || outcome.kind === "canceled") return;
    let changed: string[] = [];
    if (snapshot) {
      await snapshot.ready;
      const { files } = await scanMedia(snapshot.cwd).catch(() => ({ files: [] }));
      changed = files
        .filter((file) => {
          if (shown.paths.includes(file.path)) return false;
          if (file.mtimeMs < snapshot.startedAt - 2000) return false;
          return snapshot.files.get(file.path) !== `${file.size}:${file.mtimeMs}`;
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((file) => file.path);
    }
    const paths = [...shown.paths, ...changed];
    if (paths.length === 0) return;
    const single = shown.calls.length === 1 ? shown.calls[0]! : null;
    const data: CardData = {
      source: "turn",
      title: single?.title ?? null,
      note: single?.note ?? null,
      cwd: snapshot?.cwd ?? agent.cwd,
      paths: paths.slice(0, CARD_MAX_FILES),
      more: Math.max(0, paths.length - CARD_MAX_FILES),
      shown: Math.min(shown.paths.length, CARD_MAX_FILES),
      state: "done",
      error: null,
    };
    // Appending with an existing id replaces that row, and some providers report the same turn id
    // for every turn of a session, so each card gets its own id.
    await appendCard(paseo, agent.id, `turn-${turnId ?? "x"}-${randomUUID().slice(0, 8)}`, data).catch((error) =>
      console.error("media-studio: could not add the turn card", error),
    );
  });
}

async function appendCard(paseo: Paseo, agentId: string, id: string, data: CardData): Promise<void> {
  await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind: CARD_KIND, version: CARD_VERSION, data });
}
