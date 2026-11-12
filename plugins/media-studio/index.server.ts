import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { formatTimecode } from "./shared/media";
import {
  downloadCloseRpc,
  downloadOpenRpc,
  downloadReadRpc,
  filmstripRpc,
  frameRpc,
  grabRpc,
  hostCheckRpc,
  imageRpc,
  listRpc,
  loudnessRpc,
  notesAddRpc,
  notesListRpc,
  notesRemoveRpc,
  posterRpc,
  probeRpc,
  statRpc,
  statusRpc,
  streamCloseRpc,
  streamOpenRpc,
  streamReadRpc,
  uploadAbortRpc,
  uploadBeginRpc,
  uploadFinishRpc,
  uploadPendingRpc,
  uploadWriteRpc,
  waveformRpc,
} from "./shared/rpc";
import { DEFAULT_SETTINGS, settingsDefinition, type MediaStudioSettings } from "./shared/settings";
import { registerAgentFeatures } from "./server/agent";
import { loudness } from "./server/loudness";
import { addNote, listNotes, removeNote } from "./server/notes";
import { startCacheTrimmer } from "./server/cache";
import { listFolder, listRecent, uniquePath } from "./server/files";
import {
  allowedRemoteHosts,
  closeRemoteHosts,
  configureLocalTools,
  configureRemoteHosts,
  configureRemoteTools,
  localHost,
  locate,
  sshAliases,
} from "./server/hosts";
import { probe } from "./server/probe";
import { filmstrip, frame, framePng, image, poster, waveform } from "./server/stills";
import { createStreamer } from "./server/stream";
import { createTransfers } from "./server/transfer";

// The plugin process validates every daemon message with one generated function of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Once it is hot, V8's Maglev compiler
// optimizes it on a worker thread, taking about 500 MB of native memory per compile, and again after
// each deopt; glibc keeps that memory. Turbofan already skips a function this large, so without
// Maglev it stays in the interpreter. The flag must be set before the function gets hot.
v8.setFlagsFromString("--no-maglev");

/** The daemon keeps its server ID in $PASEO_HOME/server-id unless PASEO_SERVER_ID overrides it. */
async function readServerId(): Promise<string | null> {
  if (process.env.PASEO_SERVER_ID) return process.env.PASEO_SERVER_ID;
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const id = await fs.readFile(path.join(home, "server-id"), "utf8").catch(() => "");
  return id.trim() || null;
}

// Paseo's plugin runtime answers an RPC that finishes after the daemon closed the IPC channel, for
// example an upload piece in flight during a plugin reload; Node then emits ERR_IPC_CHANNEL_CLOSED
// on the process and, with no listener, crashes the already stopping process. Ignore that one.
process.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "ERR_IPC_CHANNEL_CLOSED") console.error("media-studio:", error);
});

export default function contribute(server: PluginServerContext) {
  let current: MediaStudioSettings = DEFAULT_SETTINGS;
  const settings = server.registerSettings(settingsDefinition);
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    current = state.values;
    configureLocalTools({ ffmpeg: current.ffmpegPath, ffprobe: current.ffprobePath });
    configureRemoteHosts(current.remoteHosts);
    configureRemoteTools(current.remoteFfmpeg);
  };
  void settings.read().then(apply, (error) => console.error("media-studio: could not read settings", error));
  const unsubscribe = settings.subscribe(apply);

  const streamer = createStreamer();
  const transfers = createTransfers();
  const stopTrimmer = startCacheTrimmer();

  server.handle(statusRpc, async () => ({
    local: await localHost.tools(),
    home: os.homedir(),
    serverId: await readServerId(),
    remoteHosts: await allowedRemoteHosts().catch(() => []),
    sshAliases: await sshAliases().catch(() => []),
  }));
  server.handle(hostCheckRpc, async ({ host }) => {
    try {
      const location = await locate(`${host}:~`);
      if (!location.host.remote) throw new Error(`${host} is not an allowed SSH host`);
      return { ok: true, error: null, tools: await location.host.tools(), home: location.path };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), tools: null, home: null };
    }
  });

  server.handle(probeRpc, async ({ path: file, cwd }) => {
    const { location: _location, videoProfile: _profile, videoLevel: _level, pixelFormat: _pixels, ...info } = await probe(await locate(file, cwd));
    return info;
  });
  server.handle(statRpc, async ({ path: file, cwd }) => {
    const location = await locate(file, cwd);
    const stats = await location.host.stat(location.path).catch(() => null);
    return stats?.isFile
      ? { path: location.ref, exists: true, size: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() }
      : { path: location.ref, exists: false, size: 0, modifiedAt: "" };
  });
  server.handle(posterRpc, async ({ path: file, cwd, width }) => poster(await locate(file, cwd), width));
  server.handle(frameRpc, async ({ path: file, cwd, time, width }) => frame(await locate(file, cwd), time, width));
  server.handle(filmstripRpc, async ({ path: file, cwd, count, width }) => filmstrip(await locate(file, cwd), count, width));
  server.handle(waveformRpc, async ({ path: file, cwd, buckets }) => waveform(await locate(file, cwd), buckets));
  server.handle(loudnessRpc, async ({ path: file, cwd }) => loudness(await locate(file, cwd)));
  server.handle(imageRpc, async ({ path: file, cwd, maxSize }) => image(await locate(file, cwd), maxSize));

  server.handle(streamOpenRpc, async ({ path: file, cwd, start, quality, h264 }) =>
    streamer.open({ location: await locate(file, cwd), start, quality, h264, hardware: current.hardwareEncoding }),
  );
  server.handle(streamReadRpc, ({ sessionId }) => streamer.read(sessionId));
  server.handle(streamCloseRpc, ({ sessionId }) => {
    streamer.close(sessionId);
    return {};
  });

  server.handle(listRpc, async ({ root, mode, dir, limit }) => {
    const base = await locate(root);
    const folder = dir ? await locate(dir, base.ref) : base;
    const result = mode === "recent" ? await listRecent(folder.host, folder.path, limit) : await listFolder(folder.host, folder.path, limit);
    return { dir: folder.ref, ...result };
  });

  server.handle(grabRpc, async ({ path: file, cwd, time, root }) => {
    // Frames land in the workspace on the daemon host, even from a remote file, so the agent can open them.
    const source = await locate(file, cwd);
    const info = await probe(source);
    const dir = await locate(current.framesFolder || ".media-studio/frames", root);
    await dir.host.mkdirp(dir.path);
    const stem = path.basename(source.path, path.extname(source.path));
    const stamp = formatTimecode(time, info.fps).replace(/:/g, "-");
    const target = await uniquePath(dir.host, dir.path, `${stem}_${stamp}.png`);
    const png = await framePng(source, time);
    await dir.host.createEmpty(target);
    await dir.host.writeAt(target, 0, png);
    // The app attaches a smaller JPEG to the prompt; the PNG stays in the workspace at full size.
    const preview = await frame(source, time, 1280);
    return { path: target, ...preview };
  });

  server.handle(uploadBeginRpc, async ({ dir, name, size, lastModified }) => transfers.begin(await locate(dir), { name, size, lastModified }));
  server.handle(uploadPendingRpc, async ({ root }) => ({ uploads: await transfers.pending(root ? (await locate(root)).ref : null) }));
  server.handle(uploadWriteRpc, (input) => transfers.write(input));
  server.handle(uploadFinishRpc, (input) => transfers.finish(input));
  server.handle(uploadAbortRpc, async ({ uploadId }) => {
    await transfers.abort(uploadId);
    return {};
  });
  server.handle(downloadOpenRpc, async ({ path: file, cwd }) => transfers.openDownload(await locate(file, cwd)));
  server.handle(downloadReadRpc, (input) => transfers.readDownload(input));
  server.handle(downloadCloseRpc, ({ transferId }) => {
    transfers.closeDownload(transferId);
    return {};
  });

  // Notes are keyed by the file's ref as the player names it (absolute path or alias:/path).
  server.handle(notesListRpc, async ({ path: file }) => ({ notes: await listNotes((await locate(file)).ref) }));
  server.handle(notesAddRpc, async ({ path: file, note }) => addNote((await locate(file)).ref, note));
  server.handle(notesRemoveRpc, async ({ path: file, id }) => {
    await removeNote((await locate(file)).ref, id);
    return {};
  });

  registerAgentFeatures(server, () => current);

  return async () => {
    unsubscribe();
    stopTrimmer();
    streamer.dispose();
    await transfers.dispose();
    closeRemoteHosts();
  };
}
