import path from "node:path";
import { mediaKindOf } from "../shared/media";
import type { MediaInfo } from "../shared/rpc";
import { heavy } from "./ffmpeg";
import { ffmpegOn, type Located, type MediaHost } from "./hosts";

/** What the player needs beyond the public info to decide whether video can be sent as it is. */
export interface ProbeDetails extends MediaInfo {
  /** Where the file is, for the renderers and the player. `path` is the app-facing ref. */
  location: Located;
  videoProfile: string | null;
  videoLevel: number | null;
  pixelFormat: string | null;
}

const MAX_ENTRIES = 500;
const memo = new Map<string, Promise<ProbeDetails>>();

// On an SSH host each stat is a round trip of a few network latencies, and a seek asks for one
// through the probe several times (the stream, the still under the playhead). A recent answer is
// used at once and refreshed in the background once it is a few seconds old, so a file rewritten
// in between is seen on the following request without any seek waiting for the network.
const REMOTE_STAT_FRESH_MS = 3000;
const REMOTE_STAT_STALE_MS = 60_000;
type FileStats = Awaited<ReturnType<Located["host"]["stat"]>>;
const remoteStats = new Map<string, { at: number; stats: Promise<FileStats | null>; refreshing: boolean }>();

function fetchRemoteStat(location: Located): Promise<FileStats | null> {
  const stats = location.host.stat(location.path);
  const entry = { at: Date.now(), stats, refreshing: false };
  stats.then(
    () => remoteStats.set(location.ref, entry),
    () => remoteStats.delete(location.ref),
  );
  if (remoteStats.size > 200) remoteStats.delete(remoteStats.keys().next().value!);
  return stats;
}

function statOnce(location: Located): Promise<FileStats | null> {
  if (!location.host.remote) return location.host.stat(location.path);
  const cached = remoteStats.get(location.ref);
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
  if (!cached || age >= REMOTE_STAT_STALE_MS) {
    const stats = fetchRemoteStat(location);
    remoteStats.set(location.ref, { at: Date.now(), stats, refreshing: false });
    return stats;
  }
  if (age >= REMOTE_STAT_FRESH_MS && !cached.refreshing) {
    cached.refreshing = true;
    fetchRemoteStat(location).catch(() => undefined);
  }
  return cached.stats;
}

export async function statLocated(location: Located): Promise<{ size: number; mtimeMs: number; modifiedAt: string }> {
  const stats = await statOnce(location);
  if (!stats) throw new Error(`File not found: ${location.ref}`);
  if (!stats.isFile) throw new Error(`Not a file: ${location.ref}`);
  return { size: stats.size, mtimeMs: stats.mtimeMs, modifiedAt: new Date(stats.mtimeMs).toISOString() };
}

/** Probes a file once per version (location, size, modification time). */
export async function probe(location: Located): Promise<ProbeDetails> {
  const stats = await statLocated(location);
  const key = `${location.ref}\u0000${stats.size}\u0000${stats.mtimeMs}`;
  let entry = memo.get(key);
  if (!entry) {
    entry = heavy(() => probeUncached(location, stats));
    memo.set(key, entry);
    entry.catch(() => memo.delete(key));
    if (memo.size > MAX_ENTRIES) memo.delete(memo.keys().next().value!);
  }
  return entry;
}

interface Stream {
  kind: "video" | "audio";
  codec: string | null;
  profile: string | null;
  level: number | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sampleRate: number | null;
  channels: number | null;
  rotation: number;
}

interface Parsed {
  duration: number | null;
  bitRate: number | null;
  streams: Stream[];
}

async function probeUncached(location: Located, stats: { size: number; modifiedAt: string }): Promise<ProbeDetails> {
  const { host, path: file } = location;
  const { ffprobe } = await host.tools();
  const parsed = ffprobe ? await probeWithFfprobe(host, ffprobe, file) : await probeWithFfmpeg(host, file);
  const video = parsed.streams.find((stream) => stream.kind === "video") ?? null;
  const audio = parsed.streams.find((stream) => stream.kind === "audio") ?? null;
  const byExtension = mediaKindOf(file);
  let kind: MediaInfo["kind"];
  if (byExtension === "image") kind = "image";
  else if (video) kind = byExtension === "audio" && !parsed.duration ? "audio" : "video";
  else if (audio) kind = "audio";
  else throw new Error(`No video or audio found in ${path.basename(file)}`);
  // Players show the picture upright, so report rotated footage with its displayed size.
  const quarterTurn = video ? Math.abs(video.rotation) % 180 === 90 : false;
  const isStill = kind === "image";
  return {
    location,
    path: location.ref,
    name: path.basename(file),
    kind,
    size: stats.size,
    modifiedAt: stats.modifiedAt,
    duration: isStill ? null : parsed.duration,
    width: video ? (quarterTurn ? video.height : video.width) : null,
    height: video ? (quarterTurn ? video.width : video.height) : null,
    fps: isStill || kind === "audio" ? null : (video?.fps ?? null),
    videoCodec: kind === "audio" ? null : (video?.codec ?? null),
    audioCodec: audio?.codec ?? null,
    sampleRate: audio?.sampleRate ?? null,
    channels: audio?.channels ?? null,
    bitRate: parsed.bitRate,
    hasVideo: kind !== "audio" && video !== null,
    hasAudio: audio !== null,
    videoProfile: video?.profile ?? null,
    videoLevel: video?.level ?? null,
    pixelFormat: video?.pixelFormat ?? null,
  };
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [num, den] = value.split("/").map(Number);
  if (!num || !Number.isFinite(num)) return null;
  const rate = den ? num / den : num;
  return rate > 0 && rate < 1000 ? Math.round(rate * 1000) / 1000 : null;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function probeWithFfprobe(host: MediaHost, ffprobe: string, file: string): Promise<Parsed> {
  const result = await host.run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) || `Cannot read ${path.basename(file)}`);
  const json = JSON.parse(result.stdout.toString()) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Record<string, unknown>[];
  };
  const streams: Stream[] = [];
  for (const stream of json.streams ?? []) {
    const type = stream.codec_type;
    const disposition = (stream.disposition ?? {}) as Record<string, number>;
    if (type === "video" && disposition.attached_pic === 1) continue;
    if (type !== "video" && type !== "audio") continue;
    const tags = (stream.tags ?? {}) as Record<string, string>;
    const sideData = (stream.side_data_list ?? []) as { rotation?: number }[];
    const rotation = toNumber(sideData.find((entry) => entry.rotation != null)?.rotation) ?? toNumber(tags.rotate) ?? 0;
    streams.push({
      kind: type,
      codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
      profile: typeof stream.profile === "string" ? stream.profile : null,
      level: toNumber(stream.level),
      pixelFormat: typeof stream.pix_fmt === "string" ? stream.pix_fmt : null,
      width: toNumber(stream.width),
      height: toNumber(stream.height),
      fps: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
      sampleRate: toNumber(stream.sample_rate),
      channels: toNumber(stream.channels),
      rotation,
    });
  }
  return { duration: toNumber(json.format?.duration), bitRate: toNumber(json.format?.bit_rate), streams };
}

/** Splits at top-level commas, keeping `yuv420p(tv, bt709)` together. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** For hosts with ffmpeg but no ffprobe: reads the stream summary `ffmpeg -i` prints. */
async function probeWithFfmpeg(host: MediaHost, file: string): Promise<Parsed> {
  const ffmpeg = await ffmpegOn(host);
  const result = await host.run(ffmpeg, ["-hide_banner", "-nostdin", "-i", file], { timeoutMs: 30_000 });
  const text = result.stderr;
  const durationMatch = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
  const bitrateMatch = /Duration:[^\n]*bitrate: (\d+) kb\/s/.exec(text);
  const streams: Stream[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /Stream #\d+:\d+[^:]*: (Video|Audio): (.*)$/.exec(line);
    if (!match) continue;
    const isVideo = match[1] === "Video";
    if (isVideo && /\(attached pic\)/.test(line)) continue;
    const parts = splitTopLevel(match[2]!);
    const codecPart = parts[0] ?? "";
    const codec = /^(\w+)/.exec(codecPart)?.[1] ?? null;
    const profileMatch = /^\w+ \(([^)/]+)\)/.exec(codecPart);
    let rotation = 0;
    for (let next = index + 1; next < Math.min(lines.length, index + 8); next += 1) {
      if (/Stream #/.test(lines[next]!)) break;
      const rotate = /rotation of (-?[\d.]+) degrees/.exec(lines[next]!);
      if (rotate) rotation = Number(rotate[1]);
    }
    if (isVideo) {
      const size = /(\d{2,5})x(\d{2,5})/.exec(match[2]!);
      const fps = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line);
      const pixel = parts[1] ? /^([a-z0-9_]+)/.exec(parts[1])?.[1] ?? null : null;
      streams.push({
        kind: "video",
        codec,
        profile: profileMatch?.[1]?.trim() ?? null,
        level: null,
        pixelFormat: pixel,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        fps: fps ? Number(fps[1]) : null,
        sampleRate: null,
        channels: null,
        rotation,
      });
    } else {
      const rate = /(\d+) Hz/.exec(line);
      const layout = parts[2] ?? "";
      const channels = /^mono/.test(layout) ? 1 : /^stereo/.test(layout) ? 2 : /^(\d+)\.(\d+)/.test(layout) ? layout.split(/[.(]/).slice(0, 2).map(Number).reduce((a, b) => a + b, 0) : (Number(/(\d+) channels/.exec(layout)?.[1]) || null);
      streams.push({
        kind: "audio",
        codec,
        profile: null,
        level: null,
        pixelFormat: null,
        width: null,
        height: null,
        fps: null,
        sampleRate: rate ? Number(rate[1]) : null,
        channels,
        rotation: 0,
      });
    }
  }
  if (streams.length === 0) {
    const reason = /Invalid data found|No such file|Permission denied/.exec(text)?.[0];
    throw new Error(reason ? `${reason}: ${path.basename(file)}` : `Cannot read ${path.basename(file)}`);
  }
  return { duration, bitRate: bitrateMatch ? Number(bitrateMatch[1]) * 1000 : null, streams };
}
