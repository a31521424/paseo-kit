import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNvidiaSmi, startSampler } from "../server/sampler";

const MIB = 1024 * 1024;

test("reads nvidia-smi on Windows", () => {
  // RTX 5070 Ti, idle, as cmd.exe prints it (CRLF).
  const output = "NVIDIA GeForce RTX 5070 Ti, 0, 23.15, 300.00, 0, 16303, 43\r\n";
  assert.deepEqual(parseNvidiaSmi(output), [
    {
      name: "NVIDIA GeForce RTX 5070 Ti",
      utilizationPercent: 0,
      powerWatts: 23.15,
      powerLimitWatts: 300,
      memoryUsedBytes: 0,
      memoryTotalBytes: 16303 * MIB,
      temperatureCelsius: 43,
    },
  ]);
});

test("turns missing readings into null and keeps every GPU", () => {
  const output = [
    "NVIDIA A100-SXM4-40GB, 87, 251.30, 400.00, 30120, 40960, 61",
    "Tesla K80, [N/A], [Not Supported], [N/A], 11, 11441, 30",
    "",
  ].join("\n");
  const [a100, k80] = parseNvidiaSmi(output);
  assert.equal(a100?.utilizationPercent, 87);
  assert.equal(a100?.memoryUsedBytes, 30120 * MIB);
  assert.equal(k80?.name, "Tesla K80");
  assert.equal(k80?.utilizationPercent, null);
  assert.equal(k80?.powerWatts, null);
  assert.equal(k80?.powerLimitWatts, null);
  assert.equal(k80?.temperatureCelsius, 30);
});

test("a comma in the name does not shift the numbers", () => {
  const [gpu] = parseNvidiaSmi("Some, GPU, 5, 10.5, 100, 1, 2, 40\n");
  assert.equal(gpu?.name, "Some, GPU");
  assert.equal(gpu?.utilizationPercent, 5);
});

test("no GPU, no rows", () => {
  assert.deepEqual(parseNvidiaSmi(""), []);
  assert.deepEqual(parseNvidiaSmi("No devices were found\n"), []);
});

test("an empty field is no reading, not zero", () => {
  const [gpu] = parseNvidiaSmi("Some GPU, , 10.5, 100, 1, 2, 40\n");
  assert.equal(gpu?.utilizationPercent, null);
});

const GPU = parseNvidiaSmi("NVIDIA GeForce RTX 5070 Ti, 81, 198.01, 300.00, 3021, 16303, 62\n");
const never = () => new Promise<never>(() => {});

test("an nvidia-smi that never ends does not hold up CPU, RAM and disk", { timeout: 5000 }, async () => {
  const sampler = startSampler({ readGpus: never });
  try {
    const started = Date.now();
    const stats = await sampler.read();
    assert.ok(Date.now() - started < 2500, "read() waited for nvidia-smi");
    assert.equal(typeof stats.current.cpuPercent, "number");
    assert.deepEqual(stats.gpus, []);
    assert.equal(stats.current.gpuPercent, null);
    assert.equal(stats.current.gpuTemperatureCelsius, null);
    assert.equal(stats.current.vramPercent, null);
  } finally {
    sampler.stop();
  }
});

test("the sample keeps the hottest card and the video memory of all cards", async () => {
  const output = [
    "NVIDIA GeForce RTX 5070 Ti, 81, 198.01, 300.00, 3021, 16303, 62",
    "NVIDIA GeForce RTX 3060, 20, 40.00, 170.00, 1000, 12288, 71",
    // Reports neither memory nor temperature: counts toward neither figure.
    "Tesla K80, 0, [N/A], [N/A], [N/A], [N/A], [N/A]",
  ].join("\n");
  const sampler = startSampler({ readGpus: async () => parseNvidiaSmi(output) });
  try {
    const { current } = await sampler.read();
    assert.equal(current.gpuTemperatureCelsius, 71);
    assert.equal(current.vramPercent, ((3021 + 1000) / (16303 + 12288)) * 100);
  } finally {
    sampler.stop();
  }
});

test("a reading whose next call hangs is dropped, not shown as current", { timeout: 6000 }, async () => {
  let calls = 0;
  const sampler = startSampler({ readGpus: () => (calls++ === 0 ? Promise.resolve(GPU) : never()) });
  try {
    const first = await sampler.read();
    assert.equal(first.gpus.length, 1);
    assert.equal(first.current.gpuTemperatureCelsius, 62);
    // The next tick, two seconds on, finds the second call past its timeout.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const stats = await sampler.read();
    assert.deepEqual(stats.gpus, []);
    assert.equal(stats.current.gpuPercent, null);
    assert.equal(stats.current.gpuTemperatureCelsius, null);
    assert.equal(stats.current.vramPercent, null);
    // The history keeps what was current before the call hung.
    assert.equal(stats.history[0]?.gpuTemperatureCelsius, 62);
    assert.equal(stats.history[0]?.vramPercent, (3021 / 16303) * 100);
    assert.equal(calls, 2, "a hung call must not be started again");
  } finally {
    sampler.stop();
  }
});
