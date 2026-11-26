import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findCpuTemperatureFile, readCpuTemperature } from "../server/sampler";

/** A fake /sys/class: `files` maps paths below it to their contents. */
function sysClass(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "host-monitor-sys-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${content}\n`);
  }
  return root;
}

function withSysClass(files: Record<string, string>, check: (root: string) => void) {
  const root = sysClass(files);
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Intel: the package sensor of coretemp, not an NVMe or a core", () => {
  // As on an i9-9900K desktop: NVMe and NIC sensors come first, the package is not temp1 everywhere.
  withSysClass(
    {
      "hwmon/hwmon0/name": "nvme",
      "hwmon/hwmon0/temp1_input": "34850",
      "hwmon/hwmon5/name": "coretemp",
      "hwmon/hwmon5/temp1_input": "61000",
      "hwmon/hwmon5/temp1_label": "Core 0",
      "hwmon/hwmon5/temp2_input": "64000",
      "hwmon/hwmon5/temp2_label": "Package id 0",
      "thermal/thermal_zone1/type": "x86_pkg_temp",
      "thermal/thermal_zone1/temp": "35000",
    },
    (root) => {
      const file = findCpuTemperatureFile(root);
      assert.equal(file, path.join(root, "hwmon/hwmon5/temp2_input"));
      assert.equal(readCpuTemperature(file!), 64);
    },
  );
});

test("AMD: Tdie before Tctl, which carries an offset on some models", () => {
  withSysClass(
    {
      "hwmon/hwmon1/name": "k10temp",
      "hwmon/hwmon1/temp1_input": "75500",
      "hwmon/hwmon1/temp1_label": "Tctl",
      "hwmon/hwmon1/temp2_input": "48500",
      "hwmon/hwmon1/temp2_label": "Tdie",
    },
    (root) => assert.equal(readCpuTemperature(findCpuTemperatureFile(root)!), 48.5),
  );
});

test("a CPU chip without the expected labels falls back to its first sensor", () => {
  withSysClass({ "hwmon/hwmon0/name": "cpu_thermal", "hwmon/hwmon0/temp1_input": "52123" }, (root) =>
    assert.equal(findCpuTemperatureFile(root), path.join(root, "hwmon/hwmon0/temp1_input")),
  );
});

test("without a CPU chip, the CPU package thermal zone; an ACPI zone does not count", () => {
  withSysClass(
    {
      "thermal/thermal_zone0/type": "acpitz",
      "thermal/thermal_zone0/temp": "27800",
      "thermal/thermal_zone1/type": "x86_pkg_temp",
      "thermal/thermal_zone1/temp": "41000",
    },
    (root) => assert.equal(findCpuTemperatureFile(root), path.join(root, "thermal/thermal_zone1/temp")),
  );
});

test("no CPU sensor, no reading", () => {
  withSysClass({ "hwmon/hwmon0/name": "nvme", "hwmon/hwmon0/temp1_input": "34850" }, (root) =>
    assert.equal(findCpuTemperatureFile(root), null),
  );
  // Windows and macOS have no /sys at all.
  assert.equal(findCpuTemperatureFile(path.join(os.tmpdir(), "host-monitor-no-such-dir")), null);
});

test("a sensor that cannot be read is no reading, not zero", () => {
  withSysClass({ "bad/temp": "" }, (root) => {
    assert.equal(readCpuTemperature(path.join(root, "bad/temp")), null);
    assert.equal(readCpuTemperature(path.join(root, "missing/temp")), null);
  });
});
