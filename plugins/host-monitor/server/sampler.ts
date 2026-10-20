import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import type { RpcOutput } from "@getpaseo/plugin";
import type { hostStatsRpc } from "../shared/stats";
import type { DiskUsage, HostSample } from "../shared/stats";

const SAMPLE_INTERVAL_MS = 2000;
// Disk usage moves slowly; there is no point in asking the kernel every two seconds.
const DISK_INTERVAL_MS = 30_000;
const HISTORY_LENGTH = 90;
// Virtual interfaces mirror traffic already counted on the physical one.
const IGNORED_INTERFACE = /^(lo|veth|docker|br-|virbr)/;
// Read-only images (snap packages, CDs) are always full and are not space anyone can run out of.
const IGNORED_DISK_FS = new Set(["squashfs", "iso9660", "udf", "erofs"]);

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

export function parseDarwinUsedBytes(raw: string): number {
  const pageSize = /page size of (\d+) bytes/.exec(raw);
  if (!pageSize || Number(pageSize[1]) === 0) throw new Error("vm_stat: missing page size");
  const pages = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\.`, "m").exec(raw);
    if (!match) throw new Error(`vm_stat: missing ${name}`);
    return Number(match[1]);
  };
  // Activity Monitor: app (anonymous minus purgeable), wired, and physical compressed memory.
  // File-backed cache is reclaimable; pages stored in the compressor are not physical bytes.
  return (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") +
    pages("Pages occupied by compressor")) * Number(pageSize[1]);
}

function readMemory(): { totalBytes: number; usedBytes: number } {
  const totalBytes = os.totalmem();
  if (os.platform() === "darwin") {
    try {
      const raw = execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000 });
      return { totalBytes, usedBytes: parseDarwinUsedBytes(raw) };
    } catch (error) {
      console.warn("host-monitor: failed to read macOS memory; using os.freemem", error);
      return { totalBytes, usedBytes: totalBytes - os.freemem() };
    }
  }
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return { totalBytes, usedBytes: totalBytes - Number(match[1]) * 1024 };
  } catch {
    // Not Linux: fall back to os.freemem below.
  }
  return { totalBytes, usedBytes: totalBytes - os.freemem() };
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
  if (byDevice.size === 0) return [{ device: "", mount: "/", fsType: "" }];
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

export function startSampler(): { read(): HostStats; stop(): void } {
  const history: HostSample[] = [];
  let previousCpu = readCpuTimes();
  let previousNet = readNetworkTotals();
  let previousAt = Date.now();
  let networkTotals = previousNet;
  let disks: DiskUsage[] = [];
  let diskRead: Promise<void> | null = null;
  let memory: ReturnType<typeof readMemory>;

  const tick = () => {
    const now = Date.now();
    const cpu = readCpuTimes();
    const net = readNetworkTotals();
    const seconds = Math.max((now - previousAt) / 1000, 0.001);
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    memory = readMemory();

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

  tick();
  refreshDisks();
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  const diskTimer = setInterval(refreshDisks, DISK_INTERVAL_MS);

  return {
    read() {
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
