import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { filmstripRpc, frameRpc, posterRpc, probeRpc, statRpc, waveformRpc, type MediaInfo } from "../shared/rpc";

// Query keys carry the file's modification time once it is known, so a file an agent rewrites gets
// fresh probes, frames and waveforms while unchanged files are served from the query cache.

export function useProbe(path: string, cwd: string | null | undefined, version = 0) {
  const probe = useRpc(probeRpc);
  return useQuery({
    queryKey: ["media-studio", "probe", path, cwd ?? null, version],
    queryFn: () => probe({ path, cwd }),
    staleTime: 30_000,
    retry: 1,
  });
}

/** Polls the file's size and modification time; the number changes when the file does. */
export function useFileVersion(path: string, cwd: string | null | undefined, intervalMs: number | null): number {
  const stat = useRpc(statRpc);
  const query = useQuery({
    queryKey: ["media-studio", "stat", path, cwd ?? null],
    queryFn: () => stat({ path, cwd }),
    refetchInterval: intervalMs ?? false,
    enabled: intervalMs !== null,
  });
  const [version, setVersion] = useState(0);
  const last = useRef<string | null>(null);
  const signature = query.data ? `${query.data.size}:${query.data.modifiedAt}` : null;
  useEffect(() => {
    if (!signature) return;
    if (last.current !== null && last.current !== signature) setVersion((value) => value + 1);
    last.current = signature;
  }, [signature]);
  return version;
}

function dataUri(image: { base64: string; mimeType: string } | null | undefined): string | null {
  return image ? `data:${image.mimeType};base64,${image.base64}` : null;
}

export function usePoster(info: MediaInfo | undefined, width: number) {
  const poster = useRpc(posterRpc);
  return useQuery({
    queryKey: ["media-studio", "poster", info?.path, info?.modifiedAt, width],
    queryFn: async () => dataUri(await poster({ path: info!.path, width })),
    enabled: !!info && info.hasVideo,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** A poster for a list entry, before its full probe is wanted. */
export function useEntryPoster(path: string, modifiedAt: string, width: number, enabled: boolean) {
  const poster = useRpc(posterRpc);
  return useQuery({
    queryKey: ["media-studio", "poster", path, modifiedAt, width],
    queryFn: async () => dataUri(await poster({ path, width })),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useFilmstrip(info: MediaInfo | undefined, count: number) {
  const filmstrip = useRpc(filmstripRpc);
  return useQuery({
    queryKey: ["media-studio", "filmstrip", info?.path, info?.modifiedAt, count],
    queryFn: async () => {
      const result = await filmstrip({ path: info!.path, count, width: 160 });
      return result.frames.map((frame) => ({ time: frame.time, uri: `data:image/jpeg;base64,${frame.base64}` }));
    },
    enabled: !!info && info.hasVideo && !!info.duration,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useWaveform(info: MediaInfo | undefined, buckets: number) {
  const waveform = useRpc(waveformRpc);
  return useQuery({
    queryKey: ["media-studio", "waveform", info?.path, info?.modifiedAt, buckets],
    queryFn: async () => (await waveform({ path: info!.path, buckets })).peaks,
    enabled: !!info && info.hasAudio && !!info.duration,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** The frame at `time`, rounded to a tenth of a second so scrubbing reuses requests. */
export function useFrame(info: MediaInfo | undefined, time: number | null, width: number) {
  const frame = useRpc(frameRpc);
  const rounded = time === null ? null : Math.round(time * 10) / 10;
  return useQuery({
    queryKey: ["media-studio", "frame", info?.path, info?.modifiedAt, rounded, width],
    queryFn: async () => dataUri(await frame({ path: info!.path, time: rounded!, width })),
    enabled: !!info && info.hasVideo && rounded !== null,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
    retry: false,
  });
}
