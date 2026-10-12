import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { View, type ViewStyle } from "react-native";
import { hostStatsRpc, type DiskUsage, type HostSample } from "../shared/stats";

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

/** Like df: the share of the space a user can fill, so a disk at 100% really has no room left. */
export function diskPercent(disk: Pick<DiskUsage, "usedBytes" | "availableBytes">): number {
  const usable = disk.usedBytes + disk.availableBytes;
  return usable > 0 ? (disk.usedBytes / usable) * 100 : 0;
}

/** All disks added together, as one figure for the sidebar. */
export function sumDisks(disks: readonly DiskUsage[]) {
  const sum = { totalBytes: 0, usedBytes: 0, availableBytes: 0 };
  for (const disk of disks) {
    sum.totalBytes += disk.totalBytes;
    sum.usedBytes += disk.usedBytes;
    sum.availableBytes += disk.availableBytes;
  }
  return { ...sum, percent: diskPercent(sum) };
}

export function scaleToPeak(samples: readonly HostSample[], pick: (s: HostSample) => number) {
  const peak = Math.max(1, ...samples.map(pick));
  return samples.map((sample) => (pick(sample) / peak) * 100);
}

// A load above zero always shows a sliver, so a nearly idle meter is not mistaken for an empty one.
const MIN_FILL_WIDTH = 2;

/** A horizontal bar filled to `percent`, colored by load. Size it with `style`. */
export function Meter({
  theme,
  percent,
  height,
  style,
}: {
  theme: PluginTheme;
  percent: number;
  height: number;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          height,
          borderRadius: height / 2,
          // The outline keeps an empty meter visible on surfaces close to the track color.
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        },
        style,
      ]}
    >
      <View
        style={{
          height: "100%",
          width: `${Math.min(Math.max(percent, 0), 100)}%`,
          minWidth: percent > 0 ? MIN_FILL_WIDTH : 0,
          backgroundColor: loadColor(theme, percent),
        }}
      />
    </View>
  );
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
