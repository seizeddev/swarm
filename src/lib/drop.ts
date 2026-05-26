// SPDX-License-Identifier: GPL-3.0-or-later
// File drag-and-drop into a terminal pane. Tauri's webview drag-drop event is
// global (one per webview) and carries real absolute paths + a drop position, so
// App owns the listener, hit-tests the drop point to a pane, and routes the paths
// here. Each Terminal registers a handler keyed by its pane id; the handler (a
// closure in the component) has the live PTY id and bracketed-paste mode, so the
// drop is pasted exactly like a clipboard paste — one event a TUI can attach.

type DropHandler = (paths: string[]) => void;

const handlers = new Map<string, DropHandler>();

/** Register a pane's drop handler; returns an unregister fn for cleanup. */
export function registerDrop(paneId: string, fn: DropHandler): () => void {
  handlers.set(paneId, fn);
  return () => {
    // Only delete if we still own the slot (a remount may have replaced it).
    if (handlers.get(paneId) === fn) handlers.delete(paneId);
  };
}

/** Deliver dropped paths to the pane under the cursor, if it has a handler. */
export function dispatchDrop(paneId: string, paths: string[]): boolean {
  const fn = handlers.get(paneId);
  if (!fn) return false;
  fn(paths);
  return true;
}

// Shell-quote a path so spaces and metacharacters survive when it lands in a
// shell or a TUI's input. Bare-safe paths pass through unquoted; everything else
// is single-quoted with embedded single-quotes escaped the POSIX way ('\'').
export function quotePath(p: string): string {
  if (p === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

/** Join multiple dropped paths into one space-separated, quoted string. */
export function joinPaths(paths: string[]): string {
  return paths.map(quotePath).join(" ");
}
