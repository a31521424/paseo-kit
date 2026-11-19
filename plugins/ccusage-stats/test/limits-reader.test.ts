import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createLimitsReader } from "../server/claude-usage";
import type { ClaudeLimitsSettings, ClaudeLimitsState } from "../shared/limits";

let dir: string;
let fake: string;
let calls: string;

/** A stand-in for claude that logs its arguments and prints `result` as `-p --output-format json`. */
function fakeClaude(result: string) {
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$@" >> '${calls}'\ncat <<'JSON'\n${JSON.stringify({ type: "result", is_error: false, result })}\nJSON\n`,
  );
  chmodSync(fake, 0o755);
}

const settings = (patch: Partial<ClaudeLimitsSettings> = {}): ClaudeLimitsSettings => ({
  enabled: true,
  claudePath: fake,
  minRefreshMinutes: 5,
  interactiveFallback: false,
  ...patch,
});

async function settle(read: () => Promise<ClaudeLimitsState>): Promise<ClaudeLimitsState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await read();
    if (!state.refreshing) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("still refreshing");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ccusage-reader-"));
  fake = path.join(dir, "claude");
  calls = path.join(dir, "calls.log");
  fakeClaude(
    "Current session: 11% used · resets 8pm\nCurrent week (all models): 6% used · resets Nov 26, 3am",
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("runs nothing while off", async () => {
  const reader = createLimitsReader(settings({ enabled: false }));
  const state = await reader.read();
  await reader.refresh();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(calls), false);
  assert.equal(state.enabled, false);
  assert.equal(state.limits, null);
});

test("reads the limits with claude -p /usage, without a session file", async () => {
  const reader = createLimitsReader(settings());
  const first = await reader.read();
  assert.equal(first.refreshing, true);
  const state = await settle(() => reader.read());
  assert.equal(
    readFileSync(calls, "utf8").trim(),
    "-p /usage --output-format json --no-session-persistence",
  );
  assert.equal(state.method, "headless");
  assert.equal(state.limits?.fiveHour?.percent, 11);
  assert.equal(state.limits?.sevenDay?.percent, 6);
  assert.equal(state.error, null);
});

test("waits the minimum interval, manual refreshes included", async () => {
  const reader = createLimitsReader(settings());
  await settle(() => reader.read());
  await settle(() => reader.read());
  const refreshed = await settle(() => reader.refresh());
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.ok(refreshed.nextManualAt !== null && refreshed.nextManualAt > Date.now());
});

test("explains when headless /usage has no limits and the fallback is off", async () => {
  fakeClaude("Total cost:            $0.0000\nUsage:                 0 input, 0 output");
  const reader = createLimitsReader(settings());
  await reader.read();
  const state = await settle(() => reader.read());
  assert.equal(state.limits, null);
  assert.match(state.error ?? "", /shows no plan limits.*interactive fallback is off/);
});

test("reports a missing claude", async () => {
  const reader = createLimitsReader(settings({ claudePath: path.join(dir, "nope") }));
  await reader.read();
  const state = await settle(() => reader.read());
  assert.equal(state.missingClaude, true);
  assert.equal(state.limits, null);
});

test("turning the feature off forgets what it read", async () => {
  const reader = createLimitsReader(settings());
  await reader.read();
  await settle(() => reader.read());
  reader.configure(settings({ enabled: false }));
  const off = await reader.read();
  assert.equal(off.limits, null);
  assert.equal(off.fetchedAt, null);
});
