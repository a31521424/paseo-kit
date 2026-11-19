import assert from "node:assert/strict";
import { test } from "node:test";
import { Screen } from "../server/terminal";
import { parseResetTime, parseUsageText } from "../server/usage-text";

// 2026-11-19 12:00 UTC, 20:00 in Singapore (UTC+8, no daylight saving).
const NOW = Date.UTC(2026, 10, 19, 12, 0);
const sgt = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
  Date.UTC(year, month - 1, day, hour - 8, minute);

const HEADLESS = `You are currently using your subscription to power your Claude Code usage

Current session: 11% used · resets Nov 19, 8:29pm (Asia/Singapore)
Current week (all models): 6% used · resets Nov 26, 2:59am (Asia/Singapore)
Current week (Opus): 0% used · resets Nov 26, 3am (Asia/Singapore)

What's contributing to your usage?
Approximate · sessions on this machine only`;

test("reads claude -p /usage", () => {
  assert.deepEqual(parseUsageText(HEADLESS, NOW), {
    fiveHour: {
      percent: 11,
      resetsAt: sgt(11, 19, 20, 29),
      resetsText: "Nov19,8:29pm(Asia/Singapore)",
    },
    sevenDay: {
      percent: 6,
      resetsAt: sgt(11, 26, 2, 59),
      resetsText: "Nov26,2:59am(Asia/Singapore)",
    },
    partial: false,
  });
});

test("reads the interactive screen of a setup token", () => {
  const screen = `  Settings  Status   Config   Usage   Stats

  Current session
  █████▌                                            48%used
  Resets 7pm (Asia/Singapore)

  Current week (all models)
  ███                                               15%used
  Resets Nov 21, 9am (Asia/Singapore)

  What's contributing to your usage?
  Other limits and usage credits aren't shown for this sign-in.`;
  const limits = parseUsageText(screen, Date.UTC(2026, 10, 19, 2, 0));
  assert.equal(limits?.fiveHour?.percent, 48);
  assert.equal(limits?.fiveHour?.resetsAt, sgt(11, 19, 19));
  assert.equal(limits?.sevenDay?.percent, 15);
  assert.equal(limits?.sevenDay?.resetsAt, sgt(11, 21, 9));
  assert.equal(limits?.partial, true);
});

test("does not take another window's numbers", () => {
  const limits = parseUsageText(
    "Current session\n  Loading…\nCurrent week (all models)\n  ██ 30%used\n  Resets Nov 21, 9am",
    NOW,
  );
  assert.equal(limits?.fiveHour, null);
  assert.equal(limits?.sevenDay?.percent, 30);
});

test("returns null for output without plan limits", () => {
  const cost = `Total cost:            $0.0000
Total duration (API):  0s
Usage:                 0 input, 0 output, 0 cache read, 0 cache write`;
  assert.equal(parseUsageText(cost, NOW), null);
  assert.equal(parseUsageText("", NOW), null);
});

test("keeps an unreadable reset time as text", () => {
  const limits = parseUsageText("Current session: 100% used · resets soon", NOW);
  assert.deepEqual(limits?.fiveHour, { percent: 100, resetsAt: null, resetsText: "soon" });
});

test("works out reset times", () => {
  // A time alone is today, or tomorrow once it has passed.
  assert.equal(parseResetTime("9pm(Asia/Singapore)", NOW), sgt(11, 19, 21));
  assert.equal(parseResetTime("7pm(Asia/Singapore)", NOW), sgt(11, 20, 19));
  assert.equal(parseResetTime("12am(Asia/Singapore)", NOW), sgt(11, 20, 0));
  // A date that has passed this year is next year's.
  assert.equal(parseResetTime("Jan2,9am(Asia/Singapore)", NOW), sgt(1, 2, 9, 0, 2027));
  // Daylight saving: New York is UTC-5 in November.
  assert.equal(parseResetTime("Nov21,9am(America/New_York)", NOW), Date.UTC(2026, 10, 21, 14));
  assert.equal(parseResetTime("soon", NOW), null);
  assert.equal(parseResetTime("13pm", NOW), null);
});

test("replays cursor moves and erases like a terminal", () => {
  const screen = new Screen(5, 40);
  // Draw, move up over the old frame, erase it and draw the next one, as Ink does.
  screen.write("Loading…\r\n\x1b[2mspinner\x1b[0m");
  screen.write("\x1b[1A\r\x1b[2K\x1b[1B\x1b[2K\x1b[1A\rCurrent session\r\n\x1b[2G12%\x1b[1Cused");
  screen.write("\x1b]0;title\x07\x1b[3;1HResets 8");
  // A sequence split across chunks.
  screen.write(":30pm\x1b[");
  screen.write("K");
  assert.equal(screen.text(), "Current session\n 12% used\nResets 8:30pm\n\n");
  screen.write("\x1b[2J\x1b[H");
  assert.equal(screen.text().trim(), "");
});
