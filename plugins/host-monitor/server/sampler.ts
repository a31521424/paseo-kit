import { readFileSync } from "node:fs";
import os from "node:os";
import type { RpcOutput } from "@getpaseo/plugin";
import type { hostStatsRpc } from "../shared/stats";
import type { HostSample } from "../shared/stats";

const SAMPLE_INTERVAL_MS = 2000;
const HISTORY_LENGTH = 90;
// Virtual interfaces mirror traffic already counted on the physical one.
const IGNORED_INTERFACE = /^(lo|veth|docker|br-|virbr)/;

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

function readMemory(): { totalBytes: number; usedBytes: number } {
  const totalBytes = os.totalmem();
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

export type HostStats = RpcOutput<typeof hostStatsRpc>;

export function startSampler(): { read(): HostStats; stop(): void } {
  const history: HostSample[] = [];
  let previousCpu = readCpuTimes();
  let previousNet = readNetworkTotals();
  let previousAt = Date.now();
  let networkTotals = previousNet;

  const tick = () => {
    const now = Date.now();
    const cpu = readCpuTimes();
    const net = readNetworkTotals();
    const seconds = Math.max((now - previousAt) / 1000, 0.001);
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const memory = readMemory();

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

  tick();
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS);

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
        memory: readMemory(),
        network: networkTotals
          ? { rxTotalBytes: networkTotals.rx, txTotalBytes: networkTotals.tx }
          : null,
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
    },
  };
}
