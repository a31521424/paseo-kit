import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_MIN_REFRESH_MINUTES = 5;
export const MIN_REFRESH_OPTIONS = [2, 5, 10, 15, 30, 60] as const;

const claudeLimitsSettings = z.object({
  /** Off by default: when on, the daemon runs Claude Code's own /usage command on its host. */
  enabled: z.boolean().default(false),
  /** Path to the claude executable. Empty: search PATH and the usual install folders. */
  claudePath: z.string().default(""),
  /** Never run /usage more often than this, manual refreshes included. */
  minRefreshMinutes: z.number().min(1).max(1440).default(DEFAULT_MIN_REFRESH_MINUTES),
  /**
   * When `claude -p /usage` shows no plan limits (as with a `claude setup-token` token), open
   * /usage in an interactive Claude Code session in a pseudo-terminal instead.
   */
  interactiveFallback: z.boolean().default(true),
});

export const settingsDefinition = defineSettings({
  id: "ccusage-stats",
  scope: "host",
  version: 1,
  schema: z.object({
    // A full default rather than `{}`: Zod 4 returns an object default as is, without filling in
    // the inner defaults.
    claudeLimits: claudeLimitsSettings.default({
      enabled: false,
      claudePath: "",
      minRefreshMinutes: DEFAULT_MIN_REFRESH_MINUTES,
      interactiveFallback: true,
    }),
  }),
});

export type PluginSettingsValues = z.infer<typeof settingsDefinition.schema>;
export type ClaudeLimitsSettings = PluginSettingsValues["claudeLimits"];
export const DEFAULT_SETTINGS: PluginSettingsValues = settingsDefinition.schema.parse({});

const limitWindowSchema = z.object({
  /** Percent of the window used, as /usage shows it. Can reach 100. */
  percent: z.number(),
  /** When the window resets, epoch milliseconds; null when /usage gave no time or it was unreadable. */
  resetsAt: z.number().nullable(),
  /** /usage's own reset text, for when `resetsAt` could not be worked out. */
  resetsText: z.string().nullable(),
});

export const planLimitsSchema = z.object({
  /** "Current session": the 5-hour window. */
  fiveHour: limitWindowSchema.nullable(),
  /** "Current week (all models)". */
  sevenDay: limitWindowSchema.nullable(),
  /** True when /usage says other limits are not shown for this sign-in (setup tokens). */
  partial: z.boolean(),
});

export const claudeLimitsStateSchema = z.object({
  enabled: z.boolean(),
  minRefreshMs: z.number(),
  /** The latest limits read, kept while later runs fail. */
  limits: planLimitsSchema.nullable(),
  /** How `limits` were read: `claude -p /usage`, or /usage in an interactive session. */
  method: z.enum(["headless", "interactive"]).nullable(),
  /** When `limits` were read, epoch milliseconds. */
  fetchedAt: z.number().nullable(),
  /** Set when the latest run failed. */
  error: z.string().nullable(),
  /** The claude executable could not be found. */
  missingClaude: z.boolean(),
  lastAttemptAt: z.number().nullable(),
  /** The earliest time a manual refresh is accepted. */
  nextManualAt: z.number().nullable(),
  refreshing: z.boolean(),
});

export type LimitWindow = z.infer<typeof limitWindowSchema>;
export type PlanLimits = z.infer<typeof planLimitsSchema>;
export type ClaudeLimitsState = z.infer<typeof claudeLimitsStateSchema>;

export const claudeLimitsRpc = defineRpc({
  name: "limits.read",
  input: z.object({}),
  output: claudeLimitsStateSchema,
});

export const refreshClaudeLimitsRpc = defineRpc({
  name: "limits.refresh",
  input: z.object({}),
  output: claudeLimitsStateSchema,
});
