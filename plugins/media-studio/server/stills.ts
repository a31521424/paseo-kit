import path from "node:path";
import { BROWSER_IMAGE_EXTENSIONS, extensionOf } from "../shared/media";
import { cacheKey, cachedJson, readCache, writeCache } from "./cache";
import { heavy, lastErrorLine } from "./ffmpeg";
import { ffmpegOn, type Located } from "./hosts";
import { probe, statLocated, type ProbeDetails } from "./probe";

const BROWSER_IMAGES = new Set<string>(BROWSER_IMAGE_EXTENSIONS);
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
/** Originals up to this size go to the viewer untouched; larger ones are scaled down. */
const ORIGINAL_IMAGE_BYTES = 12 * 1024 * 1024;

function versionKey(info: ProbeDetails): string {
  return `${info.path}\u0000${info.size}\u0000${info.modifiedAt}`;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** Keeps a seek inside the file: ffmpeg returns no frame past the last one. */
function clampTime(info: ProbeDetails, time: number): number {
  if (info.kind === "image" || !info.duration) return 0;
  const lastFrame = info.fps ? 1 / info.fps : 0.05;
  return Math.max(0, Math.min(time, info.duration - lastFrame * 1.5));
}

/** One frame at `time`, at most `width` pixels wide, accurate to the frame. JPEG unless `png`. */
async function renderFrame(info: ProbeDetails, time: number, width: number | null, options: { quality?: number; png?: boolean } = {}): Promise<Buffer> {
  const { host, path: file } = info.location;
  const ffmpeg = await ffmpegOn(host);
  const seek = clampTime(info, time);
  const args = ["-v", "error", "-nostdin"];
  if (seek > 0) args.push("-ss", seek.toFixed(3));
  args.push("-i", file, "-map", "0:v:0", "-frames:v", "1");
  if (options.png) {
    if (width) args.push("-vf", `scale='min(${even(width)},iw)':-2`);
    args.push("-f", "image2pipe", "-vcodec", "png", "pipe:1");
  } else {
    args.push(
      "-vf",
      `scale='min(${even(width ?? 640)},iw)':-2:flags=bicubic,format=yuvj420p`,
      "-q:v",
      String(options.quality ?? 4),
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    );
  }
  const limits = { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 };
  let result = await heavy(() => host.run(ffmpeg, args, limits));
  if (result.stdout.length === 0 && seek > 0) {
    // Some files report a duration past their last decodable frame; take the last one there is.
    const retry = args.slice();
    retry.splice(retry.indexOf("-ss"), 2, "-sseof", "-1");
    result = await heavy(() => host.run(ffmpeg, retry, limits));
  }
  if (result.stdout.length === 0) throw new Error(lastErrorLine(result.stderr));
  return result.stdout;
}

export async function frame(location: Located, time: number, width: number): Promise<{ base64: string; mimeType: string }> {
  const info = await probe(location);
  if (!info.hasVideo) throw new Error(`${info.name} has no picture`);
  const seek = clampTime(info, time);
  const key = cacheKey("frame", versionKey(info), seek.toFixed(3), width);
  const cached = await readCache(key, "jpg");
  const data = cached ?? (await renderFrame(info, seek, width));
  if (!cached) await writeCache(key, "jpg", data);
  return { base64: data.toString("base64"), mimeType: "image/jpeg" };
}

/** A full-size PNG of the frame at `time`, for saving next to the workspace. */
export async function framePng(location: Located, time: number): Promise<Buffer> {
  const info = await probe(location);
  if (!info.hasVideo) throw new Error(`${info.name} has no picture`);
  return renderFrame(info, time, null, { png: true });
}

/** A representative frame: a second in, or a tenth of the way through a short clip. */
export async function poster(location: Located, width: number): Promise<{ base64: string; mimeType: string } | null> {
  const info = await probe(location);
  if (!info.hasVideo) return null;
  if (info.kind === "image" && extensionOf(info.path) === "svg") return null;
  const time = info.duration ? Math.min(1, info.duration * 0.1) : 0;
  return frame(location, time, width);
}

export async function filmstrip(location: Located, count: number, width: number): Promise<{ frames: { time: number; base64: string }[] }> {
  const info = await probe(location);
  if (!info.hasVideo || !info.duration) return { frames: [] };
  const duration = info.duration;
  return cachedJson(cacheKey("strip", versionKey(info), count, width), async () => {
    const times = Array.from({ length: count }, (_, index) => ((index + 0.5) * duration) / count);
    const frames = await Promise.all(
      times.map(async (time) => {
        const data = await renderFrame(info, time, width, { quality: 6 }).catch(() => null);
        return data ? { time, base64: data.toString("base64") } : null;
      }),
    );
    return { frames: frames.filter((entry): entry is { time: number; base64: string } => entry !== null) };
  });
}

/**
 * Loudness peaks across the file, 0 to 100 per bucket. ffmpeg decodes the first audio stream as
 * mono at a low rate (8 kHz here, 2 kHz from a remote host to keep SSH traffic small); the peak of
 * every 10 ms is kept, then folded into `buckets`.
 */
export async function waveform(location: Located, buckets: number): Promise<{ peaks: number[] }> {
  const info = await probe(location);
  if (!info.hasAudio) return { peaks: [] };
  const { host, path: file } = location;
  const ffmpeg = await ffmpegOn(host);
  const rate = host.remote ? 2000 : 8000;
  const block = rate / 100;
  return cachedJson(cacheKey("wave", versionKey(info), buckets), () =>
    heavy(
      () =>
        host.spawn(ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(rate), "-f", "s16le", "pipe:1"]).then(
          (child) => new Promise<{ peaks: number[] }>((resolve, reject) => {
          const blocks: number[] = [];
          let blockPeak = 0;
          let inBlock = 0;
          let carry: Buffer | null = null;
          let stderr = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
          child.stdout.on("data", (chunk: Buffer) => {
            const data = carry ? Buffer.concat([carry, chunk]) : chunk;
            const usable = data.length - (data.length % 2);
            carry = usable < data.length ? data.subarray(usable) : null;
            for (let offset = 0; offset < usable; offset += 2) {
              const sample = Math.abs(data.readInt16LE(offset));
              if (sample > blockPeak) blockPeak = sample;
              inBlock += 1;
              if (inBlock === block) {
                blocks.push(blockPeak);
                blockPeak = 0;
                inBlock = 0;
              }
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4000);
          });
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (inBlock > 0) blocks.push(blockPeak);
            if (blocks.length === 0) {
              reject(new Error(code === 0 ? "No audio samples" : lastErrorLine(stderr)));
              return;
            }
            const peaks: number[] = [];
            for (let bucket = 0; bucket < buckets; bucket += 1) {
              const from = Math.floor((bucket * blocks.length) / buckets);
              const to = Math.max(from + 1, Math.floor(((bucket + 1) * blocks.length) / buckets));
              let peak = 0;
              for (let index = from; index < to && index < blocks.length; index += 1) peak = Math.max(peak, blocks[index]!);
              // A square root lifts quiet passages so speech stays visible next to music.
              peaks.push(Math.round(Math.sqrt(peak / 32768) * 100));
            }
            resolve({ peaks });
          });
        })),
    ),
  );
}

/** The image for the viewer: the original bytes for formats a browser shows, else a JPEG. */
export async function image(location: Located, maxSize: number): Promise<{ base64: string; mimeType: string; converted: boolean }> {
  const ext = extensionOf(location.path);
  const stats = await statLocated(location);
  if (BROWSER_IMAGES.has(ext) && stats.size <= ORIGINAL_IMAGE_BYTES) {
    const data = await location.host.readRange(location.path, 0, stats.size);
    return { base64: data.toString("base64"), mimeType: IMAGE_MIME[ext] ?? "application/octet-stream", converted: false };
  }
  if (ext === "svg") throw new Error(`${path.basename(location.path)} is too large to preview`);
  const result = await frame(location, 0, maxSize);
  return { ...result, converted: true };
}
