// SPDX-License-Identifier: GPL-3.0-or-later
// Menu-triggered terminal copy/paste (Windows/Linux Edit menu — macOS uses the
// AppKit responder chain instead). Mirrors drop.ts: each Terminal registers its
// copy/paste closures keyed by pane id (they own the live PTY handle and
// bracketed-paste mode), and App routes the native "term_copy"/"term_paste"
// menu events — or their JS-fallback chords — to the focused pane's handlers.

export interface TermActions {
  copy: () => void;
  paste: () => void;
}

const handlers = new Map<string, TermActions>();

/** Register a pane's copy/paste handlers; returns an unregister fn for cleanup. */
export function registerTermActions(paneId: string, fns: TermActions): () => void {
  handlers.set(paneId, fns);
  return () => {
    // Only delete if we still own the slot (a remount may have replaced it).
    if (handlers.get(paneId) === fns) handlers.delete(paneId);
  };
}

/** Invoke an action on a pane; false when the pane has no handler. */
export function dispatchTermAction(paneId: string, action: keyof TermActions): boolean {
  const fns = handlers.get(paneId);
  if (!fns) return false;
  fns[action]();
  return true;
}
