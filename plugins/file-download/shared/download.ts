import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Bytes per chunk; base64 keeps each RPC message under 6 MB, small enough for relays and proxies. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Largest file the plugin assembles in the browser's memory. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/** This daemon's server ID, so only the host that owns the open file answers the shortcut. */
export const hostRpc = defineRpc({
  name: "download.host",
  input: z.object({}),
  output: z.object({ serverId: z.string().nullable() }),
});

/** `path` is as the file tab holds it: absolute, under ~, or relative to the workspace directory. */
export const openRpc = defineRpc({
  name: "download.open",
  input: z.object({ workspaceId: z.string(), path: z.string() }),
  output: z.object({ transferId: z.string(), name: z.string(), size: z.number() }),
});

export const readRpc = defineRpc({
  name: "download.read",
  input: z.object({ transferId: z.string(), offset: z.number().int().nonnegative() }),
  output: z.object({ base64: z.string(), nextOffset: z.number(), done: z.boolean() }),
});

export const closeRpc = defineRpc({
  name: "download.close",
  input: z.object({ transferId: z.string() }),
  output: z.object({}),
});
