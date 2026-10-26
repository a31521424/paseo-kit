import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const sampleSchema = z.object({
  at: z.number(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  rxBytesPerSec: z.number(),
  txBytesPerSec: z.number(),
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
    sampleIntervalMs: z.number(),
    current: sampleSchema,
    history: z.array(sampleSchema),
  }),
});

export type HostSample = z.infer<typeof sampleSchema>;
export type DiskUsage = z.infer<typeof diskSchema>;
export type MemoryUsage = z.infer<typeof memorySchema>;
export type MemoryPressure = NonNullable<MemoryUsage["pressure"]>;
