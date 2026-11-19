import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeLimitsSettings, ClaudeLimitsState, PlanLimits } from "../shared/limits";
import { Screen } from "./terminal";
import { parseUsageText } from "./usage-text";

// Claude plan limits from Claude Code's own /usage command. Claude Code fetches the numbers with
// its own sign-in; this plugin never reads, stores or sends a Claude token. Two ways to run it:
//
// 1. `claude -p /usage`: a local command, no model turn, no usage, about two seconds. With a
//    regular Claude Code login it prints the 5-hour and weekly limits.
// 2. With a `claude setup-token` token (CLAUDE_CODE_OAUTH_TOKEN), `-p /usage` prints only session
//    cost, while the interactive /usage screen shows both limits. The fallback starts Claude Code
//    in a pseudo-terminal (the system `script` command), types /usage, reads the screen and quits.

const HEADLESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const SCREEN_ROWS = 50;
// The interactive session's own deadline, past INTERACTIVE_TIMEOUT_MS.
const SESSION_KILL_SECONDS = 90;
// Stops for the interactive sessions running now, for plugin shutdown.
const activeSessions = new Set<() => void>();

/** Ends every interactive /usage session still running. */
export function stopInteractiveSessions(): void {
  for (const stop of activeSessions) stop();
}
const SCREEN_COLS = 120;
// The interactive session runs in this empty folder, so no project settings or CLAUDE.md load.
const WORK_DIR = path.join(os.tmpdir(), "paseo-ccusage-stats-usage");

export class UsageError extends Error {}

const isExecutable = (file: string) =>
  fs.access(file, constants.X_OK).then(
    () => true,
    () => false,
  );

/** The configured path, else `claude` on PATH, else the installer's usual locations. */
export async function locateClaude(configured: string): Promise<string | null> {
  const explicit = configured.trim();
  if (explicit) {
    const expanded = explicit.startsWith("~/")
      ? path.join(os.homedir(), explicit.slice(2))
      : explicit;
    return (await isExecutable(expanded)) ? expanded : null;
  }
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".claude", "local"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (await isExecutable(file)) return file;
    }
  }
  return null;
}

function collect(stream: NodeJS.ReadableStream | null, sink: { text: string }) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    if (sink.text.length < MAX_OUTPUT_CHARS) sink.text += chunk;
  });
}

/** `claude -p /usage`: returns /usage's text, or throws. */
export function runHeadless(claude: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      claude,
      ["-p", "/usage", "--output-format", "json", "--no-session-persistence"],
      { cwd: WORK_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = { text: "" };
    const stderr = { text: "" };
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    const timer = setTimeout(() => child.kill("SIGKILL"), HEADLESS_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new UsageError(`Could not start claude: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let result: { result?: unknown; is_error?: unknown } | null = null;
      try {
        result = JSON.parse(stdout.text.trim()) as { result?: unknown; is_error?: unknown };
      } catch {
        // Handled below.
      }
      const text = typeof result?.result === "string" ? result.result : null;
      if (text !== null && !result?.is_error) {
        resolve(text);
        return;
      }
      const reason = signal
        ? "timed out"
        : (text ?? stderr.text.trim().split("\n").at(-1) ?? "") || `exited with code ${code}`;
      reject(new UsageError(`claude -p /usage failed: ${reason.slice(0, 200)}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `script` invocation that runs `command` in a pseudo-terminal, per platform. */
function ptyCommand(command: string): { file: string; args: string[] } | null {
  if (process.platform === "linux")
    return { file: "script", args: ["-qfec", command, "/dev/null"] };
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
    return { file: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", command] };
  }
  return null;
}

const ONBOARDING =
  /choose the text style|select login method|let's get started|log in to|sign in to/i;

/** /usage in an interactive Claude Code session; returns the final screen text, or throws. */
export function runInteractive(claude: string, cwd = WORK_DIR): Promise<string> {
  // `exec` keeps the shell's pid for Claude Code, so the background timer ends it even if this
  // process dies before it can.
  const pty = ptyCommand(
    `stty cols ${SCREEN_COLS} rows ${SCREEN_ROWS} 2>/dev/null; ` +
      `(sleep ${SESSION_KILL_SECONDS}; kill -TERM $$ 2>/dev/null) & exec ${shellQuote(claude)}`,
  );
  if (!pty) {
    return Promise.reject(
      new UsageError(`The interactive /usage fallback is not supported on ${process.platform}.`),
    );
  }
  return new Promise((resolve, reject) => {
    const screen = new Screen(SCREEN_ROWS, SCREEN_COLS);
    const child = spawn(pty.file, pty.args, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: `${SCREEN_COLS}`,
        LINES: `${SCREEN_ROWS}`,
      },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    let lastOutputAt = Date.now();
    let phase: "boot" | "typed" | "done" = "boot";
    let trustKeyAt = 0;
    let typedAt = 0;
    const startedAt = Date.now();

    const stop = () => {
      clearInterval(tick);
      try {
        // The whole group: `script`, the shell and Claude Code.
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2_000).unref();
    };
    const finish = (error: Error | null, text?: string) => {
      if (phase === "done") return;
      phase = "done";
      activeSessions.delete(abort);
      stop();
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const send = (data: string) => {
      if (child.stdin?.writable) child.stdin.write(data);
    };

    const abort = () => finish(new UsageError("Stopped."));
    activeSessions.add(abort);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      screen.write(chunk);
      lastOutputAt = Date.now();
    });
    child.stdin?.on("error", () => {});
    child.on("error", (error) =>
      finish(new UsageError(`Could not start a pseudo-terminal (script): ${error.message}`)),
    );
    child.on("close", () => {
      if (phase !== "done") {
        const text = screen.text();
        if (parseUsageText(text)) finish(null, text);
        else finish(new UsageError("Claude Code exited before /usage showed the plan limits."));
      }
    });

    const tick = setInterval(() => {
      const now = Date.now();
      const text = screen.text();
      const quiet = now - lastOutputAt;
      if (now - startedAt > INTERACTIVE_TIMEOUT_MS) {
        finish(
          new UsageError("Timed out waiting for /usage in an interactive Claude Code session."),
        );
        return;
      }
      if (phase === "boot") {
        if (ONBOARDING.test(text)) {
          finish(
            new UsageError(
              "Claude Code has not finished its first-run setup on this host. Run claude once in a terminal.",
            ),
          );
          return;
        }
        // The folder trust prompt for the plugin's own empty folder. Its default answer exits, so
        // move to "Yes" and confirm only once the screen shows it selected.
        if (/trust this folder/i.test(text)) {
          if (/❯\s*(\d\.\s*)?Yes, I trust/i.test(text)) {
            if (now - trustKeyAt > 500) {
              send("\r");
              trustKeyAt = now;
            }
          } else if (now - trustKeyAt > 1_500) {
            send("\x1b[B");
            trustKeyAt = now;
          }
          lastOutputAt = now;
          return;
        }
        if (quiet < 2_000 || now - startedAt < 3_000) return;
        phase = "typed";
        typedAt = now;
        // Typed in pieces like a person, then confirmed once the command menu has settled.
        "/usage".split("").forEach((char, index) => setTimeout(() => send(char), index * 60));
        setTimeout(() => send("\r"), 1_200);
        return;
      }
      if (phase === "typed" && now - typedAt > 2_000) {
        const limits = parseUsageText(text);
        // Both windows, or one of them once the screen has stopped changing.
        if (limits && ((limits.fiveHour && limits.sevenDay) || quiet > 3_000)) finish(null, text);
      }
    }, 250);
  });
}

export interface LimitsReader {
  read(): Promise<ClaudeLimitsState>;
  /** A manual refresh; still no more often than the minimum interval. */
  refresh(): Promise<ClaudeLimitsState>;
  configure(settings: ClaudeLimitsSettings): void;
}

/**
 * Runs /usage only when a view asks (`read`), so nothing runs while no Paseo client is open, and
 * never more often than the minimum interval. Failures back off exponentially up to an hour.
 */
export function createLimitsReader(initial: ClaudeLimitsSettings): LimitsReader {
  let settings = initial;
  let limits: PlanLimits | null = null;
  let method: "headless" | "interactive" | null = null;
  let fetchedAt: number | null = null;
  let error: string | null = null;
  let missingClaude = false;
  let lastAttemptAt: number | null = null;
  let failures = 0;
  // Once `-p /usage` has shown no limits on this host, go straight to the interactive screen.
  let headlessLacksLimits = false;
  let inflight: Promise<void> | null = null;
  // Bumped by every settings change; a run started under older settings is discarded.
  let generation = 0;

  const minInterval = () => settings.minRefreshMinutes * 60_000;
  const backoff = () =>
    failures === 0 ? minInterval() : Math.min(minInterval() * 2 ** failures, MAX_BACKOFF_MS);

  const reset = () => {
    limits = null;
    method = null;
    fetchedAt = null;
    error = null;
    missingClaude = false;
    lastAttemptAt = null;
    failures = 0;
    headlessLacksLimits = false;
  };

  const snapshot = (): ClaudeLimitsState => ({
    enabled: settings.enabled,
    minRefreshMs: minInterval(),
    limits,
    method,
    fetchedAt,
    error,
    missingClaude,
    lastAttemptAt,
    nextManualAt: lastAttemptAt === null ? null : lastAttemptAt + minInterval(),
    refreshing: inflight !== null,
  });

  const fetchLimits = async (
    claude: string,
  ): Promise<{ limits: PlanLimits; method: "headless" | "interactive" }> => {
    await fs.mkdir(WORK_DIR, { recursive: true });
    if (!headlessLacksLimits) {
      const found = parseUsageText(await runHeadless(claude));
      if (found) return { limits: found, method: "headless" };
      headlessLacksLimits = true;
    }
    if (!settings.interactiveFallback) {
      throw new UsageError(
        "claude -p /usage shows no plan limits for this sign-in, and the interactive fallback is off.",
      );
    }
    const found = parseUsageText(await runInteractive(claude));
    if (!found)
      throw new UsageError("Could not find the plan limits on Claude Code's /usage screen.");
    return { limits: found, method: "interactive" };
  };

  const run = () => {
    inflight ??= (async () => {
      const startedAt = Date.now();
      const started = generation;
      lastAttemptAt = startedAt;
      try {
        const claude = await locateClaude(settings.claudePath);
        if (started !== generation) return;
        missingClaude = claude === null;
        if (!claude) {
          error = null;
          failures += 1;
          return;
        }
        const result = await fetchLimits(claude);
        if (started !== generation) return;
        limits = result.limits;
        method = result.method;
        fetchedAt = startedAt;
        error = null;
        failures = 0;
      } catch (caught) {
        if (started !== generation) return;
        error = caught instanceof Error ? caught.message : String(caught);
        failures += 1;
        console.warn(`[ccusage-stats] Claude plan limits: ${error}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    async read() {
      // Off: nothing runs.
      if (!settings.enabled) return snapshot();
      const due = lastAttemptAt === null || Date.now() - lastAttemptAt >= backoff();
      if (due && !inflight) void run();
      return snapshot();
    },

    async refresh() {
      if (!settings.enabled) return snapshot();
      const allowed = lastAttemptAt === null || Date.now() - lastAttemptAt >= minInterval();
      if (allowed && !inflight) void run();
      return snapshot();
    },

    configure(next) {
      const previous = settings;
      settings = next;
      generation += 1;
      if (
        !next.enabled ||
        !previous.enabled ||
        next.claudePath !== previous.claudePath ||
        next.interactiveFallback !== previous.interactiveFallback
      ) {
        reset();
      }
    },
  };
}
