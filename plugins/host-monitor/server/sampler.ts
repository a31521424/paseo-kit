import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import type { hostStatsRpc } from "../shared/stats";
import type { DiskUsage, HostSample, MemoryPressure, MemoryUsage } from "../shared/stats";

const execFileAsync = promisify(execFile);

const SAMPLE_INTERVAL_MS = 2000;
// Disk usage moves slowly; there is no point in asking the kernel every two seconds.
const DISK_INTERVAL_MS = 30_000;
const HISTORY_LENGTH = 90;
// Virtual interfaces mirror traffic already counted on the physical one.
const IGNORED_INTERFACE = /^(lo|veth|docker|br-|virbr)/;
// Read-only images (snap packages, CDs) are always full and are not space anyone can run out of.
const IGNORED_DISK_FS = new Set(["squashfs", "iso9660", "udf", "erofs"]);
// A stuck macOS tool must not hold up the sample; the previous reading is kept instead.
const MAC_COMMAND_TIMEOUT_MS = 1500;
// kern.memorystatus_vm_pressure_level, as defined by the kernel's kVMPressure* constants.
const MAC_PRESSURE_LEVELS: Record<string, MemoryPressure> = { "1": "normal", "2": "warning", "4": "critical" };

interface CpuTimes {
  idle: number;
  total: number;
}

interface NetworkTotals {
  rx: number;
  tx: number;
}

/**
 * Linux: the aggregate line of /proc/stat. iowait counts as idle; steal counts as busy, since on a
 * VPS it is CPU time the guest wanted but the hypervisor gave elsewhere. os.cpus() omits both.
 */
function readProcCpuTimes(): CpuTimes | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
    if (!line.startsWith("cpu ")) return null;
    // user nice system idle iowait irq softirq steal; guest time is already inside user and nice.
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number);
    return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
  } catch {
    return null;
  }
}

function readCpuTimes(): CpuTimes {
  const proc = readProcCpuTimes();
  if (proc) return proc;
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

/** Memory everywhere but macOS: Linux counts the page cache as free, other systems use os.freemem. */
function readMemory(): MemoryUsage {
  const totalBytes = os.totalmem();
  const usage = (usedBytes: number): MemoryUsage => ({
    totalBytes,
    usedBytes,
    cachedBytes: null,
    pressure: null,
  });
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return usage(totalBytes - Number(match[1]) * 1024);
  } catch {
    // Not Linux: fall back to os.freemem below.
  }
  return usage(totalBytes - os.freemem());
}

/** `vm_stat` output as page counts by label, e.g. "Pages wired down", plus the page size. */
export function parseVmStat(output: string): { pageSize: number; pages: Map<string, number> } | null {
  const pageSize = /page size of (\d+) bytes/.exec(output);
  if (!pageSize) return null;
  const pages = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim());
    if (match) pages.set(match[1]!, Number(match[2]));
  }
  return { pageSize: Number(pageSize[1]), pages };
}

/**
 * Activity Monitor's accounting: used is app memory (anonymous pages that are not purgeable) plus
 * wired memory plus what the compressor occupies; cached files (file-backed and purgeable pages)
 * are dropped at once when an app needs room, so they count as neither used nor free. os.freemem
 * counts only pages that hold nothing at all, which makes a Mac with a large cache look full.
 */
export function macMemoryFromVmStat(output: string, totalBytes: number): Omit<MemoryUsage, "pressure"> | null {
  const parsed = parseVmStat(output);
  if (!parsed) return null;
  const { pageSize, pages } = parsed;
  const anonymous = pages.get("Anonymous pages");
  const fileBacked = pages.get("File-backed pages");
  const wired = pages.get("Pages wired down");
  const compressor = pages.get("Pages occupied by compressor");
  if (anonymous === undefined || fileBacked === undefined || wired === undefined || compressor === undefined) {
    return null;
  }
  const purgeable = pages.get("Pages purgeable") ?? 0;
  const clamp = (bytes: number) => Math.min(Math.max(bytes, 0), totalBytes);
  return {
    totalBytes,
    usedBytes: clamp((Math.max(anonymous - purgeable, 0) + wired + compressor) * pageSize),
    cachedBytes: clamp((fileBacked + purgeable) * pageSize),
  };
}

async function readMacPressure(): Promise<MemoryPressure | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      { timeout: MAC_COMMAND_TIMEOUT_MS },
    );
    return MAC_PRESSURE_LEVELS[stdout.trim()] ?? null;
  } catch {
    return null;
  }
}

/** macOS: page counts from vm_stat and the pressure level from sysctl; null if vm_stat fails. */
async function readMacMemory(): Promise<MemoryUsage | null> {
  const totalBytes = os.totalmem();
  const [vmStat, pressure] = await Promise.all([
    execFileAsync("/usr/bin/vm_stat", [], { timeout: MAC_COMMAND_TIMEOUT_MS }).then(
      ({ stdout }) => stdout,
      () => null,
    ),
    readMacPressure(),
  ]);
  const memory = vmStat === null ? null : macMemoryFromVmStat(vmStat, totalBytes);
  return memory ? { ...memory, pressure } : null;
}

function readNetworkTotals(): NetworkTotals | null {
  let raw: string;
  try {
    raw = readFileSync("/proc/net/dev", "utf8");
  } catch {
    return null;
  }
  let rx = 0;
  let tx = 0;
  for (const line of raw.split("\n").slice(2)) {
    const [name, counters] = line.split(":");
    if (!name || !counters || IGNORED_INTERFACE.test(name.trim())) continue;
    const fields = counters.trim().split(/\s+/).map(Number);
    rx += fields[0] ?? 0;
    tx += fields[8] ?? 0;
  }
  return { rx, tx };
}

interface Mount {
  device: string;
  mount: string;
  fsType: string;
}

/** /proc/mounts writes spaces and other awkward characters as octal escapes, e.g. "\040". */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Linux: filesystems backed by a block device, one entry per device. Pseudo and memory-backed
 * filesystems are not disks, and network mounts are skipped because statfs on a dead server can
 * hang. A device mounted more than once (bind mounts, btrfs subvolumes) is counted once, under
 * its shortest mount point. Elsewhere, or when nothing qualifies (a container on overlayfs), the
 * root filesystem alone.
 */
function readLocalMounts(): Mount[] {
  let raw = "";
  try {
    raw = readFileSync("/proc/mounts", "utf8");
  } catch {
    // Not Linux: fall back to the root filesystem below.
  }
  const byDevice = new Map<string, Mount>();
  for (const line of raw.split("\n")) {
    const [device, mount, fsType] = line.split(" ").map(unescapeMountField);
    if (!device || !mount || !fsType || IGNORED_DISK_FS.has(fsType)) continue;
    if (!device.startsWith("/dev/") && fsType !== "zfs") continue;
    const seen = byDevice.get(device);
    if (!seen || mount.length < seen.mount.length) byDevice.set(device, { device, mount, fsType });
  }
  if (byDevice.size === 0) {
    // On macOS the root is always APFS (the Node versions Paseo runs on need macOS 11 or later), and
    // statfs reports the whole container: every volume in it, not just the system or data volume.
    return [{ device: "", mount: "/", fsType: process.platform === "darwin" ? "apfs" : "" }];
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

async function readDisks(): Promise<DiskUsage[]> {
  const disks = await Promise.all(
    readLocalMounts().map(async ({ device, mount, fsType }): Promise<DiskUsage | null> => {
      try {
        const fs = await statfs(mount);
        if (fs.blocks === 0) return null;
        // Like df: used is everything not free, so blocks reserved for root count as neither.
        const totalBytes = fs.blocks * fs.bsize;
        return {
          mount,
          device,
          fsType,
          totalBytes,
          usedBytes: totalBytes - fs.bfree * fs.bsize,
          availableBytes: fs.bavail * fs.bsize,
        };
      } catch {
        return null;
      }
    }),
  );
  return disks.filter((disk): disk is DiskUsage => disk !== null);
}

export type HostStats = RpcOutput<typeof hostStatsRpc>;

export function startSampler(): { read(): Promise<HostStats>; stop(): void } {
  const isMac = process.platform === "darwin";
  const history: HostSample[] = [];
  let previousCpu = readCpuTimes();
  let previousNet = readNetworkTotals();
  let previousAt = Date.now();
  let networkTotals = previousNet;
  let disks: DiskUsage[] = [];
  let diskRead: Promise<void> | null = null;
  let macMemory: MemoryUsage | null = null;
  let macMemoryRead: Promise<void> | null = null;
  let memory = readMemory();

  // vm_stat runs as a separate process, so each tick uses the reading the previous one started.
  const refreshMacMemory = () => {
    macMemoryRead ??= readMacMemory()
      .then((next) => {
        if (next) macMemory = next;
      })
      .finally(() => {
        macMemoryRead = null;
      });
    return macMemoryRead;
  };

  const tick = () => {
    const now = Date.now();
    const cpu = readCpuTimes();
    const net = readNetworkTotals();
    const seconds = Math.max((now - previousAt) / 1000, 0.001);
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    if (isMac) void refreshMacMemory();
    memory = macMemory ?? readMemory();

    const sample: HostSample = {
      at: now,
      cpuPercent: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0,
      memoryPercent: (memory.usedBytes / memory.totalBytes) * 100,
      rxBytesPerSec: net && previousNet ? Math.max(net.rx - previousNet.rx, 0) / seconds : 0,
      txBytesPerSec: net && previousNet ? Math.max(net.tx - previousNet.tx, 0) / seconds : 0,
    };
    history.push(sample);
    if (history.length > HISTORY_LENGTH) history.shift();

    previousCpu = cpu;
    previousNet = net;
    previousAt = now;
    networkTotals = net;
  };

  const refreshDisks = () => {
    // A slow disk must not pile up reads behind it.
    if (diskRead) return;
    diskRead = readDisks()
      .then((next) => {
        disks = next;
      })
      .catch(() => {})
      .finally(() => {
        diskRead = null;
      });
  };

  // On macOS the first sample waits for vm_stat, so the history does not open with os.freemem's figure.
  const firstSample = isMac ? refreshMacMemory().then(tick) : Promise.resolve(tick());
  refreshDisks();
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  const diskTimer = setInterval(refreshDisks, DISK_INTERVAL_MS);

  return {
    async read() {
      await firstSample;
      const cpus = os.cpus();
      const [one = 0, five = 0, fifteen = 0] = os.loadavg();
      const current = history[history.length - 1];
      return {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        uptimeSeconds: os.uptime(),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model ?? "unknown",
        loadAverage: [one, five, fifteen],
        memory,
        network: networkTotals
          ? { rxTotalBytes: networkTotals.rx, txTotalBytes: networkTotals.tx }
          : null,
        disks,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        current: current ?? {
          at: Date.now(),
          cpuPercent: 0,
          memoryPercent: 0,
          rxBytesPerSec: 0,
          txBytesPerSec: 0,
        },
        history: [...history],
      };
    },
    stop() {
      clearInterval(timer);
      clearInterval(diskTimer);
    },
  };
}
