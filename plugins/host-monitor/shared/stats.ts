import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const sampleSchema = z.object({
  at: z.number(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  rxBytesPerSec: z.number(),
  txBytesPerSec: z.number(),
  /** Linux: the CPU package sensor in °C; null where the host exposes none (Windows, macOS, most VMs). */
  cpuTemperatureCelsius: z.number().nullable(),
  /** All NVIDIA GPUs averaged; null on a host without one. */
  gpuPercent: z.number().nullable(),
  /** Power draw of all NVIDIA GPUs added together; null when there is none or it reports none. */
  gpuWatts: z.number().nullable(),
  /** The hottest NVIDIA GPU in °C; null when there is none or it reports none. */
  gpuTemperatureCelsius: z.number().nullable(),
  /** Video memory of all NVIDIA GPUs added together, as a percent of their total; null without one. */
  vramPercent: z.number().nullable(),
});

/** One NVIDIA GPU as nvidia-smi reports it; a field the card does not report is null. */
const gpuSchema = z.object({
  name: z.string(),
  utilizationPercent: z.number().nullable(),
  powerWatts: z.number().nullable(),
  powerLimitWatts: z.number().nullable(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  temperatureCelsius: z.number().nullable(),
});

const diskSchema = z.object({
  mount: z.string(),
  device: z.string(),
  fsType: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  /** Free space an unprivileged user can still write; excludes blocks reserved for root. */
  availableBytes: z.number(),
});

const memorySchema = z.object({
  totalBytes: z.number(),
  /** Memory in use and not reclaimable: what the RAM percentage shows. */
  usedBytes: z.number(),
  /** macOS: cached files the system can drop at once, counted as neither used nor free. */
  cachedBytes: z.number().nullable(),
  /** macOS: the kernel's memory pressure level; when present it, not the percentage, sets the color. */
  pressure: z.enum(["normal", "warning", "critical"]).nullable(),
});

export const hostStatsRpc = defineRpc({
  name: "host.stats",
  input: z.object({}),
  output: z.object({
    hostname: z.string(),
    platform: z.string(),
    uptimeSeconds: z.number(),
    cpuCount: z.number(),
    cpuModel: z.string(),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    memory: memorySchema,
    network: z
      .object({ rxTotalBytes: z.number(), txTotalBytes: z.number() })
      .nullable(),
    disks: z.array(diskSchema),
    /** Empty when the host has no NVIDIA GPU or no nvidia-smi. */
    gpus: z.array(gpuSchema),
    sampleIntervalMs: z.number(),
    current: sampleSchema,
    history: z.array(sampleSchema),
  }),
});

/** Video memory of the GPUs that report it, added together; null when none does. */
export function sumGpuMemory(gpus: readonly GpuUsage[]): { usedBytes: number; totalBytes: number } | null {
  let usedBytes = 0;
  let totalBytes = 0;
  for (const gpu of gpus) {
    if (gpu.memoryUsedBytes === null || !gpu.memoryTotalBytes) continue;
    usedBytes += gpu.memoryUsedBytes;
    totalBytes += gpu.memoryTotalBytes;
  }
  return totalBytes > 0 ? { usedBytes, totalBytes } : null;
}

export type HostSample = z.infer<typeof sampleSchema>;
export type GpuUsage = z.infer<typeof gpuSchema>;
export type DiskUsage = z.infer<typeof diskSchema>;
export type MemoryUsage = z.infer<typeof memorySchema>;
export type MemoryPressure = NonNullable<MemoryUsage["pressure"]>;
