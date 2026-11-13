// Plain values shared by the app and the daemon: file kinds, paths and time formatting.

export type MediaKind = "video" | "audio" | "image";

export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mov", "webm", "mkv", "avi", "mxf", "mts", "m2ts", "ts", "flv", "wmv", "mpg", "mpeg", "3gp", "ogv",
] as const;

export const AUDIO_EXTENSIONS = [
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff", "wma", "caf",
] as const;

export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff", "tga", "exr", "dpx", "heic", "heif", "avif",
] as const;

/** Images Paseo's own image panel does not open; the file panel claims only these. */
export const PANEL_IMAGE_EXTENSIONS = ["bmp", "tif", "tiff", "tga", "exr", "dpx", "heic", "heif", "avif"] as const;

/** Images a browser shows as they are, so the daemon can send the original bytes. */
export const BROWSER_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;

const KIND_BY_EXTENSION = new Map<string, MediaKind>([
  ...VIDEO_EXTENSIONS.map((ext) => [ext, "video"] as const),
  ...AUDIO_EXTENSIONS.map((ext) => [ext, "audio"] as const),
  ...IMAGE_EXTENSIONS.map((ext) => [ext, "image"] as const),
]);

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return ".";
  return index === 0 ? "/" : trimmed.slice(0, index);
}

/** Lowercase, without the dot; empty when the name has none. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

export function mediaKindOf(path: string): MediaKind | null {
  return KIND_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

/** POSIX join for display and for paths the daemon resolves again. */
export function joinPath(dir: string, name: string): string {
  if (!dir || dir === ".") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** `path` relative to `root` when it is inside it, else `path` unchanged. */
export function relativeTo(root: string | null | undefined, path: string): string {
  if (!root) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The timestamp of the frame that contains `seconds`. */
export function snapToFrame(seconds: number, fps: number | null): number {
  if (!fps || fps <= 0) return seconds;
  // A hundredth of a frame of slack: the end of a buffered range reads a hair short of the frame
  // boundary it stops at, and flooring that would step back a whole frame.
  return Math.floor(seconds * fps + 0.01) / fps;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * HH:MM:SS:FF when the frame rate is known, else HH:MM:SS.mmm. Frames count from zero within the
 * second, rounded to the nominal rate, so 29.97 fps footage reads like non-drop-frame timecode.
 */
export function formatTimecode(seconds: number, fps: number | null): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe + 1e-6);
  const hms = `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`;
  if (fps && fps > 0) {
    const nominal = Math.round(fps);
    const frame = Math.min(nominal - 1, Math.floor((safe - whole) * fps + 1e-6));
    return `${hms}:${pad(Math.max(0, frame))}`;
  }
  return `${hms}.${pad(Math.floor((safe - whole) * 1000 + 1e-6), 3)}`;
}

/**
 * Seconds from what someone types to jump: HH:MM:SS:FF (frames, with `fps`), HH:MM:SS, MM:SS or
 * plain seconds; the last field may have a decimal part. `+5` and `-2.5` are relative to `current`.
 * Null when it does not read as a time.
 */
export function parseTimecode(text: string, fps: number | null, current = 0): number | null {
  const value = text.trim().replace(/[;.](?=\d+$)/, (separator) => (separator === ";" ? ":" : "."));
  const relative = /^([+-])\s*(.+)$/.exec(value);
  if (relative) {
    const amount = parseTimecode(relative[2]!, fps, 0);
    return amount === null ? null : current + (relative[1] === "-" ? -amount : amount);
  }
  if (!/^\d+(?::\d+){0,3}(?:\.\d+)?$/.test(value)) return null;
  const parts = value.split(":");
  let frames = 0;
  if (parts.length === 4) {
    if (!fps || fps <= 0) return null;
    frames = Number(parts.pop());
    if (frames >= Math.round(fps)) return null;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part))) return null;
  // Minutes and seconds past 59 are refused, except in a single field (90 means 90 seconds).
  if (numbers.length > 1 && numbers.slice(1).some((part) => part >= 60)) return null;
  const seconds = numbers.reduce((total, part) => total * 60 + part, 0);
  return seconds + (fps && frames ? frames / fps : 0);
}

/** Timecode without the hours field when the media is shorter than an hour: MM:SS:FF. */
export function formatTimecodeShort(seconds: number, fps: number | null, duration: number | null): string {
  const full = formatTimecode(seconds, fps);
  return duration !== null && duration < 3600 ? full.slice(3) : full;
}

/** 1:02:03, 2:03, or 0:05 for short clips. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = whole % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatFps(fps: number | null | undefined): string {
  if (!fps) return "";
  return Number.isInteger(fps) ? `${fps} fps` : `${fps.toFixed(2)} fps`;
}
