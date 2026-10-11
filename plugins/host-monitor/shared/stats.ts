import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const sampleSchema = z.object({
  at: z.number(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  rxBytesPerSec: z.number(),
  txBytesPerSec: z.number(),
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
    memory: z.object({ totalBytes: z.number(), usedBytes: z.number() }),
    network: z
      .object({ rxTotalBytes: z.number(), txTotalBytes: z.number() })
      .nullable(),
    sampleIntervalMs: z.number(),
    current: sampleSchema,
    history: z.array(sampleSchema),
  }),
});

export type HostSample = z.infer<typeof sampleSchema>;
