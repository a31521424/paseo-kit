import type { LimitWindow, PlanLimits } from "../shared/limits";

// Reads the plan limits out of Claude Code's /usage text. Two renderings reach this parser:
//
//   claude -p /usage:  "Current session: 11% used · resets Nov 19, 8:29pm (Asia/Singapore)"
//   interactive TUI:   "Current session" / "█████▌   11%used" / "Resets 8:30pm (Asia/Singapore)"
//
// Spacing differs between them and between terminal renders, so matching ignores whitespace.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 24 * 60 * 60_000;
// How far past a label to look for its numbers.
const SEGMENT_CHARS = 240;

const LABELS = {
  fiveHour: /currentsession/i,
  sevenDay: /currentweek\(allmodels\)/i,
};
// Where one window's block ends: the next window or the sections after the limits.
const BLOCK_END =
  /currentsession|currentweek|what'scontributing|otherlimits|extrausage|usagecredits/i;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(timestamp: number, timeZone: string | undefined): ZonedParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(new Date(timestamp));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour") % 24,
      minute: get("minute"),
    };
  } catch {
    return null;
  }
}

/** The epoch time of a wall-clock time in `timeZone` (the host's zone when undefined). */
function zonedToEpoch(parts: ZonedParts, timeZone: string | undefined): number | null {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = wall;
  // Two rounds settle the offset, including across a daylight saving change.
  for (let round = 0; round < 2; round += 1) {
    const seen = zonedParts(guess, timeZone);
    if (!seen) return null;
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += wall - seenWall;
  }
  return guess;
}

/**
 * "Nov19,8:29pm(Asia/Singapore)", "8:30pm(Asia/Singapore)", "7pm": the next such moment after
 * `now - 1 day` (resets can be a little in the past when /usage was read).
 */
export function parseResetTime(compact: string, now: number): number | null {
  const match =
    /^(?:([a-z]{3})[a-z]*\.?(\d{1,2}),?)?(\d{1,2})(?::(\d{2}))?(am|pm)?(?:\(([^)]+)\))?/i.exec(
      compact,
    );
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!meridiem && !minuteText) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  let timeZone: string | undefined = zone?.trim();
  if (!timeZone || !zonedParts(now, timeZone)) timeZone = undefined;
  const today = zonedParts(now, timeZone);
  if (!today) return null;

  if (monthName && dayText) {
    const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
    if (month === 0) return null;
    const day = Number(dayText);
    for (const year of [today.year, today.year + 1]) {
      const at = zonedToEpoch({ year, month, day, hour, minute }, timeZone);
      if (at !== null && at > now - DAY_MS) return at;
    }
    return null;
  }
  // A time alone: today, or tomorrow once today's has passed.
  const at = zonedToEpoch({ ...today, hour, minute }, timeZone);
  if (at === null) return null;
  return at > now - 60_000 ? at : at + DAY_MS;
}

function parseBlock(block: string, now: number): LimitWindow | null {
  const percent = /(\d{1,3}(?:\.\d+)?)%used/i.exec(block);
  if (!percent) return null;
  const reset = /resets?(.+)$/i.exec(block.slice(percent.index + percent[0].length));
  const resetsText = reset?.[1]?.replace(/^[:·,\s]+/, "").replace(/[·,.\s]+$/, "") || null;
  return {
    percent: Number(percent[1]),
    resetsAt: resetsText ? parseResetTime(resetsText, now) : null,
    resetsText,
  };
}

function findWindow(compact: string, label: RegExp, now: number): LimitWindow | null {
  const found = label.exec(compact);
  if (!found) return null;
  const rest = compact.slice(
    found.index + found[0].length,
    found.index + found[0].length + SEGMENT_CHARS,
  );
  const end = BLOCK_END.exec(rest);
  return parseBlock(end ? rest.slice(0, end.index) : rest, now);
}

/** The 5-hour and weekly windows in /usage text, or null when it shows neither. */
export function parseUsageText(text: string, now = Date.now()): PlanLimits | null {
  const compact = text.replace(/\s+/g, "");
  const fiveHour = findWindow(compact, LABELS.fiveHour, now);
  const sevenDay = findWindow(compact, LABELS.sevenDay, now);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, partial: /aren'tshownforthissign-in/i.test(compact) };
}
