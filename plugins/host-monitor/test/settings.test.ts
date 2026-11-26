import assert from "node:assert/strict";
import { test } from "node:test";
import { displaySettings, hiddenMetrics, migrateDisplay, withMetricShown } from "../shared/settings";

test("no saved settings hide nothing", () => {
  const values = displaySettings.schema.parse({});
  assert.deepEqual(values, { hidden: {} });
  assert.deepEqual(hiddenMetrics(values, "srv_pc"), []);
});

test("each host keeps its own choice", () => {
  const values = displaySettings.schema.parse({ hidden: { srv_pc: ["network"], srv_linux: ["gpu"] } });
  assert.deepEqual(hiddenMetrics(values, "srv_pc"), ["network"]);
  assert.deepEqual(hiddenMetrics(values, "srv_linux"), ["gpu"]);
  assert.deepEqual(hiddenMetrics(values, "srv_mac"), []);
});

test("a switch changes only its host and metric", () => {
  const start = displaySettings.schema.parse({ hidden: { srv_linux: ["gpu"] } });
  const hidden = withMetricShown(start, "srv_pc", "network", false);
  assert.deepEqual(hidden.hidden, { srv_linux: ["gpu"], srv_pc: ["network"] });
  assert.deepEqual(withMetricShown(hidden, "srv_pc", "network", false).hidden.srv_pc, ["network"]);
  assert.deepEqual(withMetricShown(hidden, "srv_pc", "network", true).hidden, {
    srv_linux: ["gpu"],
    srv_pc: [],
  });
  assert.deepEqual(start, { hidden: { srv_linux: ["gpu"] } }, "the saved document is not mutated");
});

test("unknown metrics are rejected", () => {
  assert.equal(displaySettings.schema.safeParse({ hidden: { srv_pc: ["fan"] } }).success, false);
});

/** What Paseo does with a stored document of an older version: migrate, then parse. */
function readStored(values: unknown, version: number) {
  return displaySettings.schema.safeParse(migrateDisplay(values, version));
}

test("version 1: a hidden GPU keeps every GPU figure hidden", () => {
  // Version 1's "gpu" switch covered load and watts, the only GPU figures the line had.
  const parsed = readStored({ hidden: { srv_pc: ["gpu", "network"], srv_linux: ["disk"] } }, 1);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.hidden, {
    srv_pc: ["gpu", "network", "gpuTemp", "vram", "gpuPower"],
    srv_linux: ["disk"],
  });
});

test("version 1: an empty or default document stays as it is", () => {
  assert.deepEqual(readStored({}, 1).data, { hidden: {} });
  assert.deepEqual(readStored({ hidden: { srv_pc: [] } }, 1).data, { hidden: { srv_pc: [] } });
});

test("an unreadable old document is invalid, not a crash", () => {
  const broken = [null, "x", 42, { hidden: null }, { hidden: { srv_pc: "gpu" } }, { hidden: { srv_pc: [1] } }];
  for (const values of broken) {
    assert.doesNotThrow(() => migrateDisplay(values, 1));
    assert.equal(readStored(values, 1).success, false);
  }
});

test("the settings are version 2 and know how to migrate", () => {
  assert.equal(displaySettings.version, 2);
  assert.equal(displaySettings.migrate, migrateDisplay);
});
