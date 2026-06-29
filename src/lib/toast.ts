// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from "zustand";

// Transient, non-blocking confirmation feedback ("Copied path", "Committed").
// The counterpart to the modal dialog system (lib/dialog.ts): a dialog blocks and
// demands a choice; a toast just acknowledges an action whose effect the user
// can't otherwise see land (a clipboard write, a HEAD move, a commit clearing the
// list). Hard errors keep going through the Sidebar banner (store.error) so the
// two surfaces don't compete — toasts carry success/info, plus the occasional
// soft failure (a denied clipboard write) that has no banner of its own.
export type ToastKind = "success" | "info" | "error";

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

// At most this many on screen at once: a burst (rapid copies) keeps only the most
// recent so the stack can't march up the screen.
const MAX_TOASTS = 4;

interface ToastState {
  toasts: Toast[];
  push: (message: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = "success") =>
    set((s) => ({ toasts: [...s.toasts, { id: ++seq, message, kind }].slice(-MAX_TOASTS) })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Imperative entry point so non-React call sites (the clipboard helper, the store
// git-ops) can fire a toast without a hook — exactly like confirmDialog/promptDialog.
export function toast(message: string, kind: ToastKind = "success"): void {
  useToastStore.getState().push(message, kind);
}
