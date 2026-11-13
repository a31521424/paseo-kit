import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Bytes per transfer chunk. Paseo 0.15 plugin RPC carries JSON only, so bytes travel as base64:
 * 4 MB becomes about 5.6 MB per message, which relays, reverse proxies and tunnels accept.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Upload pieces start at multiples of this, so an SSH host can write them with `dd`. */
export const UPLOAD_ALIGN_BYTES = 256 * 1024;
/** Most bytes one playback read returns. Small enough that the first frames arrive quickly. */
export const STREAM_READ_BYTES = 2 * 1024 * 1024;

/**
 * A file the daemon resolves: absolute, under `~`, or relative to `cwd` (an agent's or workspace's
 * directory). Every answer carries the resolved absolute path for later calls.
 */
const fileRef = {
  path: z.string().min(1),
  cwd: z.string().nullish(),
};

export const mediaKindSchema = z.enum(["video", "audio", "image"]);

export const mediaInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: mediaKindSchema,
  size: z.number(),
  modifiedAt: z.string(),
  duration: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  sampleRate: z.number().nullable(),
  channels: z.number().nullable(),
  bitRate: z.number().nullable(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
});
export type MediaInfo = z.infer<typeof mediaInfoSchema>;

const imageOutput = z.object({ base64: z.string(), mimeType: z.string() });
export type ImageData = z.infer<typeof imageOutput>;

const toolsSchema = z.object({
  ffmpeg: z.string().nullable(),
  ffprobe: z.string().nullable(),
  version: z.string().nullable(),
  encoders: z.array(z.string()),
});

/** The daemon host's tools and the SSH hosts media can come from. */
export const statusRpc = defineRpc({
  name: "media.status",
  input: z.object({}),
  output: z.object({
    local: toolsSchema,
    home: z.string(),
    /** The daemon's server ID, so a reloaded app bundle only adopts uploads meant for this host. */
    serverId: z.string().nullable(),
    remoteHosts: z.array(z.string()),
    sshAliases: z.array(z.string()),
  }),
});

/** Connects to one SSH host and reports its tools; slow the first time. */
export const hostCheckRpc = defineRpc({
  name: "media.host.check",
  input: z.object({ host: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), tools: toolsSchema.nullable(), home: z.string().nullable() }),
});

export const probeRpc = defineRpc({
  name: "media.probe",
  input: z.object(fileRef),
  output: mediaInfoSchema,
});

/** Cheap change check for players that reload when an agent rewrites the file. */
export const statRpc = defineRpc({
  name: "media.stat",
  input: z.object(fileRef),
  output: z.object({ path: z.string(), exists: z.boolean(), size: z.number(), modifiedAt: z.string() }),
});

export const posterRpc = defineRpc({
  name: "media.poster",
  input: z.object({ ...fileRef, width: z.number().int().min(32).max(1920) }),
  output: imageOutput.nullable(),
});

export const frameRpc = defineRpc({
  name: "media.frame",
  input: z.object({ ...fileRef, time: z.number().nonnegative(), width: z.number().int().min(32).max(3840) }),
  output: imageOutput,
});

export const filmstripRpc = defineRpc({
  name: "media.filmstrip",
  input: z.object({ ...fileRef, count: z.number().int().min(1).max(40), width: z.number().int().min(32).max(480) }),
  output: z.object({ frames: z.array(z.object({ time: z.number(), base64: z.string() })) }),
});

export const waveformRpc = defineRpc({
  name: "media.waveform",
  input: z.object({ ...fileRef, buckets: z.number().int().min(16).max(2000) }),
  output: z.object({ peaks: z.array(z.number()) }),
});

/** Delivery loudness of the first audio track: integrated LUFS, true peak and loudness range. */
export const loudnessRpc = defineRpc({
  name: "media.loudness",
  input: z.object({ ...fileRef }),
  output: z.object({ integrated: z.number().nullable(), truePeak: z.number().nullable(), range: z.number().nullable() }),
});

/** The picture itself for the image viewer: original bytes when a browser can show them. */
export const imageRpc = defineRpc({
  name: "media.image",
  input: z.object({ ...fileRef, maxSize: z.number().int().min(64).max(8192) }),
  output: z.object({ base64: z.string(), mimeType: z.string(), converted: z.boolean() }),
});

export const qualitySchema = z.enum(["auto", "original", "1080", "720", "480"]);
export type Quality = z.infer<typeof qualitySchema>;

export const streamOpenRpc = defineRpc({
  name: "media.stream.open",
  input: z.object({
    ...fileRef,
    start: z.number().nonnegative(),
    quality: qualitySchema,
    /** Whether this client's MediaSource plays H.264 and AAC, so the daemon may send video as it is. */
    h264: z.boolean(),
  }),
  output: z.object({
    sessionId: z.string(),
    /** Media time of the first sample; the client sets it as the SourceBuffer timestampOffset. */
    start: z.number(),
    mimeType: z.string(),
    /** `bridge`: a near-lossless encode from the seek point to the next keyframe, then copy resumes. */
    mode: z.enum(["copy", "bridge", "transcode", "audio"]),
    width: z.number().nullable(),
    height: z.number().nullable(),
    encoder: z.string().nullable(),
  }),
});

export const streamReadRpc = defineRpc({
  name: "media.stream.read",
  input: z.object({ sessionId: z.string() }),
  output: z.object({ base64: z.string(), done: z.boolean() }),
});

export const streamCloseRpc = defineRpc({
  name: "media.stream.close",
  input: z.object({ sessionId: z.string() }),
  output: z.object({}),
});

export const entrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["video", "audio", "image", "directory"]),
  size: z.number(),
  modifiedAt: z.string(),
});
export type MediaEntry = z.infer<typeof entrySchema>;

export const listRpc = defineRpc({
  name: "media.list",
  input: z.object({
    /** A folder on the daemon host, or alias:/path on an SSH host. */
    root: z.string().min(1),
    /** `recent`: media anywhere under root, newest first. `folder`: one folder, folders first. */
    mode: z.enum(["recent", "folder"]),
    dir: z.string().nullish(),
    limit: z.number().int().min(1).max(1000).default(300),
  }),
  output: z.object({ dir: z.string(), entries: z.array(entrySchema), truncated: z.boolean() }),
});

/** Saves the frame at `time` as a PNG in the workspace, so an agent can open it. */
export const grabRpc = defineRpc({
  name: "media.grab",
  input: z.object({ ...fileRef, time: z.number().nonnegative(), root: z.string().min(1) }),
  output: z.object({ path: z.string(), base64: z.string(), mimeType: z.string() }),
});

/** Byte ranges `[start, end)` of an upload that are on the host, merged and sorted. */
const rangesSchema = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]));
export type ByteRange = [number, number];

/**
 * Starts or resumes an upload. The same file (name, size, modification time) to the same folder
 * always gets the same upload, so after a dropped connection, a page reload or a daemon restart the
 * answer lists the ranges already on the host and the app sends only the rest.
 */
export const uploadBeginRpc = defineRpc({
  name: "upload.begin",
  /** `dir`: absolute folder on the daemon host, or alias:/path on an SSH host. */
  input: z.object({
    dir: z.string().min(1),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    lastModified: z.number().int().nonnegative().nullish(),
  }),
  output: z.object({ uploadId: z.string(), received: rangesSchema, receivedBytes: z.number(), resumed: z.boolean() }),
});

export const uploadWriteRpc = defineRpc({
  name: "upload.write",
  input: z.object({ uploadId: z.string(), offset: z.number().int().nonnegative(), base64: z.string() }),
  output: z.object({ received: z.number() }),
});

export const uploadFinishRpc = defineRpc({
  name: "upload.finish",
  input: z.object({ uploadId: z.string() }),
  output: z.object({ path: z.string() }),
});

/** Discards an upload and the bytes already sent. */
export const uploadAbortRpc = defineRpc({
  name: "upload.abort",
  input: z.object({ uploadId: z.string() }),
  output: z.object({}),
});

export const pendingUploadSchema = z.object({
  uploadId: z.string(),
  dir: z.string(),
  name: z.string(),
  size: z.number(),
  lastModified: z.number().nullable(),
  receivedBytes: z.number(),
  updatedAt: z.string(),
});
export type PendingUpload = z.infer<typeof pendingUploadSchema>;

/** Unfinished uploads under `root` (a folder or alias:/path), newest first. */
export const uploadPendingRpc = defineRpc({
  name: "upload.pending",
  input: z.object({ root: z.string().nullish() }),
  output: z.object({ uploads: z.array(pendingUploadSchema) }),
});

export const downloadOpenRpc = defineRpc({
  name: "download.open",
  input: z.object(fileRef),
  output: z.object({ transferId: z.string(), path: z.string(), name: z.string(), size: z.number() }),
});

export const downloadReadRpc = defineRpc({
  name: "download.read",
  input: z.object({ transferId: z.string(), offset: z.number().int().nonnegative() }),
  output: z.object({ base64: z.string() }),
});

export const downloadCloseRpc = defineRpc({
  name: "download.close",
  input: z.object({ transferId: z.string() }),
  output: z.object({}),
});

export const reviewNoteSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** File modification time when the note was written; differs once the file is rendered again. */
  fileModifiedAt: z.string(),
  time: z.number(),
  inPoint: z.number().nullable(),
  outPoint: z.number().nullable(),
  text: z.string(),
  agentTitle: z.string().nullable(),
  framePath: z.string().nullable(),
});
export type ReviewNote = z.infer<typeof reviewNoteSchema>;

export const notesListRpc = defineRpc({
  name: "notes.list",
  input: z.object({ path: z.string().min(1) }),
  output: z.object({ notes: z.array(reviewNoteSchema) }),
});

export const notesAddRpc = defineRpc({
  name: "notes.add",
  input: z.object({ path: z.string().min(1), note: reviewNoteSchema.omit({ id: true, createdAt: true }) }),
  output: reviewNoteSchema,
});

export const notesRemoveRpc = defineRpc({
  name: "notes.remove",
  input: z.object({ path: z.string().min(1), id: z.string() }),
  output: z.object({}),
});
