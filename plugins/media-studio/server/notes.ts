import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewNote } from "../shared/rpc";

// Review notes sent from the player, kept per file on the daemon host so every client sees the
// same history and the same timeline markers. Notes are keyed by the file's path; each remembers
// the file version it was written about, so the player can mark notes on an earlier render.

const NOTES_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paseo-media-studio", "notes");
const MAX_NOTES = 500;

function notesFile(ref: string): string {
  return path.join(NOTES_DIR, `${createHash("sha1").update(ref).digest("hex")}.json`);
}

export async function listNotes(ref: string): Promise<ReviewNote[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(notesFile(ref), "utf8")) as { notes?: ReviewNote[] };
    return parsed.notes ?? [];
  } catch {
    return [];
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Appends a note; writes for one file run one at a time so none is lost. */
export function addNote(ref: string, note: Omit<ReviewNote, "id" | "createdAt">): Promise<ReviewNote> {
  const run = async () => {
    const notes = await listNotes(ref);
    const created: ReviewNote = { ...note, id: randomUUID(), createdAt: new Date().toISOString() };
    notes.push(created);
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const file = notesFile(ref);
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ path: ref, notes: notes.slice(-MAX_NOTES) }));
    await fs.rename(temp, file);
    return created;
  };
  const next = (queues.get(ref) ?? Promise.resolve()).then(run, run);
  queues.set(ref, next.catch(() => undefined));
  return next;
}

export async function removeNote(ref: string, id: string): Promise<void> {
  const run = async () => {
    const notes = (await listNotes(ref)).filter((note) => note.id !== id);
    await fs.mkdir(NOTES_DIR, { recursive: true });
    await fs.writeFile(notesFile(ref), JSON.stringify({ path: ref, notes }));
  };
  const next = (queues.get(ref) ?? Promise.resolve()).then(run, run);
  queues.set(ref, next.catch(() => undefined));
  await next;
}
