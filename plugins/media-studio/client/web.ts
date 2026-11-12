// The only module that touches browser globals. Every export checks Platform.OS and does nothing
// elsewhere; the desktop app is a browser too. The plugin typechecks without the DOM library, so
// this file declares just the parts of the browser it uses.
import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";
import { snapToFrame } from "../shared/media";

export const isWeb = Platform.OS === "web";

interface Listenable {
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export interface VideoLike extends Listenable {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly buffered: TimeRangesLike;
  readonly isConnected: boolean;
  playbackRate: number;
  muted: boolean;
  volume: number;
  src: string;
  disableRemotePlayback?: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  requestVideoFrameCallback?(callback: (now: number, metadata: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

interface SourceBufferLike extends Listenable {
  readonly updating: boolean;
  readonly buffered: TimeRangesLike;
  mode: string;
  timestampOffset: number;
  appendBuffer(data: Uint8Array): void;
  remove(start: number, end: number): void;
  abort(): void;
  changeType?(type: string): void;
}

interface MediaSourceLike extends Listenable {
  readonly readyState: "closed" | "open" | "ended";
  duration: number;
  addSourceBuffer(type: string): SourceBufferLike;
  endOfStream(): void;
}

interface MediaSourceClass {
  new (): MediaSourceLike;
  isTypeSupported(type: string): boolean;
}

interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface DomElement extends Listenable {
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): void;
  remove(): void;
  click(): void;
  files?: ArrayLike<WebFile> | null;
  multiple?: boolean;
  type?: string;
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): unknown;
  contains?(other: unknown): boolean;
}

/** A file picked or dropped in the browser. */
export interface WebFile {
  readonly name: string;
  readonly size: number;
  /** Milliseconds since the epoch; part of how an interrupted upload recognizes its file. */
  readonly lastModified?: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

declare const window: Listenable & {
  MediaSource?: MediaSourceClass;
  ManagedMediaSource?: MediaSourceClass;
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableLike> }>;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
};
declare const document: Listenable & { createElement(tag: string): DomElement; body: DomElement; activeElement: DomElement | null };
declare const navigator: { platform?: string; userAgent?: string } | undefined;

/** Shortcut hints show ⌘ on macOS and Ctrl elsewhere. */
export const isMac = isWeb && /mac/i.test(navigator?.platform ?? navigator?.userAgent ?? "");

// React Native types Blob with string parts only; browsers also take binary ones.
const WebBlob = Blob as unknown as new (parts: readonly Uint8Array[], options: { type: string }) => Blob;

const H264_TYPE = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';

function mediaSourceClass(): MediaSourceClass | null {
  if (!isWeb) return null;
  return window.ManagedMediaSource ?? window.MediaSource ?? null;
}

/** Playback in this client needs Media Source Extensions: browsers and the desktop app have them. */
export function supportsStreaming(): boolean {
  return mediaSourceClass() !== null;
}

/** Whether H.264 video and AAC audio can be appended, so the daemon may skip converting. */
export function supportsH264(): boolean {
  const source = mediaSourceClass();
  try {
    return source ? source.isTypeSupported(H264_TYPE) : false;
  } catch {
    return false;
  }
}

/** A bare `<video>` element; the player drives it through the element `onElement` receives. */
export function VideoSurface({ onElement, hidden }: { onElement: (element: VideoLike | null) => void; hidden?: boolean }): ReactElement | null {
  if (!isWeb) return null;
  return createElement("video", {
    ref: onElement,
    playsInline: true,
    preload: "auto",
    disablePictureInPicture: false,
    style: hidden
      ? { width: 1, height: 1, opacity: 0, position: "absolute", pointerEvents: "none" }
      : { width: "100%", height: "100%", objectFit: "contain", backgroundColor: "#000", display: "block" },
  });
}

export interface StreamSession {
  sessionId: string;
  start: number;
  mimeType: string;
  mode: "copy" | "bridge" | "transcode" | "audio";
  width: number | null;
  height: number | null;
  encoder: string | null;
}

export interface StreamSource {
  open(start: number): Promise<StreamSession>;
  read(sessionId: string): Promise<{ bytes: Uint8Array; done: boolean }>;
  close(sessionId: string): void;
}

export interface PlayerEvents {
  onSession?(session: StreamSession): void;
  onBuffered?(ranges: [number, number][]): void;
  onError?(message: string | null): void;
}

function rangesOf(buffered: TimeRangesLike | undefined): [number, number][] {
  if (!buffered) return [];
  const ranges: [number, number][] = [];
  for (let index = 0; index < buffered.length; index += 1) ranges.push([buffered.start(index), buffered.end(index)]);
  return ranges;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Plays a daemon file through Media Source Extensions. It keeps `lookahead` seconds buffered past
 * the playhead, reading from one daemon session at a time; a seek outside the buffer closes that
 * session and opens one at the new time. Sessions report where their first sample sits, which
 * becomes the SourceBuffer timestampOffset, so data from different sessions lines up.
 */
export class StreamPlayer {
  private readonly mediaSource: MediaSourceLike;
  private readonly objectUrl: string;
  private buffer: SourceBufferLike | null = null;
  private mimeType: string | null = null;
  private session: StreamSession | null = null;
  /** The time the current session was opened for; a copy session starts earlier, at a keyframe. */
  private sessionTarget = 0;
  private destroyed = false;
  private wakeUp: (() => void) | null = null;
  /** Set while a read is in flight; a seek calls it so the loop can move on without that read. */
  private interruptRead: (() => void) | null = null;
  private readonly delivered = new WeakSet<StreamSession>();
  private stalledAt: number | null = null;
  private failures = 0;
  private waitingForSeek = false;
  /** Where playback should start; applied once the element knows the media. */
  private initialTime: number | null;

  constructor(
    private readonly video: VideoLike,
    private readonly source: StreamSource,
    private readonly duration: number,
    private readonly fps: number | null,
    private readonly lookahead: number,
    private readonly events: PlayerEvents,
    initialTime = 0,
  ) {
    this.initialTime = initialTime > 0 ? initialTime : null;
    const MediaSourceType = mediaSourceClass();
    if (!MediaSourceType) throw new Error("This client cannot stream media");
    this.mediaSource = new MediaSourceType();
    if (window.ManagedMediaSource) video.disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(this.mediaSource as unknown as Blob);
    this.mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (this.duration > 0) {
          try {
            this.mediaSource.duration = this.duration;
          } catch {
            // Some browsers refuse while a buffer exists; the media's own duration applies then.
          }
        }
        void this.run();
      },
      { once: true },
    );
    video.src = this.objectUrl;
    video.addEventListener("loadedmetadata", this.onMetadata);
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("timeupdate", this.wake);
    video.addEventListener("play", this.wake);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.video.removeEventListener("loadedmetadata", this.onMetadata);
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("timeupdate", this.wake);
    this.video.removeEventListener("play", this.wake);
    if (this.session) this.source.close(this.session.sessionId);
    this.session = null;
    this.wake();
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    } catch {
      // The element may already be gone.
    }
    URL.revokeObjectURL(this.objectUrl);
  }

  bufferedRanges(): [number, number][] {
    return rangesOf(this.buffer?.buffered);
  }

  private readonly wake = () => {
    const resolve = this.wakeUp;
    this.wakeUp = null;
    resolve?.();
  };

  private readonly onMetadata = () => {
    if (this.initialTime === null) return;
    const target = this.initialTime;
    this.initialTime = null;
    this.video.currentTime = target;
  };

  private readonly onSeeking = () => {
    this.stalledAt = null;
    this.waitingForSeek = false;
    this.failures = 0;
    this.events.onError?.(null);
    this.wake();
    this.interruptRead?.();
  };

  /**
   * The next piece of the session, or null when a seek moved somewhere the session will not
   * reach. A read waits on the host for data, up to a long poll; without this a seek would sit
   * behind the old session's read before opening a new one.
   */
  private async readOrSeek(session: StreamSession): Promise<{ bytes: Uint8Array; done: boolean } | null> {
    const read = this.source.read(session.sessionId);
    for (;;) {
      const interrupted = new Promise<null>((resolve) => {
        this.interruptRead = () => resolve(null);
      });
      const result = await Promise.race([read, interrupted]).finally(() => {
        this.interruptRead = null;
      });
      if (result) return result;
      const from = this.plan();
      if (from !== null && !this.keeps(session, from)) {
        read.catch(() => undefined);
        return null;
      }
    }
  }

  private sleep(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(() => this.wake(), ms);
      this.wakeUp = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Where the buffer should grow from next, or null when it is far enough ahead. */
  private plan(): number | null {
    const current = this.initialTime ?? this.video.currentTime;
    const end = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY;
    if (current >= end - 0.05) return null;
    const range = this.bufferedRanges().find(([start, stop]) => current >= start - 0.2 && current < stop - 0.05);
    const from = range ? range[1] : current;
    if (range && (range[1] >= end - 0.25 || range[1] - current >= this.lookahead)) return null;
    if (this.stalledAt !== null && Math.abs(from - this.stalledAt) < 0.1) return null;
    return from;
  }

  /** End of the buffered stretch the current session is extending. */
  private frontier(session: StreamSession): number {
    const range = this.bufferedRanges().find(([start, stop]) => session.start >= start - 0.3 && session.start <= stop + 0.3);
    return range ? range[1] : session.start;
  }

  /**
   * Whether the running session will deliver `from` without reopening. It does when it is extending
   * the stretch that ends at `from`, and also while it is still catching up to the time it was
   * opened for: a stream copy starts at the keyframe before that time, which in footage with long
   * GOPs can be ten seconds or more earlier, so the first reads land before the playhead.
   */
  private keeps(session: StreamSession, from: number): boolean {
    const frontier = this.frontier(session);
    if (Math.abs(frontier - from) <= 0.35) return true;
    const catchingUp = from >= session.start - 0.3 && frontier <= from + 0.35;
    return catchingUp && (Math.abs(from - this.sessionTarget) <= 0.5 || from - frontier <= 3);
  }

  private idle(): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || !buffer.updating) return Promise.resolve();
    return new Promise((resolve) => buffer.addEventListener("updateend", () => resolve(), { once: true }));
  }

  private async update(action: (buffer: SourceBufferLike) => void): Promise<void> {
    const buffer = this.buffer!;
    await this.idle();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(new Error("The browser could not decode this media"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);
      try {
        action(buffer);
      } catch (error) {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(error);
      }
    });
  }

  private async evict(): Promise<void> {
    const current = this.video.currentTime;
    if (current > 25) await this.update((buffer) => buffer.remove(0, current - 20));
    const far = current + this.lookahead + 20;
    const last = this.bufferedRanges().at(-1);
    if (last && last[1] > far) await this.update((buffer) => buffer.remove(far, Math.max(far + 1, last[1] + 1)));
  }

  private async append(bytes: Uint8Array): Promise<void> {
    try {
      await this.update((buffer) => buffer.appendBuffer(bytes));
    } catch (error) {
      if ((error as { name?: string }).name !== "QuotaExceededError") throw error;
      await this.evict();
      await this.update((buffer) => buffer.appendBuffer(bytes));
    }
  }

  private async openAt(from: number): Promise<StreamSession> {
    if (this.session) this.source.close(this.session.sessionId);
    this.session = null;
    const opened = performance.now();
    const session = await this.source.open(snapToFrame(from, this.fps));
    trace(`open ${from.toFixed(4)} → ${session.mode}${session.encoder ? `/${session.encoder}` : ""} start ${session.start.toFixed(3)} in ${Math.round(performance.now() - opened)} ms`);
    if (this.destroyed) {
      this.source.close(session.sessionId);
      return session;
    }
    if (!this.buffer) {
      this.buffer = this.mediaSource.addSourceBuffer(session.mimeType);
      this.buffer.mode = "segments";
    } else {
      await this.idle();
      // Drops the half box the previous session may have left, so the new init segment parses.
      if (this.mediaSource.readyState === "open") this.buffer.abort();
      if (session.mimeType !== this.mimeType && this.buffer.changeType) this.buffer.changeType(session.mimeType);
    }
    this.mimeType = session.mimeType;
    this.buffer.timestampOffset = session.start;
    this.session = session;
    this.sessionTarget = from;
    this.events.onSession?.(session);
    return session;
  }

  private finishIfComplete(): void {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || this.mediaSource.readyState !== "open" || this.duration <= 0) return;
    const current = this.video.currentTime;
    const range = this.bufferedRanges().find(([start, stop]) => current >= start - 0.2 && current <= stop + 0.05);
    if (range && range[1] >= this.duration - 0.3) {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // A later append reopens the source; nothing to do.
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.destroyed) {
      if (this.waitingForSeek) {
        await this.sleep(null);
        continue;
      }
      try {
        const from = this.plan();
        if (from === null) {
          this.finishIfComplete();
          await this.sleep(1000);
          continue;
        }
        let session = this.session;
        if (!session || !this.keeps(session, from)) session = await this.openAt(from);
        if (this.destroyed) break;
        const before = this.frontier(session);
        const reading = performance.now();
        const piece = await this.readOrSeek(session);
        if (!piece || this.destroyed || this.session !== session) continue;
        const { bytes, done } = piece;
        if (bytes.length > 0) {
          await this.append(bytes);
          this.delivered.add(session);
        }
        trace(`read ${bytes.length} B in ${Math.round(performance.now() - reading)} ms${done ? " (done)" : ""}, frontier ${this.frontier(session).toFixed(2)}`);
        if (done) {
          this.session = null;
          // A session that ends after delivering media (a bridge stops at the next keyframe) is
          // followed by the next one; only one that ends with nothing at all marks a dead end.
          if (!this.delivered.has(session) && this.frontier(session) <= before + 0.05) this.stalledAt = from;
        }
        this.failures = 0;
        this.events.onBuffered?.(this.bufferedRanges());
      } catch (error) {
        if (this.destroyed) break;
        const message = errorMessage(error);
        this.session = null;
        if (/expired/i.test(message)) continue;
        this.failures += 1;
        if (this.failures >= 2) {
          this.events.onError?.(message);
          this.waitingForSeek = true;
        } else {
          await this.sleep(800);
        }
      }
    }
  }
}

/** Stream timings in the console when `globalThis.__mediaStudioDebug` is set. */
function trace(message: string): void {
  if ((globalThis as { __mediaStudioDebug?: boolean }).__mediaStudioDebug) console.log(`media-studio stream: @${Math.round(performance.now())} ${message}`);
}

/** Full screen for the element behind a view; ignored where the browser refuses. */
export function toggleFullscreen(element: unknown): void {
  if (!isWeb || !element) return;
  const doc = document as unknown as { fullscreenElement: unknown; exitFullscreen?: () => Promise<void> };
  if (doc.fullscreenElement) {
    void doc.exitFullscreen?.().catch(() => undefined);
    return;
  }
  const target = element as { requestFullscreen?: () => Promise<void> };
  void target.requestFullscreen?.().catch(() => undefined);
}

/** Calls `callback` with the media time of every presented frame while the element plays. */
export function watchFrames(video: VideoLike, callback: (time: number) => void): () => void {
  if (!isWeb) return () => {};
  let active = true;
  let handle = 0;
  if (video.requestVideoFrameCallback) {
    const step = (_now: number, metadata: { mediaTime: number }) => {
      if (!active) return;
      callback(metadata.mediaTime);
      handle = video.requestVideoFrameCallback!(step);
    };
    handle = video.requestVideoFrameCallback(step);
    return () => {
      active = false;
      video.cancelVideoFrameCallback?.(handle);
    };
  }
  const tick = () => {
    if (!active) return;
    callback(video.currentTime);
    handle = window.requestAnimationFrame(tick);
  };
  handle = window.requestAnimationFrame(tick);
  return () => {
    active = false;
    window.cancelAnimationFrame(handle);
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Opens the browser's file picker. Resolves with nothing when the user closes it. */
export function pickFiles(): Promise<WebFile[]> {
  if (!isWeb) return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    let settled = false;
    const done = (files: WebFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Accepts files dragged onto `node`, the element behind a React Native view on the web. Returns
 * the cleanup, or a no-op when `node` is not an element.
 */
export function attachDropTarget(
  node: unknown,
  handlers: { onFiles(files: WebFile[]): void; onHover(active: boolean): void },
): () => void {
  if (!isWeb || !node || typeof (node as Listenable).addEventListener !== "function") return () => {};
  const element = node as Listenable & { contains?(other: unknown): boolean };
  let depth = 0;
  const hasFiles = (event: { dataTransfer?: { types?: ArrayLike<string> } }) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onEnter = (event: any) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    handlers.onHover(true);
  };
  const onOver = (event: any) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onLeave = (event: any) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) handlers.onHover(false);
  };
  const onDrop = (event: any) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    handlers.onHover(false);
    const files = Array.from((event.dataTransfer?.files ?? []) as ArrayLike<WebFile>);
    if (files.length > 0) handlers.onFiles(files);
  };
  element.addEventListener("dragenter", onEnter);
  element.addEventListener("dragover", onOver);
  element.addEventListener("dragleave", onLeave);
  element.addEventListener("drop", onDrop);
  return () => {
    element.removeEventListener("dragenter", onEnter);
    element.removeEventListener("dragover", onOver);
    element.removeEventListener("dragleave", onLeave);
    element.removeEventListener("drop", onDrop);
  };
}

/** Files up to this size download through the browser's own flow, straight to Downloads. */
const MEMORY_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Largest file assembled in memory when the browser cannot write to disk as it goes. */
const MAX_MEMORY_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface SaveSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export class SaveCanceledError extends Error {
  constructor() {
    super("Canceled");
    this.name = "SaveCanceledError";
  }
}

/**
 * Where a download goes. Large files are written to disk piece by piece through the save dialog
 * where the browser has one (Chrome, Edge, the desktop app); everything else is collected in
 * memory and handed to the browser's download flow. Call it straight from the press handler:
 * browsers only show the save dialog during a user gesture.
 */
export async function openSaveSink(name: string, size: number): Promise<SaveSink> {
  if (!isWeb) throw new Error("Downloads work in the desktop app and browsers");
  if (size > MEMORY_DOWNLOAD_BYTES && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      return {
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
        abort: () => writable.abort().catch(() => undefined),
      };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw new SaveCanceledError();
      // No dialog available here (an embedded or headless browser); collect in memory instead.
    }
  }
  if (size > MAX_MEMORY_DOWNLOAD_BYTES) {
    throw new Error("This browser cannot save files larger than 2 GB. Use the desktop app or Chrome.");
  }
  const parts: Uint8Array[] = [];
  return {
    async write(bytes) {
      parts.push(bytes);
    },
    async close() {
      const url = URL.createObjectURL(new WebBlob(parts, { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", name);
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      parts.length = 0;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      parts.length = 0;
    },
  };
}

export interface KeyInfo {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
}

function isEditable(target: DomElement | null): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
}

interface Rectangular {
  getClientRects?(): ArrayLike<unknown>;
  contains?(other: unknown): boolean;
}

/** Whether the element behind a view is laid out on screen; false inside a hidden tab. */
export function isShown(element: unknown): boolean {
  if (!isWeb || !element) return false;
  const rects = (element as Rectangular).getClientRects?.();
  return !!rects && rects.length > 0;
}

/** Nothing else has keyboard focus: the page itself, or something inside `root`, has it. */
export function focusIsFree(root: unknown): boolean {
  if (!isWeb) return false;
  const active = document.activeElement as unknown;
  if (!active || active === (document.body as unknown)) return true;
  return !!root && !!(root as Rectangular).contains?.(active);
}

/**
 * Keyboard shortcuts for the player that was used last. `handler` returns true when it used the
 * key. Keys typed into text fields, or with Cmd or Ctrl held, are left alone.
 */
export function listenForKeys(handler: (key: KeyInfo) => boolean): () => void {
  if (!isWeb) return () => {};
  const listener = (event: any) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
    if (isEditable(event.target as DomElement | null) || isEditable(document.activeElement)) return;
    if (handler(event as KeyInfo)) event.preventDefault();
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

/** JSON from the browser's local storage, or null where there is none (native apps, private mode). */
export function readStored<T>(key: string): T | null {
  if (!isWeb) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  if (!isWeb) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or unavailable storage: the memory is a convenience.
  }
}

/** Runs `callback` when the page is about to be hidden or unloaded. */
export function onPageHide(callback: () => void): () => void {
  if (!isWeb) return () => {};
  const listener = () => callback();
  window.addEventListener("pagehide", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("pagehide", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}
