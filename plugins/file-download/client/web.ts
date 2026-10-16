// The only module that touches browser globals. Every export checks Platform.OS and does nothing
// elsewhere; the desktop app is a browser too and loads the same routes under paseo://app.
import { Platform } from "react-native";

interface DomElement {
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  appendChild(child: DomElement): void;
  remove(): void;
  click(): void;
}

interface KeyEvent {
  key?: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

declare const document: { createElement(tag: string): DomElement; body: DomElement };
declare const window: {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};
declare const location: { pathname: string };
declare const localStorage: { getItem(key: string): string | null };
declare const navigator: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined;

// React Native types Blob with string parts only; browsers also take binary ones.
const WebBlob = Blob as unknown as new (parts: readonly Uint8Array[], options: { type: string }) => Blob;

export const isWeb = Platform.OS === "web";

const isMac =
  isWeb && /mac/i.test(navigator?.userAgentData?.platform ?? navigator?.platform ?? navigator?.userAgent ?? "");

/** The save shortcut as this platform writes it. */
export const SAVE_SHORTCUT = isMac ? "⌘S" : "Ctrl+S";

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Hands the bytes to the browser's download flow under the given file name. */
export function saveFile(parts: readonly Uint8Array[], name: string): void {
  if (!isWeb) return;
  const url = URL.createObjectURL(new WebBlob(parts, { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", name);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has its own reference by now; give slow browsers a moment anyway.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Calls `onSave` for Cmd+S on macOS and Ctrl+S elsewhere. A key press something else already
 * handled, such as the file editor saving its changes, is left alone.
 */
export function listenForSaveShortcut(onSave: (event: KeyEvent) => void): () => void {
  if (!isWeb) return () => {};
  const listener = (event: KeyEvent) => {
    if (event.defaultPrevented || event.repeat || event.shiftKey || event.altKey) return;
    // The physical S key, so the shortcut also works on layouts where it types another letter.
    // Autofill dispatches keydown events without a key, hence the fallbacks.
    if (event.code !== "KeyS" && (event.key ?? "").toLowerCase() !== "s") return;
    if (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    onSave(event);
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

export interface FocusedTab {
  serverId: string;
  workspaceId: string;
  /** Set when the focused tab is a file preview. */
  filePath: string | null;
}

interface LayoutNode {
  kind?: string;
  pane?: { id?: string; focusedTabId?: string; tabs?: { tabId?: string; target?: { kind?: string; path?: string } }[] };
  group?: { children?: LayoutNode[] };
}

/**
 * The focused tab of the workspace on screen. Paseo has no plugin API for it, so this reads the tab
 * layout the app persists in local storage, which it updates as soon as tabs change. Null outside a
 * workspace or when that private format cannot be read.
 */
export function readFocusedTab(): FocusedTab | null {
  if (!isWeb) return null;
  try {
    const route = /^\/h\/([^/]+)\/workspace\/([^/?#]+)/.exec(location.pathname);
    if (!route) return null;
    const serverId = decodeURIComponent(route[1] ?? "");
    const workspaceId = decodeURIComponent(route[2] ?? "");
    const raw = localStorage.getItem("workspace-layout-state");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: unknown };
    const state = (parsed.state ?? parsed) as {
      layoutByWorkspace?: Record<string, { root?: LayoutNode; focusedPaneId?: string }>;
    };
    const layouts = state.layoutByWorkspace ?? {};
    const layout =
      layouts[`${serverId}:${workspaceId}`] ??
      Object.entries(layouts).find(([key]) => key.endsWith(`:${workspaceId}`))?.[1];
    if (!layout) return { serverId, workspaceId, filePath: null };
    const panes: NonNullable<LayoutNode["pane"]>[] = [];
    const walk = (node: LayoutNode | undefined) => {
      if (!node) return;
      if (node.kind === "pane" && node.pane) panes.push(node.pane);
      if (node.kind === "group") node.group?.children?.forEach(walk);
    };
    walk(layout.root);
    const pane = panes.find((candidate) => candidate.id === layout.focusedPaneId);
    const target = pane?.tabs?.find((tab) => tab.tabId === pane.focusedTabId)?.target;
    const filePath = target?.kind === "file" && typeof target.path === "string" ? target.path : null;
    return { serverId, workspaceId, filePath };
  } catch {
    return null;
  }
}
