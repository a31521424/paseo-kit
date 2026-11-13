import { currentServerId } from "./transfers";
import { onPageHide, readStored, writeStored } from "./web";

// Where each file was left: playhead, in and out points, loop and speed. Paseo unmounts a panel
// when its tab is hidden, and a chat card when it scrolls away, so the player would start over on
// every return. Kept per daemon and file path (not version: after an agent re-renders a cut, the
// editor wants to look at the same moment again), in memory for this page and in local storage
// so a reload or a reopened app continues too.

export interface PlaybackMemory {
  time: number;
  inPoint: number | null;
  outPoint: number | null;
  loop: boolean;
  rate: number;
  /** The file version (modification time) this was saved for. */
  version?: string;
  savedAt: number;
}

const STORAGE_KEY = "paseo-media-studio:playback:v1";
const MEMORY_KEY = "__paseoMediaStudioPlayback";
const MAX_ENTRIES = 300;
/** A remembered position is dropped after this long without use. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Entries = Record<string, PlaybackMemory>;

/** Shared through globalThis, so a plugin reload (which re-evaluates this module) keeps it. */
function entries(): Entries {
  const holder = globalThis as unknown as Record<string, Entries | undefined>;
  if (!holder[MEMORY_KEY]) {
    const stored = readStored<Entries>(STORAGE_KEY) ?? {};
    const now = Date.now();
    for (const [key, value] of Object.entries(stored)) {
      if (!value || typeof value.time !== "number" || now - (value.savedAt ?? 0) > MAX_AGE_MS) delete stored[key];
    }
    holder[MEMORY_KEY] = stored;
  }
  return holder[MEMORY_KEY]!;
}

function keyOf(path: string): string {
  return `${currentServerId() ?? ""}\u0000${path}`;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushSoon(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 2000);
}

function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const all = entries();
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => all[a]!.savedAt - all[b]!.savedAt);
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[key];
  }
  writeStored(STORAGE_KEY, all);
}

let stopPageHide: (() => void) | null = null;

export function rememberedPlayback(path: string): PlaybackMemory | null {
  return entries()[keyOf(path)] ?? null;
}

export function rememberPlayback(path: string, memory: Omit<PlaybackMemory, "savedAt">, persistNow = false): void {
  stopPageHide ??= onPageHide(flush);
  entries()[keyOf(path)] = { ...memory, savedAt: Date.now() };
  if (persistNow) flush();
  else flushSoon();
}

export function forgetPlayback(path: string): void {
  delete entries()[keyOf(path)];
  flushSoon();
}

// The file that was playing when its full-size player went away, such as the Media panel when
// its tab was hidden. Coming back to it continues playing; opening anything else in a full-size
// player, or playing anything, clears it, so playback never starts by surprise.
let resumeOnReturn: { path: string; at: number; explicit: boolean } | null = null;
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * `explicit`: the user asked to continue in another file (A/B compare). A player unmounting right
 * after that does not overwrite it with its own path.
 */
export function markResumeOnReturn(path: string | null, explicit = false): void {
  const pending = resumeOnReturn;
  if (!explicit && path && pending?.explicit && Date.now() - pending.at < 3000) return;
  resumeOnReturn = path ? { path, at: Date.now(), explicit } : null;
}

/** True once for the file that should keep playing when its player mounts again. */
export function takeResumeOnReturn(path: string): boolean {
  const pending = resumeOnReturn;
  resumeOnReturn = null;
  return !!pending && pending.path === path && Date.now() - pending.at < RESUME_WINDOW_MS;
}
