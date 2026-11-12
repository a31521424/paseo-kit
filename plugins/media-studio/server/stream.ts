import { randomUUID } from "node:crypto";
import { STREAM_READ_BYTES, type Quality } from "../shared/rpc";
import { lastErrorLine } from "./ffmpeg";
import { ffmpegOn, type Child, type Located, type MediaHost } from "./hosts";
import { probe, type ProbeDetails } from "./probe";

// Playback works like a small transcoding server. Each session is one ffmpeg process that writes
// fragmented MP4 from a start time to stdout; the app appends those bytes to a MediaSource. A seek
// outside what the app has buffered opens a new session at that time. ffmpeg stops reading the
// source while the app does not ask for more, because its stdout pipe fills up.
//
// Fragmented MP4 from ffmpeg always starts each track at time zero, so the session reports the
// media time of its first sample and the app sets it as the SourceBuffer timestampOffset:
// - transcode and audio sessions seek accurately, so they start exactly at the requested time;
// - copy sessions can only start at a keyframe, so the daemon first asks ffmpeg where the keyframe
//   at or before the requested time is, then starts both tracks there, keeping audio in sync.

const FRAG_FLAGS = "frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets";
const HIGH_WATER = 16 * 1024 * 1024;
const LOW_WATER = 4 * 1024 * 1024;
const LONG_POLL_MS = 2500;
const BATCH_BYTES = 1024 * 1024;
const BATCH_LINGER_MS = 150;
const FIRST_BATCH_BYTES = 128 * 1024;
const IDLE_MS = 60_000;
const MAX_SESSIONS = 6;
/** Above this bitrate "auto" converts instead of sending the original over a remote connection. */
const AUTO_COPY_MAX_BITRATE = 20_000_000;

interface Session {
  id: string;
  child: Child;
  chunks: Buffer[];
  queued: number;
  done: boolean;
  exitError: string | null;
  stderr: string;
  paused: boolean;
  lastUsed: number;
  waiters: (() => void)[];
  /** Whether a read has returned media yet. */
  started: boolean;
}

export interface OpenRequest {
  location: Located;
  start: number;
  quality: Quality;
  h264: boolean;
  /** Use VideoToolbox or NVENC when the host has a working one. */
  hardware: boolean;
}

export interface OpenResult {
  sessionId: string;
  start: number;
  mimeType: string;
  mode: "copy" | "bridge" | "transcode" | "audio";
  width: number | null;
  height: number | null;
  encoder: string | null;
}

const COPYABLE_PROFILES = new Set(["baseline", "constrained baseline", "main", "high"]);
const COPYABLE_PIXELS = new Set(["yuv420p", "yuvj420p"]);

function canCopy(info: ProbeDetails, quality: Quality, h264: boolean): boolean {
  if (!h264 || info.videoCodec !== "h264") return false;
  if (info.pixelFormat && !COPYABLE_PIXELS.has(info.pixelFormat)) return false;
  if (info.videoProfile && !COPYABLE_PROFILES.has(info.videoProfile.toLowerCase())) return false;
  if (quality === "original") return true;
  if (quality !== "auto") return false;
  return (info.height ?? 0) <= 2160 && (info.bitRate ?? 0) <= AUTO_COPY_MAX_BITRATE;
}

/** RFC 6381 codec string for an H.264 stream copied as it is. */
function avcCodec(info: ProbeDetails): string {
  const profile = (info.videoProfile ?? "high").toLowerCase();
  const head = profile.includes("baseline") ? "42E0" : profile === "main" ? "4D40" : "6400";
  const level = info.videoLevel && info.videoLevel > 0 ? info.videoLevel : (info.height ?? 0) > 1080 ? 51 : 40;
  return `avc1.${head}${level.toString(16).padStart(2, "0").toUpperCase()}`;
}

function targetHeight(info: ProbeDetails, quality: Quality): number {
  const wanted = quality === "1080" ? 1080 : quality === "480" ? 480 : 720;
  const short = Math.min(info.width ?? wanted, info.height ?? wanted);
  return Math.min(wanted, short || wanted);
}

/** Keyframe times per file version, built once in the background by decoding only keyframes. */
const keyframeIndexes = new Map<string, Promise<number[] | null>>();
const INDEX_LIMIT = 64;

function keyframeIndex(host: MediaHost, ffmpeg: string, info: ProbeDetails): Promise<number[] | null> {
  const key = `${info.path}\u0000${info.size}\u0000${info.modifiedAt}`;
  let entry = keyframeIndexes.get(key);
  if (!entry) {
    entry = new Promise<number[] | null>((resolve) => {
      void host
        .spawn(ffmpeg, ["-hide_banner", "-nostdin", "-skip_frame", "nokey", "-i", info.location.path, "-map", "0:v:0", "-an", "-vf", "showinfo", "-f", "null", "-"])
        .then((child) => {
          const times: number[] = [];
          let carry = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
          child.stdout.resume();
          child.stderr.on("data", (chunk: Buffer) => {
            const text = carry + chunk.toString();
            const lines = text.split("\n");
            carry = lines.pop() ?? "";
            for (const line of lines) {
              const match = /pts_time:\s*(-?[\d.]+)/.exec(line);
              if (match) times.push(Number(match[1]));
            }
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            // Only trust an index that starts at the file start; other timelines are left to ffmpeg.
            resolve(code === 0 && times.length > 0 && Math.abs(times[0]!) < 0.5 ? times.sort((a, b) => a - b) : null);
          });
          child.on("error", () => resolve(null));
          return undefined;
        })
        .catch(() => resolve(null));
    });
    keyframeIndexes.set(key, entry);
    if (keyframeIndexes.size > INDEX_LIMIT) keyframeIndexes.delete(keyframeIndexes.keys().next().value!);
  }
  return entry;
}

/** The index if it is ready now; otherwise starts building it and returns null. */
async function readyIndex(host: MediaHost, ffmpeg: string, info: ProbeDetails): Promise<number[] | null> {
  const pending = keyframeIndex(host, ffmpeg, info);
  return Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30))]);
}

/** Where ffmpeg lands when asked to start a stream copy at `time`: the keyframe at or before it. */
async function keyframeAtOrBefore(host: MediaHost, ffmpeg: string, file: string, time: number): Promise<number | null> {
  const result = await host.run(
    ffmpeg,
    ["-v", "error", "-nostdin", "-ss", time.toFixed(3), "-i", file, "-map", "0:v:0", "-c", "copy", "-copyts", "-start_at_zero", "-frames:v", "1", "-f", "framemd5", "pipe:1"],
    { timeoutMs: 20_000, maxBytes: 1024 * 1024 },
  );
  const text = result.stdout.toString();
  const base = /#tb 0: (\d+)\/(\d+)/.exec(text);
  const line = text.split("\n").find((entry) => entry && !entry.startsWith("#"));
  if (!base || !line) return null;
  const fields = line.split(",").map((field) => field.trim());
  const pts = Number(fields[2] !== "N/A" ? fields[2] : fields[1]);
  if (!Number.isFinite(pts)) return null;
  return (pts * Number(base[1])) / Number(base[2]);
}

const HARDWARE_ENCODERS = ["h264_videotoolbox", "h264_nvenc"] as const;
const workingEncoders = new Map<string, Promise<string | null>>();

/**
 * The hardware H.264 encoder that actually works on `host`, or null. ffmpeg lists NVENC even
 * without a GPU, so each candidate encodes a few black frames once before it is trusted.
 */
function hardwareEncoder(host: MediaHost, ffmpeg: string, listed: string[]): Promise<string | null> {
  const key = `${host.id}\u0000${ffmpeg}`;
  let entry = workingEncoders.get(key);
  if (!entry) {
    entry = (async () => {
      for (const encoder of HARDWARE_ENCODERS) {
        if (!listed.includes(encoder)) continue;
        const test = await host
          .run(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.2", "-c:v", encoder, "-bf", "0", "-f", "null", "-"], {
            timeoutMs: 20_000,
          })
          .catch(() => null);
        if (test?.code === 0) return encoder;
      }
      return null;
    })();
    workingEncoders.set(key, entry);
  }
  return entry;
}

/** A seek further than this past the keyframe gets a bridge instead of fetching from the keyframe. */
const BRIDGE_MIN_GAP = 0.6;
/** A bridge shorter than this costs more to start than it saves; the copy from the keyframe is used. */
const BRIDGE_MIN_LENGTH = 0.25;

/** Near-lossless settings for a bridge: same resolution, keyframes every half second, fast start. */
function bridgeEncoderArgs(encoder: string, info: ProbeDetails, uhd: boolean): string[] {
  const gop = String(Math.max(6, Math.round((info.fps ?? 24) / 2)));
  const megabits = Math.max(12, Math.round(((info.bitRate ?? 8_000_000) * 2.5) / 1_000_000));
  if (encoder === "h264_videotoolbox") return ["-c:v", encoder, "-b:v", `${megabits}M`, "-profile:v", "high", "-bf", "0", "-g", gop, "-realtime", "1", "-allow_sw", "1"];
  if (encoder === "h264_nvenc") return ["-c:v", encoder, "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", "17", "-b:v", `${megabits}M`, "-profile:v", "high", "-bf", "0", "-g", gop];
  return ["-c:v", "libx264", "-preset", uhd ? "ultrafast" : "veryfast", "-tune", "zerolatency", "-crf", "16", "-profile:v", "high", "-bf", "0", "-g", gop];
}

function encoderArgs(encoder: string, megabits: number, gop: string): string[] {
  const rate = [`-b:v`, `${megabits}M`, "-maxrate", `${megabits}M`, "-bufsize", `${megabits * 2}M`];
  const common = ["-profile:v", "high", "-bf", "0", "-g", gop];
  if (encoder === "h264_videotoolbox") return ["-c:v", encoder, ...rate, ...common, "-realtime", "1", "-allow_sw", "1"];
  if (encoder === "h264_nvenc") return ["-c:v", encoder, "-preset", "p3", "-tune", "ll", "-rc", "vbr", ...rate, ...common, "-no-scenecut", "1"];
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    `${megabits}M`,
    "-bufsize",
    `${megabits * 2}M`,
    ...common,
    "-level:v",
    "4.2",
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
  ];
}

export function createStreamer() {
  const sessions = new Map<string, Session>();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastUsed > IDLE_MS) close(session.id);
    }
  }, 10_000);
  sweeper.unref();

  function wake(session: Session): void {
    const waiters = session.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  function close(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.done = true;
    session.chunks = [];
    session.queued = 0;
    session.child.kill("SIGKILL");
    wake(session);
  }

  async function launch(host: MediaHost, ffmpeg: string, args: string[]): Promise<Session> {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      close(oldest.id);
    }
    const child = await host.spawn(ffmpeg, args);
    const session: Session = {
      id: randomUUID(),
      child,
      chunks: [],
      queued: 0,
      done: false,
      exitError: null,
      stderr: "",
      paused: false,
      lastUsed: Date.now(),
      waiters: [],
      started: false,
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!sessions.has(session.id)) return;
      session.chunks.push(chunk);
      session.queued += chunk.length;
      if (session.queued >= HIGH_WATER && !session.paused) {
        session.paused = true;
        child.stdout.pause();
      }
      wake(session);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      session.stderr = (session.stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      session.exitError = error.message;
      session.done = true;
      wake(session);
    });
    child.on("close", (code, signal) => {
      session.done = true;
      if (code !== 0 && signal !== "SIGKILL") session.exitError = lastErrorLine(session.stderr);
      wake(session);
    });
    sessions.set(session.id, session);
    return session;
  }

  async function open(request: OpenRequest): Promise<OpenResult> {
    const { host, path: file } = request.location;
    const ffmpeg = await ffmpegOn(host);
    const info = await probe(request.location);
    if (info.kind === "image") throw new Error(`${info.name} is a still image`);
    const duration = info.duration ?? 0;
    const lastFrame = info.fps ? 1 / info.fps : 0.05;
    let start = duration > 0 ? Math.max(0, Math.min(request.start, duration - lastFrame)) : Math.max(0, request.start);

    const output = ["-movflags", FRAG_FLAGS, "-frag_duration", "1000000", "-f", "mp4", "pipe:1"];
    const audioArgs = (bitrate: string) => ["-c:a", "aac", "-b:a", bitrate, "-ac", "2", "-ar", "48000"];
    const base = ["-v", "error", "-nostdin"];

    if (!info.hasVideo) {
      const args = [...base, ...(start > 0 ? ["-ss", start.toFixed(3)] : []), "-i", file, "-map", "0:a:0", "-vn", "-sn", "-dn", ...audioArgs("192k"), ...output];
      const session = await launch(host, ffmpeg, args);
      return { sessionId: session.id, start, mimeType: 'audio/mp4; codecs="mp4a.40.2"', mode: "audio", width: null, height: null, encoder: null };
    }

    const audioCodec = info.hasAudio ? ", mp4a.40.2" : "";
    const audioMap = info.hasAudio ? ["-map", "0:a:0", ...audioArgs("160k")] : [];
    const { encoders } = await host.tools();
    const hardware = request.hardware ? await hardwareEncoder(host, ffmpeg, encoders) : null;
    const encoder = hardware ?? (encoders.includes("libx264") ? "libx264" : null);

    if (canCopy(info, request.quality, request.h264)) {
      const index = await readyIndex(host, ffmpeg, info);
      let keyframe: number | null = 0;
      let nextKeyframe: number | null = null;
      if (index) {
        // Half a frame of slack: the app asks for the end of what it buffered, snapped down to a
        // frame, which can land one frame before the keyframe a bridge stopped at. Without the
        // slack that keyframe would count as the next one and the follow-up would be a one-frame
        // bridge from the keyframe before, instead of the copy that should take over there.
        const slack = info.fps ? 0.5 / info.fps : 0.02;
        keyframe = [...index].reverse().find((time) => time <= start + slack) ?? 0;
        nextKeyframe = index.find((time) => time > start + slack) ?? null;
      } else if (start > 0) {
        keyframe = await keyframeAtOrBefore(host, ffmpeg, file, start).catch(() => null);
      }

      // Seek bridge: in footage with long GOPs the keyframe can be seconds before the playhead, and
      // the app would have to fetch and decode all of that before showing a frame. Instead the
      // daemon encodes just the stretch from the playhead to the next keyframe at near-lossless
      // quality, starting with a keyframe, so the picture appears at once; the app then opens a
      // copy session at that keyframe and plays the original from there.
      if (keyframe !== null && nextKeyframe !== null && encoder && start - keyframe > BRIDGE_MIN_GAP && nextKeyframe - start >= BRIDGE_MIN_LENGTH) {
        const length = nextKeyframe - start;
        const uhd = (info.height ?? 0) > 1080;
        const args = [
          ...base,
          "-ss",
          start.toFixed(3),
          "-t",
          length.toFixed(3),
          "-i",
          file,
          "-map",
          "0:v:0",
          "-vf",
          "format=yuv420p",
          ...bridgeEncoderArgs(encoder, info, uhd),
          ...audioMap,
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-movflags",
          FRAG_FLAGS,
          "-frag_duration",
          "250000",
          "-f",
          "mp4",
          "pipe:1",
        ];
        const session = await launch(host, ffmpeg, args);
        return {
          sessionId: session.id,
          start,
          mimeType: `video/mp4; codecs="${uhd ? "avc1.640033" : "avc1.64002A"}${audioCodec}"`,
          mode: "bridge",
          width: info.width,
          height: info.height,
          encoder,
        };
      }

      if (keyframe !== null || !encoder) {
        start = keyframe ?? start;
        // A hair past the keyframe, so rounding cannot land on the one before it.
        const seek = start > 0 ? ["-ss", (start + 0.001).toFixed(3)] : [];
        const args = [...base, ...seek, "-i", file, "-map", "0:v:0", "-c:v", "copy", ...audioMap, "-sn", "-dn", "-map_metadata", "-1", ...output];
        const session = await launch(host, ffmpeg, args);
        return {
          sessionId: session.id,
          start,
          mimeType: `video/mp4; codecs="${avcCodec(info)}${audioCodec}"`,
          mode: "copy",
          width: info.width,
          height: info.height,
          encoder: null,
        };
      }
    }

    if (!encoder) {
      throw new Error(`The ffmpeg on ${host.remote ? host.id : "the daemon host"} has no H.264 encoder, so this video cannot be converted for playback.`);
    }
    const height = targetHeight(info, request.quality);
    const megabits = height >= 1080 ? 8 : height >= 720 ? 4 : 2;
    const gop = String(Math.max(12, Math.round((info.fps ?? 30) * 2)));
    // Scales the short side to `height` without upscaling; portrait footage keeps its orientation.
    const scale = `scale='if(gte(iw,ih),-2,min(${height},iw))':'if(gte(iw,ih),min(${height},ih),-2)'`;
    const args = [
      ...base,
      ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
      "-i",
      file,
      "-map",
      "0:v:0",
      "-vf",
      `${scale},format=yuv420p`,
      ...encoderArgs(encoder, megabits, gop),
      ...audioMap,
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      ...output,
    ];
    const session = await launch(host, ffmpeg, args);
    const landscape = (info.width ?? 16) >= (info.height ?? 9);
    const ratio = info.width && info.height ? info.width / info.height : 16 / 9;
    return {
      sessionId: session.id,
      start,
      mimeType: `video/mp4; codecs="avc1.64002A${audioCodec}"`,
      mode: "transcode",
      width: landscape ? Math.round(height * ratio) : height,
      height: landscape ? height : Math.round(height / ratio),
      encoder,
    };
  }

  async function read(id: string): Promise<{ base64: string; done: boolean }> {
    const session = sessions.get(id);
    if (!session) throw new Error("Playback session expired");
    session.lastUsed = Date.now();
    const waitForData = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        session.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    if (session.queued === 0 && !session.done) await waitForData(LONG_POLL_MS);
    // ffmpeg writes in pipe-sized pieces of about 64 KB. Gather a batch before answering, so a
    // remote connection with a 100 ms round trip is not limited to a few hundred KB per second.
    // The first answer only needs the header and the first fragment, so a seek shows its frame as
    // soon as it is encoded instead of waiting out the batch.
    const batch = session.started ? BATCH_BYTES : FIRST_BATCH_BYTES;
    const lingerUntil = Date.now() + BATCH_LINGER_MS;
    while (session.queued > 0 && session.queued < batch && !session.done && Date.now() < lingerUntil) {
      await waitForData(lingerUntil - Date.now());
    }
    const parts: Buffer[] = [];
    let taken = 0;
    while (session.chunks.length > 0 && taken < STREAM_READ_BYTES) {
      const chunk = session.chunks[0]!;
      const room = STREAM_READ_BYTES - taken;
      if (chunk.length <= room) {
        parts.push(chunk);
        taken += chunk.length;
        session.chunks.shift();
      } else {
        parts.push(chunk.subarray(0, room));
        session.chunks[0] = chunk.subarray(room);
        taken += room;
      }
    }
    session.queued -= taken;
    if (taken > 0) session.started = true;
    if (session.paused && session.queued <= LOW_WATER) {
      session.paused = false;
      session.child.stdout.resume();
    }
    const done = session.done && session.queued === 0;
    if (done) {
      const error = session.exitError;
      sessions.delete(id);
      if (error && taken === 0) throw new Error(error);
    }
    return { base64: taken > 0 ? Buffer.concat(parts, taken).toString("base64") : "", done };
  }

  function dispose(): void {
    clearInterval(sweeper);
    for (const id of [...sessions.keys()]) close(id);
  }

  return { open, read, close, dispose };
}
