import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Every figure the sidebar line can show, in the order it shows them. "gpu" is the GPU's load. */
export const METRICS = [
  "cpu",
  "cpuTemp",
  "memory",
  "disk",
  "network",
  "gpu",
  "gpuTemp",
  "vram",
  "gpuPower",
] as const;
export type MetricKey = (typeof METRICS)[number];

const GPU_METRICS: readonly MetricKey[] = ["gpu", "gpuTemp", "vram", "gpuPower"];

/**
 * What the sidebar line leaves out for each host, by server id; the line shows whichever host the
 * app selects. Device scope keeps it on this device, and Paseo keys device settings by plugin id
 * alone, so the installations on every host read and write this one document: the Mac can hide
 * the PC's network speed without touching what the PC shows.
 */
const schema = z.object({
  hidden: z.record(z.string(), z.array(z.enum(METRICS))).default({}),
});
export type DisplayValues = z.output<typeof schema>;

/**
 * Version 1 had one "gpu" switch for GPU load and power together, the only GPU figures the line
 * showed then. A host that had it off keeps every GPU figure off. Anything else passes through for
 * the schema to judge, so an unreadable document ends up as invalid (with a reset), never a throw.
 */
export function migrateDisplay(values: unknown, fromVersion: number): unknown {
  const hidden = (values as { hidden?: unknown } | null)?.hidden;
  if (fromVersion !== 1 || typeof hidden !== "object" || hidden === null) return values;
  const migrated = Object.entries(hidden).map(([serverId, keys]) => [
    serverId,
    Array.isArray(keys) && keys.includes("gpu") ? [...new Set([...keys, ...GPU_METRICS])] : keys,
  ]);
  return { ...(values as object), hidden: Object.fromEntries(migrated) };
}

export const displaySettings = defineSettings({
  id: "display",
  scope: "device",
  version: 2,
  schema,
  migrate: migrateDisplay,
});

/** The metrics the line leaves out while it shows the host with this server id. */
export function hiddenMetrics(values: DisplayValues, serverId: string): readonly MetricKey[] {
  return values.hidden[serverId] ?? [];
}

/** The document after one switch: other hosts keep their choices. */
export function withMetricShown(
  values: DisplayValues,
  serverId: string,
  metric: MetricKey,
  shown: boolean,
): DisplayValues {
  const hidden = hiddenMetrics(values, serverId).filter((key) => key !== metric);
  if (!shown) hidden.push(metric);
  return { ...values, hidden: { ...values.hidden, [serverId]: hidden } };
}

