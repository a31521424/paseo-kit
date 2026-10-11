import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { hostStatsRpc, type HostSample } from "../shared/stats";

const REFRESH_MS = 2000;

export function useHostStats() {
  const getStats = useRpc(hostStatsRpc);
  return useQuery({
    queryKey: ["host-stats"],
    queryFn: () => getStats({}),
    refetchInterval: REFRESH_MS,
  });
}

/** Muted until a resource runs hot, like the built-in usage summary. */
export function loadColor(theme: PluginTheme, percent: number): string {
  if (percent >= 90) return theme.colors.statusDanger;
  if (percent >= 70) return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function scaleToPeak(samples: readonly HostSample[], pick: (s: HostSample) => number) {
  const peak = Math.max(1, ...samples.map(pick));
  return samples.map((sample) => (pick(sample) / peak) * 100);
}

interface SparklineProps {
  /** Values on a 0-100 scale, oldest first. */
  values: readonly number[];
  color: string;
  height: number;
}

export function Sparkline({ values, color, height }: SparklineProps) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 1 }}>
      {values.map((value, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            height: Math.max(1, (Math.min(value, 100) / 100) * height),
            backgroundColor: color,
            opacity: 0.6,
          }}
        />
      ))}
    </View>
  );
}
