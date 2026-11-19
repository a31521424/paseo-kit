import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// ccusage 20 ships a native binary per platform; the `ccusage` npm package is only a launcher.
// The daemon evaluates the server bundle without a module path, so `require.resolve` cannot find
// our node_modules. Instead, find our own directory among the plugins the daemon has registered,
// then fall back to a `ccusage` on PATH.
const NATIVE_PACKAGE = `@ccusage/ccusage-${process.platform}-${process.arch}`;
const BINARY_NAME = process.platform === "win32" ? "ccusage.exe" : "ccusage";
const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function paseoHome(): string {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Plugin directories from the daemon config: `plugins.<id>.path`. */
function registeredPluginDirectories(): string[] {
  try {
    const config = JSON.parse(readFileSync(path.join(paseoHome(), "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    return Object.values(config.plugins ?? {})
      .map((entry) => entry?.path)
      .filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function isThisPlugin(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return manifest.name === "ccusage-stats";
  } catch {
    return false;
  }
}

export interface CcusageBinary {
  file: string;
  source: "bundled" | "path";
}

export function locateCcusage(): CcusageBinary {
  // Only our own install: never run a binary out of another plugin's directory.
  for (const directory of registeredPluginDirectories().filter(isThisPlugin)) {
    const file = path.join(directory, "node_modules", NATIVE_PACKAGE, "bin", BINARY_NAME);
    if (isExecutable(file)) return { file, source: "bundled" };
  }
  return { file: "ccusage", source: "path" };
}

const rawUsage = {
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
};

const rawModel = z.object({ modelName: z.string(), cost: z.number().default(0), ...rawUsage });

const rawAgentRow = z.object({
  agent: z.string(),
  totalTokens: z.number().default(0),
  totalCost: z.number().default(0),
  modelBreakdowns: z.array(rawModel).default([]),
  ...rawUsage,
});

const rawRow = rawAgentRow.extend({
  period: z.string(),
  agents: z.array(rawAgentRow).optional(),
  metadata: z.object({ lastActivity: z.string().optional() }).loose().optional(),
});

const rawReport = z.object({
  daily: z.array(rawRow).default([]),
  weekly: z.array(rawRow).default([]),
  monthly: z.array(rawRow).default([]),
  session: z.array(rawRow).default([]),
});

export type RawModel = z.infer<typeof rawModel>;
export type RawAgentRow = z.infer<typeof rawAgentRow>;
export type RawRow = z.infer<typeof rawRow>;
export type RawReport = z.infer<typeof rawReport>;

const rawClaudeSessions = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        totalTokens: z.number().default(0),
        totalCost: z.number().default(0),
        lastActivity: z.string().optional(),
        modelBreakdowns: z.array(rawModel).default([]),
        ...rawUsage,
      }),
    )
    .default([]),
});

export type RawClaudeSession = z.infer<typeof rawClaudeSessions>["sessions"][number];

function execCcusage<T>(
  args: string[],
  schema: z.ZodType<T>,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<T> {
  const binary = locateCcusage();
  return new Promise((resolve, reject) => {
    execFile(
      binary.file,
      args,
      {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: options.signal,
        env: { ...process.env, ...options.env, NO_COLOR: "1" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          const detail = missing
            ? `ccusage not found (looked for the bundled ${NATIVE_PACKAGE} binary and PATH)`
            : `ccusage failed: ${stderr.trim().split("\n").slice(-3).join(" ") || error.message}`;
          reject(new Error(detail));
          return;
        }
        try {
          resolve(schema.parse(JSON.parse(stdout)));
        } catch (parseError) {
          reject(new Error(`Unexpected ccusage output: ${(parseError as Error).message}`));
        }
      },
    );
  });
}

/**
 * One ccusage run loads every detected agent's logs once and emits all sections. `--offline`
 * prices from the pricing table built into ccusage instead of fetching LiteLLM's on every run.
 */
export function runCcusage(timezone: string, signal?: AbortSignal): Promise<RawReport> {
  const args = [
    "--json",
    "--offline",
    "--sections",
    "daily,weekly,monthly,session",
    "--by-agent",
    "--timezone",
    timezone,
    "--no-color",
  ];
  return execCcusage(args, rawReport, { signal });
}

/**
 * Claude Code sessions under `configDir/projects` only, priced the same way as the full report.
 * ccusage names each session after its log file.
 */
export async function runClaudeSessions(
  configDir: string,
  timezone: string,
  signal?: AbortSignal,
): Promise<RawClaudeSession[]> {
  const args = ["claude", "session", "--json", "--offline", "--timezone", timezone, "--no-color"];
  const report = await execCcusage(args, rawClaudeSessions, {
    signal,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });
  return report.sessions;
}
