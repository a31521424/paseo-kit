import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  /** Most stdout bytes kept; the process is killed beyond this. */
  maxBytes?: number;
}

/** Runs a command on the daemon host to completion, collecting stdout as bytes and the tail of stderr. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(command)} took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error(`${path.basename(command)} produced more output than expected`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, { code, stdout: Buffer.concat(chunks), stderr }));
  });
}

/** The last meaningful line ffmpeg printed, for error messages. */
export function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "ffmpeg failed";
}

/** Runs at most `limit` tasks at once; the rest wait in order. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

/**
 * Frames, waveforms and probes share this, so a long chat cannot start dozens of ffmpeg processes
 * at once. Two on a small VPS, up to four on bigger machines.
 */
export const heavy = createLimiter(Math.max(2, Math.min(4, os.cpus().length - 1)));
