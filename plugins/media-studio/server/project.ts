import type { ProjectSummary } from "../shared/rpc";
import { scanMedia } from "./files";

const CACHE_MS = 60_000;
/** Video or audio at least this big is footage, a render or a mix rather than a UI sound or a test fixture. */
const MIN_MEDIA_BYTES = 256 * 1024;
/** Stills only count as a media project in numbers; a web app ships a few icons and screenshots. */
const MIN_IMAGES = 20;

const cache = new Map<string, { at: number; summary: Promise<ProjectSummary> }>();

async function summarize(dir: string): Promise<ProjectSummary> {
  // Small budget: this runs for every open agent, and only has to tell media folders from code.
  const { files } = await scanMedia(dir, { maxEntries: 8000, maxDepth: 5, budgetMs: 800 }).catch(() => ({ files: [] }));
  let video = 0;
  let audio = 0;
  let image = 0;
  let substantial = false;
  for (const file of files) {
    if (file.kind === "video") video += 1;
    else if (file.kind === "audio") audio += 1;
    else image += 1;
    if (file.kind !== "image" && file.size >= MIN_MEDIA_BYTES) substantial = true;
  }
  return { dir, video, audio, image, isMedia: substantial || image >= MIN_IMAGES };
}

export async function projectSummaries(dirs: string[], fresh = false): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (fresh) for (const dir of dirs) cache.delete(dir);
  for (const [dir, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(dir);
  return Promise.all(
    [...new Set(dirs)].map((dir) => {
      let entry = cache.get(dir);
      if (!entry) {
        entry = { at: now, summary: summarize(dir) };
        cache.set(dir, entry);
      }
      return entry.summary;
    }),
  );
}
