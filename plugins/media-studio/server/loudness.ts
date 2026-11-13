import { cacheKey, cachedJson } from "./cache";
import { heavy } from "./ffmpeg";
import { ffmpegOn, type Located } from "./hosts";
import { probe } from "./probe";

export interface Loudness {
  /** Integrated loudness, LUFS (EBU R128 / ITU-R BS.1770). */
  integrated: number | null;
  /** Highest true peak, dBTP. */
  truePeak: number | null;
  /** Loudness range, LU. */
  range: number | null;
}

/** Reads the summary ffmpeg's ebur128 filter prints at the end. */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const number = (pattern: RegExp) => {
    const match = pattern.exec(summary);
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  return {
    integrated: number(/Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+)\s*LUFS/),
    range: number(/Loudness range:[\s\S]*?LRA:\s*(-?[\d.]+)\s*LU/),
    truePeak: number(/True peak:[\s\S]*?Peak:\s*(-?[\d.]+|-inf)\s*dBFS/),
  };
}

/** Delivery loudness of the first audio track, measured once per file version. */
export async function loudness(location: Located): Promise<Loudness> {
  const info = await probe(location);
  if (!info.hasAudio) return { integrated: null, truePeak: null, range: null };
  const { host, path: file } = location;
  const ffmpeg = await ffmpegOn(host);
  return cachedJson(cacheKey("loudness", location.ref, info.size, info.modifiedAt), () =>
    heavy(async () => {
      const result = await host.run(
        ffmpeg,
        ["-hide_banner", "-nostdin", "-nostats", "-i", file, "-map", "0:a:0", "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
        { timeoutMs: 10 * 60_000, maxBytes: 1024 * 1024 },
      );
      const measured = parseEbur128(result.stderr);
      if (result.code !== 0 && measured.integrated === null) throw new Error(result.stderr.trim().split("\n").at(-1) ?? "Loudness measurement failed");
      return measured;
    }),
  );
}
