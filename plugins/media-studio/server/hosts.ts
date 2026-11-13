import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, mediaKindOf, type MediaKind } from "../shared/media";
import { run, type RunResult } from "./ffmpeg";
import { scanMedia as scanLocal, type ScannedFile } from "./files";

// Media can live on the daemon host or on a machine the daemon reaches over SSH, such as a GPU
// server an agent renders on. A remote file is written `alias:/absolute/path`, with an alias from
// the daemon user's ~/.ssh/config. Everything about a remote file runs on that machine: its ffmpeg
// probes, renders frames and streams playback, and only the results travel back over SSH. One
// multiplexed SSH connection per host keeps each command to a few milliseconds after the first.

export interface Tools {
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  /** H.264 encoders this ffmpeg lists: libx264, h264_videotoolbox, h264_nvenc. */
  encoders: string[];
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export type Child = ChildProcessByStdio<null, Readable, Readable>;

export interface MediaHost {
  /** `local`, or the SSH alias. */
  readonly id: string;
  readonly remote: boolean;
  tools(): Promise<Tools>;
  /** Starts a process; on an SSH host it waits for the shared connection first. */
  spawn(command: string, args: string[]): Promise<Child>;
  run(command: string, args: string[], options?: { timeoutMs?: number; maxBytes?: number }): Promise<RunResult>;
  stat(file: string): Promise<FileStat | null>;
  readRange(file: string, offset: number, length: number): Promise<Buffer>;
  /** Writes `data` at `offset`. Remote hosts need offsets that are multiples of `data.length` or of 4 MB. */
  writeAt(file: string, offset: number, data: Buffer): Promise<void>;
  createEmpty(file: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
  listDir(dir: string): Promise<DirEntry[]>;
  scan(root: string): Promise<{ files: ScannedFile[]; truncated: boolean }>;
  home(): Promise<string>;
}

/** A file on a host. `ref` is how the app names it: `/abs/path` or `alias:/abs/path`. */
export interface Located {
  host: MediaHost;
  path: string;
  ref: string;
}

/** The host's ffmpeg, or an error that says where it was looked for. */
export async function ffmpegOn(host: MediaHost): Promise<string> {
  const { ffmpeg } = await host.tools();
  if (ffmpeg) return ffmpeg;
  throw new Error(
    host.remote
      ? `ffmpeg was not found on ${host.id}. Install it there, or copy the file to the daemon host.`
      : "ffmpeg was not found on the daemon host. Install it or set its path in Media studio settings.",
  );
}

export function refOf(host: MediaHost, file: string): string {
  return host.remote ? `${host.id}:${file}` : file;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findLocalBinary(configuredPath: string, name: string, extra: string[] = []): Promise<string | null> {
  if (configuredPath.trim()) {
    const resolved = configuredPath.trim().replace(/^~(?=\/|$)/, os.homedir());
    return (await isExecutable(resolved)) ? resolved : null;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...dirs.map((dir) => path.join(dir, name)),
    ...extra,
    path.join(os.homedir(), ".local", "bin", name),
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
    path.join("/usr/bin", name),
  ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

const H264_ENCODERS = ["libx264", "h264_videotoolbox", "h264_nvenc"];

async function describeFfmpeg(host: Pick<MediaHost, "run">, ffmpeg: string): Promise<{ version: string | null; encoders: string[] }> {
  const version = await host.run(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15_000 }).catch(() => null);
  const list = await host.run(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 }).catch(() => null);
  const text = list?.stdout.toString() ?? "";
  return {
    version: version ? (/ffmpeg version (\S+)/.exec(version.stdout.toString())?.[1] ?? null) : null,
    encoders: H264_ENCODERS.filter((name) => new RegExp(`\\b${name}\\b`).test(text)),
  };
}

let localPaths = { ffmpeg: "", ffprobe: "" };
let localTools: Promise<Tools> | null = null;

/** Paths from the plugin settings; empty strings mean "search". */
export function configureLocalTools(paths: { ffmpeg: string; ffprobe: string }): void {
  if (paths.ffmpeg === localPaths.ffmpeg && paths.ffprobe === localPaths.ffprobe) return;
  localPaths = paths;
  localTools = null;
}

export const localHost: MediaHost = {
  id: "local",
  remote: false,
  tools() {
    localTools ??= (async () => {
      const ffmpeg = await findLocalBinary(localPaths.ffmpeg, "ffmpeg");
      const ffprobe = await findLocalBinary(localPaths.ffprobe, "ffprobe", ffmpeg ? [path.join(path.dirname(ffmpeg), "ffprobe")] : []);
      const described = ffmpeg ? await describeFfmpeg(localHost, ffmpeg) : { version: null, encoders: [] };
      return { ffmpeg, ffprobe, ...described };
    })().catch((error) => {
      localTools = null;
      throw error;
    });
    return localTools;
  },
  async spawn(command, args) {
    return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  },
  run(command, args, options) {
    return run(command, args, options);
  },
  async stat(file) {
    const stats = await fs.stat(file).catch(() => null);
    return stats ? { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory() } : null;
  },
  async readRange(file, offset, length) {
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(file, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  },
  async writeAt(file, offset, data) {
    const handle = await fs.open(file, "r+");
    try {
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written, offset + written);
        written += result.bytesWritten;
      }
    } finally {
      await handle.close();
    }
  },
  async createEmpty(file) {
    await fs.writeFile(file, "");
  },
  async mkdirp(dir) {
    await fs.mkdir(dir, { recursive: true });
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  async remove(file) {
    await fs.unlink(file).catch(() => undefined);
  },
  async listDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      throw new Error(error.code === "ENOENT" ? `Folder not found: ${dir}` : error.message);
    });
    const result: DirEntry[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;
        const stats = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (!stats || (!stats.isDirectory() && !stats.isFile())) return;
        result.push({ name: entry.name, isDirectory: stats.isDirectory(), size: stats.size, mtimeMs: stats.mtimeMs });
      }),
    );
    return result;
  },
  scan(root) {
    return scanLocal(root);
  },
  async home() {
    return os.homedir();
  },
};

/** POSIX shell quoting for one argument. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// $1 and $2: ffmpeg and ffprobe paths from the settings, or empty. $3 and $4: the paths found last
// time, tried in place of the slow search below. Without them: PATH, the usual install folders, then the
// static ffmpeg the imageio-ffmpeg Python package ships, which GPU boxes running ComfyUI or similar
// often have in a venv even when no system ffmpeg is installed. That last search walks the home
// folder and can take several seconds on a cold disk, so the result is remembered on this side.
const REMOTE_TOOL_SEARCH = [
  'for c in ffmpeg ffprobe; do',
  '  if [ "$c" = ffmpeg ]; then p="$1"; h="$3"; else p="$2"; h="$4"; fi',
  '  if [ -n "$p" ] && [ ! -x "$p" ]; then echo "$c=!$p"; continue; fi',
  '  [ -z "$p" ] && p=$(command -v "$c" 2>/dev/null)',
  '  if [ -z "$p" ]; then',
  '    for d in "$HOME/.cache/paseo-media-studio/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin /opt/conda/bin "$HOME/miniconda3/bin" "$HOME/anaconda3/bin" "$HOME/bin"; do',
  '      if [ -x "$d/$c" ]; then p="$d/$c"; break; fi',
  "    done",
  "  fi",
  '  if [ -z "$p" ] && [ -n "$h" ] && [ -x "$h" ]; then p="$h"; fi',
  '  if [ -z "$p" ] && [ "$c" = ffmpeg ]; then',
  '    p=$(python3 -c "import imageio_ffmpeg as m; print(m.get_ffmpeg_exe())" 2>/dev/null)',
  '    [ -z "$p" ] && p=$(timeout 20 find "$HOME" -xdev -maxdepth 9 -path "*imageio_ffmpeg/binaries/ffmpeg-*" -type f -perm -u+x 2>/dev/null | head -n 1)',
  "  fi",
  '  echo "$c=$p"',
  "done",
].join("\n");

const FOUND_TOOLS_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paseo-media-studio", "remote-tools.json");

type FoundTools = Record<string, { ffmpeg: string | null; ffprobe: string | null }>;

async function readFoundTools(): Promise<FoundTools> {
  try {
    return JSON.parse(await fs.readFile(FOUND_TOOLS_FILE, "utf8")) as FoundTools;
  } catch {
    return {};
  }
}

let foundToolsWrite: Promise<void> = Promise.resolve();

function rememberFoundTools(host: string, tools: { ffmpeg: string | null; ffprobe: string | null }): void {
  foundToolsWrite = foundToolsWrite.then(async () => {
    const all = await readFoundTools();
    if (all[host]?.ffmpeg === tools.ffmpeg && all[host]?.ffprobe === tools.ffprobe) return;
    all[host] = tools;
    await fs.mkdir(path.dirname(FOUND_TOOLS_FILE), { recursive: true });
    await fs.writeFile(FOUND_TOOLS_FILE, JSON.stringify(all, null, 2));
  }).catch(() => undefined);
}

/** A host without ffmpeg is asked again after this long, in case it was a slow search or it got installed. */
const MISSING_TOOLS_RETRY_MS = 60_000;

/** Per-host ffmpeg and ffprobe paths from the settings: `alias=/path/to/ffmpeg`. */
let remoteToolPaths = new Map<string, { ffmpeg: string; ffprobe: string }>();

export function configureRemoteTools(setting: string): void {
  const next = new Map<string, { ffmpeg: string; ffprobe: string }>();
  for (const entry of setting.split(/[\n,;]+/)) {
    const match = /^\s*([^=\s]+)\s*=\s*(\S+)\s*$/.exec(entry);
    if (!match) continue;
    const ffmpeg = match[2]!;
    next.set(match[1]!, { ffmpeg, ffprobe: path.posix.join(path.posix.dirname(ffmpeg), "ffprobe") });
  }
  const changed = JSON.stringify([...next]) !== JSON.stringify([...remoteToolPaths]);
  remoteToolPaths = next;
  if (changed) for (const host of remoteHosts.values()) host.forgetTools();
}

const MEDIA_GLOBS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];

function sshControlDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `pms-${uid}`);
}

/** ssh exits with 255 for its own failures: no connection, refused key, unknown alias. */
class SshConnectionError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RemoteHost implements MediaHost {
  readonly remote = true;
  private toolsPromise: Promise<Tools> | null = null;
  private homePromise: Promise<string> | null = null;
  private master: { ready: Promise<void>; child: ChildProcess | null } | null = null;

  constructor(readonly id: string) {}

  forgetTools(): void {
    this.toolsPromise = null;
  }

  private controlPath(): string {
    return path.join(sshControlDir(), `${this.id.replace(/[^A-Za-z0-9._-]/g, "_")}.sock`);
  }

  private baseArgs(): string[] {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      `ControlPath=${this.controlPath()}`,
    ];
  }

  private async masterAlive(): Promise<boolean> {
    const result = await run("ssh", [...this.baseArgs(), "-O", "check", this.id], { timeoutMs: 5000 }).catch(() => null);
    return result?.code === 0;
  }

  /**
   * Opens the one SSH connection every command of this host shares, once. Some servers and port
   * forwarders refuse several handshakes at once, which plain ControlMaster=auto runs into when a
   * panel asks for a probe, frames and a waveform together; commands wait for this instead.
   */
  private connect(): Promise<void> {
    if (this.master) return this.master.ready;
    const entry: { ready: Promise<void>; child: ChildProcess | null } = { ready: Promise.resolve(), child: null };
    entry.ready = (async () => {
      await fs.mkdir(sshControlDir(), { recursive: true, mode: 0o700 });
      if (await this.masterAlive()) return;
      await fs.unlink(this.controlPath()).catch(() => undefined);
      const child = spawn("ssh", [...this.baseArgs(), "-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-N", this.id], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      entry.child = child;
      let stderr = "";
      let exited = false;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on("exit", () => {
        exited = true;
        if (this.master === entry) this.master = null;
      });
      child.on("error", () => {
        exited = true;
      });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (exited) throw new SshConnectionError(`SSH to ${this.id} failed: ${stderr.trim().split("\n").at(-1) || "connection closed"}`);
        if (await this.masterAlive()) return;
        await sleep(150);
      }
      child.kill("SIGKILL");
      throw new SshConnectionError(`SSH to ${this.id}: no connection within 25 s`);
    })().catch((error) => {
      if (this.master === entry) this.master = null;
      throw error;
    });
    this.master = entry;
    return entry.ready;
  }

  private dropConnection(): void {
    const master = this.master;
    this.master = null;
    master?.child?.kill("SIGTERM");
  }

  close(): void {
    this.dropConnection();
  }

  /** Runs `attempt` on the shared connection, reconnecting and retrying once if SSH itself failed. */
  private async withConnection<T>(attempt: () => Promise<T>): Promise<T> {
    await this.connect();
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof SshConnectionError)) throw error;
      this.dropConnection();
      await sleep(300);
      await this.connect();
      return attempt();
    }
  }

  /** Runs `script` with `sh -c` on the host, passing `args` as $1, $2, … */
  private shell(script: string, args: string[]): string {
    return ["sh", "-c", shellQuote(script), "sh", ...args.map(shellQuote)].join(" ");
  }

  private exec(remoteCommand: string, stdin: "ignore" | "pipe" = "ignore"): ChildProcessByStdio<Writable | null, Readable, Readable> {
    return spawn("ssh", [...this.baseArgs(), "-o", "ControlMaster=no", this.id, "--", remoteCommand], {
      stdio: [stdin, "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  }

  private collect(child: ChildProcessByStdio<Writable | null, Readable, Readable>, timeoutMs: number, maxBytes: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
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
        finish(new Error(`${this.id}: no answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          child.kill("SIGKILL");
          finish(new Error(`${this.id}: more output than expected`));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code === 255) finish(new SshConnectionError(`SSH to ${this.id} failed: ${stderr.trim().split("\n").at(-1) ?? "no connection"}`));
        else finish(null, { code, stdout: Buffer.concat(chunks), stderr });
      });
    });
  }

  private script(script: string, args: string[], options: { timeoutMs?: number; maxBytes?: number; input?: Buffer } = {}): Promise<RunResult> {
    return this.withConnection(() => {
      const child = this.exec(this.shell(script, args), options.input ? "pipe" : "ignore");
      const result = this.collect(child, options.timeoutMs ?? 30_000, options.maxBytes ?? 64 * 1024 * 1024);
      if (options.input && child.stdin) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input);
      }
      return result;
    });
  }

  private async check(script: string, args: string[], what: string, input?: Buffer): Promise<RunResult> {
    const result = await this.script(script, args, { input, timeoutMs: input ? 120_000 : 30_000 });
    if (result.code !== 0) throw new Error(`${this.id}: ${what} failed: ${result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`}`);
    return result;
  }

  tools(): Promise<Tools> {
    this.toolsPromise ??= (async () => {
      const configured = remoteToolPaths.get(this.id);
      const last = (await readFoundTools())[this.id];
      const found = await this.check(
        REMOTE_TOOL_SEARCH,
        [configured?.ffmpeg ?? "", configured?.ffprobe ?? "", last?.ffmpeg ?? "", last?.ffprobe ?? ""],
        "looking for ffmpeg",
      );
      const values: Record<string, string> = {};
      for (const line of found.stdout.toString().split("\n")) {
        const index = line.indexOf("=");
        if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
      }
      if (values.ffmpeg?.startsWith("!")) throw new Error(`${this.id}: ${values.ffmpeg.slice(1)} is not an executable ffmpeg`);
      const ffmpeg = values.ffmpeg || null;
      const ffprobe = values.ffprobe && !values.ffprobe.startsWith("!") ? values.ffprobe : null;
      if (ffmpeg && !configured) rememberFoundTools(this.id, { ffmpeg, ffprobe });
      if (!ffmpeg) {
        const promise = this.toolsPromise;
        setTimeout(() => {
          if (this.toolsPromise === promise) this.toolsPromise = null;
        }, MISSING_TOOLS_RETRY_MS).unref?.();
      }
      const described = ffmpeg ? await describeFfmpeg(this, ffmpeg) : { version: null, encoders: [] };
      return { ffmpeg, ffprobe, ...described };
    })().catch((error) => {
      this.toolsPromise = null;
      throw error;
    });
    return this.toolsPromise;
  }

  async spawn(command: string, args: string[]): Promise<Child> {
    await this.connect();
    return this.exec([command, ...args].map(shellQuote).join(" ")) as Child;
  }

  run(command: string, args: string[], options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<RunResult> {
    return this.withConnection(() =>
      this.collect(this.exec([command, ...args].map(shellQuote).join(" ")), options.timeoutMs ?? 60_000, options.maxBytes ?? 64 * 1024 * 1024),
    );
  }

  async stat(file: string): Promise<FileStat | null> {
    const result = await this.script(
      `if out=$(stat -c '%s %Y %F' -- "$1" 2>/dev/null); then echo "$out"; else stat -f '%z %m %HT' -- "$1" 2>/dev/null; fi`,
      [file],
    );
    const line = result.stdout.toString().trim();
    const match = /^(\d+) (\d+) (.*)$/.exec(line);
    if (!match) return null;
    const type = match[3]!.toLowerCase();
    return { size: Number(match[1]), mtimeMs: Number(match[2]) * 1000, isFile: type.includes("regular"), isDirectory: type.includes("directory") };
  }

  async readRange(file: string, offset: number, length: number): Promise<Buffer> {
    const result = await this.script(`tail -c +"$1" -- "$3" | head -c "$2"`, [String(offset + 1), String(length), file], {
      timeoutMs: 120_000,
      maxBytes: length + 1024,
    });
    if (result.code !== 0 && result.stdout.length === 0) throw new Error(`${this.id}: cannot read ${file}`);
    return result.stdout;
  }

  async writeAt(file: string, offset: number, data: Buffer): Promise<void> {
    // dd counts `seek` in blocks, so the block is the largest power of two up to 4 MB that divides
    // the offset; upload pieces start at multiples of 256 KB.
    let block = 4 * 1024 * 1024;
    while (block > 512 && offset % block !== 0) block /= 2;
    if (offset % block !== 0) throw new Error("Remote uploads need aligned pieces");
    await this.check(`dd of="$1" bs="$2" seek="$3" conv=notrunc 2>/dev/null`, [file, String(block), String(offset / block)], "writing", data);
  }

  async createEmpty(file: string): Promise<void> {
    await this.check(`: > "$1"`, [file], "creating a file");
  }

  async mkdirp(dir: string): Promise<void> {
    await this.check(`mkdir -p -- "$1"`, [dir], "creating a folder");
  }

  async rename(from: string, to: string): Promise<void> {
    await this.check(`mv -f -- "$1" "$2"`, [from, to], "renaming");
  }

  async remove(file: string): Promise<void> {
    await this.script(`rm -f -- "$1"`, [file]).catch(() => undefined);
  }

  async listDir(dir: string): Promise<DirEntry[]> {
    const result = await this.script(
      [
        `[ -d "$1" ] || { echo "Folder not found: $1" >&2; exit 3; }`,
        `if find "$1" -maxdepth 0 -printf '' 2>/dev/null; then`,
        `  find -L "$1" -mindepth 1 -maxdepth 1 ! -name '.*' \\( -type f -o -type d \\) -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`,
        `else`,
        `  for f in "$1"/*; do [ -e "$f" ] && stat -L -f '%HT%t%z%t%m%t%N' -- "$f"; done`,
        `fi`,
      ].join("\n"),
      [dir],
      { timeoutMs: 30_000 },
    );
    if (result.code === 3) throw new Error(`Folder not found: ${refOf(this, dir)}`);
    return result.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [type = "", size = "0", mtime = "0", ...rest] = line.split("\t");
        const name = path.basename(rest.join("\t"));
        const isDirectory = type === "d" || type.toLowerCase() === "directory";
        return { name, isDirectory, size: Number(size), mtimeMs: Number(mtime) * 1000 };
      })
      .filter((entry) => entry.name);
  }

  async scan(root: string): Promise<{ files: ScannedFile[]; truncated: boolean }> {
    const names = MEDIA_GLOBS.map((ext) => `-iname '*.${ext}'`).join(" -o ");
    const prune = `\\( -name '.*' -o -name node_modules -o -name __pycache__ -o -name venv -o -name site-packages \\) -prune`;
    const result = await this.script(
      `find -L "$1" -mindepth 1 -maxdepth 8 ${prune} -o -type f \\( ${names} \\) -printf '%s\\t%T@\\t%p\\n' 2>/dev/null | head -n 20001`,
      [root],
      { timeoutMs: 30_000 },
    );
    const lines = result.stdout.toString().split("\n").filter(Boolean);
    const files: ScannedFile[] = [];
    for (const line of lines.slice(0, 20_000)) {
      const [size = "0", mtime = "0", ...rest] = line.split("\t");
      const file = rest.join("\t");
      const kind: MediaKind | null = mediaKindOf(file);
      if (kind) files.push({ path: file, kind, size: Number(size), mtimeMs: Number(mtime) * 1000 });
    }
    return { files, truncated: lines.length > 20_000 };
  }

  home(): Promise<string> {
    this.homePromise ??= this.check(`printf %s "$HOME"`, [], "reading the home folder")
      .then((result) => result.stdout.toString().trim() || "/")
      .catch((error) => {
        this.homePromise = null;
        throw error;
      });
    return this.homePromise;
  }
}

const remoteHosts = new Map<string, RemoteHost>();
let allowedSetting = "*";
let aliasCache: { at: number; aliases: Promise<string[]> } | null = null;

/** `*` allows every alias in ~/.ssh/config; otherwise a comma-separated list; empty turns SSH off. */
export function configureRemoteHosts(setting: string): void {
  allowedSetting = setting.trim();
}

async function readSshConfig(file: string, depth: number, aliases: Set<string>): Promise<void> {
  if (depth > 3) return;
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const include = /^include\s+(.+)$/i.exec(line);
    if (include) {
      for (const pattern of include[1]!.split(/\s+/)) {
        const expanded = pattern.replace(/^~(?=\/)/, os.homedir());
        const target = path.isAbsolute(expanded) ? expanded : path.join(os.homedir(), ".ssh", expanded);
        if (!/[*?]/.test(target)) await readSshConfig(target, depth + 1, aliases);
      }
      continue;
    }
    const host = /^host\s+(.+)$/i.exec(line);
    if (!host) continue;
    for (const alias of host[1]!.split(/\s+/)) {
      if (alias && !/[*?!]/.test(alias)) aliases.add(alias);
    }
  }
}

/** Host aliases from the daemon user's SSH config, re-read at most once a minute. */
export function sshAliases(): Promise<string[]> {
  if (!aliasCache || Date.now() - aliasCache.at > 60_000) {
    const aliases = new Set<string>();
    aliasCache = {
      at: Date.now(),
      aliases: readSshConfig(path.join(os.homedir(), ".ssh", "config"), 0, aliases).then(() => [...aliases].sort()),
    };
  }
  return aliasCache.aliases;
}

export async function allowedRemoteHosts(): Promise<string[]> {
  if (!allowedSetting) return [];
  if (allowedSetting === "*") return sshAliases();
  return allowedSetting
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Closes every shared SSH connection; for plugin cleanup. */
export function closeRemoteHosts(): void {
  for (const host of remoteHosts.values()) host.close();
}

function remoteHost(alias: string): RemoteHost {
  let host = remoteHosts.get(alias);
  if (!host) remoteHosts.set(alias, (host = new RemoteHost(alias)));
  return host;
}

const REMOTE_REF = /^(?:ssh:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)|([A-Za-z0-9][A-Za-z0-9._-]*):(.+))$/;

/**
 * Finds a file from what an agent or the app wrote: `alias:/path`, `alias:~/path`,
 * `ssh://alias/path`, an absolute or `~` path on the daemon host, or a path relative to `cwd`.
 */
export async function locate(input: string, cwd?: string | null): Promise<Located> {
  const value = input.trim();
  const match = REMOTE_REF.exec(value);
  if (match) {
    const alias = match[1] ?? match[3]!;
    let file = match[2] ?? match[4]!;
    if ((await allowedRemoteHosts()).includes(alias)) {
      const host = remoteHost(alias);
      if (file === "~" || file.startsWith("~/")) file = path.posix.join(await host.home(), file.slice(1));
      else if (!file.startsWith("/")) file = path.posix.join(await host.home(), file);
      file = path.posix.normalize(file);
      return { host, path: file, ref: refOf(host, file) };
    }
  }
  if (cwd && REMOTE_REF.test(cwd.trim()) && !value.startsWith("/") && !value.startsWith("~")) {
    const base = await locate(cwd);
    if (base.host.remote) {
      const file = path.posix.normalize(path.posix.join(base.path, value));
      return { host: base.host, path: file, ref: refOf(base.host, file) };
    }
  }
  let file: string;
  if (value === "~" || value.startsWith("~/")) file = path.join(os.homedir(), value.slice(1));
  else if (path.isAbsolute(value)) file = path.normalize(value);
  else if (cwd) file = path.resolve((await locate(cwd)).path, value);
  else throw new Error(`Not an absolute path: ${value}`);
  return { host: localHost, path: file, ref: file };
}
