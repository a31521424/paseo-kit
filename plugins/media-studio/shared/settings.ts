import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDefinition = defineSettings({
  id: "media-studio",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Empty: search PATH and the usual install folders. */
    ffmpegPath: z.string().default(""),
    ffprobePath: z.string().default(""),
    /** Workspace-relative folder for uploads made outside the folder browser. */
    uploadFolder: z.string().default("uploads"),
    /** Workspace-relative folder for frames saved from the player. */
    framesFolder: z.string().default(".media-studio/frames"),
    /** Give agents the preview_media tool. */
    agentTool: z.boolean().default(true),
    /** Comma-separated provider IDs that receive the tool. */
    agentToolProviders: z.string().default("claude, codex, opencode"),
    /** Add a card after each turn listing the media files the turn created or changed. */
    turnCards: z.boolean().default(true),
    quality: z.enum(["auto", "original", "1080", "720", "480"]).default("auto"),
    /** Convert with VideoToolbox (Mac) or NVENC (NVIDIA) when the host has a working one. */
    hardwareEncoding: z.boolean().default(true),
    /** SSH hosts whose files can be previewed as alias:/path. `*`: every alias in ~/.ssh/config. Empty: none. */
    remoteHosts: z.string().default("*"),
    /** ffmpeg on SSH hosts where it is not found by itself: `alias=/path/to/ffmpeg`, comma-separated. */
    remoteFfmpeg: z.string().default(""),
  }),
});

export type MediaStudioSettings = z.infer<typeof settingsDefinition.schema>;

export const DEFAULT_SETTINGS: MediaStudioSettings = settingsDefinition.schema.parse({});

export function parseProviders(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
