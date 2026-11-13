import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

// Client-wide state for one host's copy of the plugin: the plugin context, requests to show a file
// in the Media panel, and the transfer list. Each connected host evaluates its own bundle, so this
// module state never mixes hosts.

let pluginClient: PluginClientContext | null = null;

export function setPluginClient(client: PluginClientContext | null): void {
  pluginClient = client;
}

export function getPluginClient(): PluginClientContext {
  if (!pluginClient) throw new Error("Media studio is not loaded");
  return pluginClient;
}

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The file each workspace's Media panel should show next; `seq` makes repeated requests distinct. */
const openRequests = createStore<ReadonlyMap<string, { path: string; seq: number }>>(new Map());
let nextSeq = 1;

/** Shows `path` in the Media panel of `workspaceId` and focuses the panel. */
export function openInMediaPanel(workspaceId: string, path: string | null): void {
  if (path) {
    const next = new Map(openRequests.get());
    next.set(workspaceId, { path, seq: nextSeq++ });
    openRequests.set(next);
  }
  getPluginClient().openPanel("media", { workspaceId });
}

export function useOpenRequest(workspaceId: string): { path: string; seq: number } | null {
  return useSyncExternalStore(openRequests.subscribe, () => openRequests.get().get(workspaceId) ?? null);
}

export interface Transfer {
  id: string;
  kind: "upload" | "download";
  name: string;
  /** Upload: destination folder. Download: the file. */
  target: string;
  total: number;
  done: number;
  /**
   * `retrying`: the connection dropped and the transfer waits to continue by itself.
   * `paused`: stopped by the user. `failed`: gave up; an upload keeps its bytes and can resume.
   */
  status: "running" | "retrying" | "paused" | "done" | "failed" | "canceled";
  error: string | null;
  /** When the next retry runs, while `retrying`. */
  retryAt: number | null;
  /** Bytes the host already had when this upload started, so a resume does not count them as sent. */
  resumedFrom: number;
  /** The uploaded file once it is in place. */
  resultPath: string | null;
  /** The daemon's ID for an upload, once known; matches its unfinished-upload entry. */
  uploadId: string | null;
  startedAt: number;
  cancel: (() => void) | null;
  pause: (() => void) | null;
  resume: (() => void) | null;
}

const transfers = createStore<readonly Transfer[]>([]);
let nextTransfer = 1;

export function addTransfer(transfer: Pick<Transfer, "kind" | "name" | "target" | "total"> & Partial<Transfer>): string {
  const id = String(nextTransfer++);
  transfers.set([
    {
      done: 0,
      status: "running",
      error: null,
      retryAt: null,
      resumedFrom: 0,
      resultPath: null,
      uploadId: null,
      cancel: null,
      pause: null,
      resume: null,
      ...transfer,
      id,
      startedAt: Date.now(),
    },
    ...transfers.get(),
  ]);
  return id;
}

export function updateTransfer(id: string, patch: Partial<Transfer>): void {
  transfers.set(transfers.get().map((transfer) => (transfer.id === id ? { ...transfer, ...patch } : transfer)));
}

export function dismissTransfer(id: string): void {
  transfers.set(transfers.get().filter((transfer) => transfer.id !== id));
}

export function clearFinishedTransfers(): void {
  transfers.set(transfers.get().filter((transfer) => transfer.status === "running"));
}

export function useTransfers(): readonly Transfer[] {
  return useSyncExternalStore(transfers.subscribe, transfers.get);
}

/** Listeners told when an upload lands, so folder views refresh. */
const uploadListeners = new Set<(path: string) => void>();

export function onUploaded(listener: (path: string) => void): () => void {
  uploadListeners.add(listener);
  return () => void uploadListeners.delete(listener);
}

export function notifyUploaded(path: string): void {
  for (const listener of uploadListeners) listener(path);
}
