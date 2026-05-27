// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from "zustand";

/**
 * Promise-based dialog service. Replaces the native window.confirm/prompt —
 * which WKWebView renders as out-of-place OS chrome and which, crucially, block
 * the JS thread. `confirmDialog`/`promptDialog` return a Promise that DialogHost
 * settles when the user answers, so they work both inside React and from plain
 * code (store.ts, Terminal.tsx) that can't render a component.
 *
 * Requests are queued FIFO: a second call while one is open waits its turn
 * rather than clobbering the first (or stacking overlapping modals).
 */

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the confirm button as danger (irreversible action). */
  destructive?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  defaultValue?: string;
}

export type DialogRequest =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (value: string | null) => void };

interface DialogState {
  current: DialogRequest | null;
  queue: DialogRequest[];
  /** Internal: enqueue a request, promoting it to `current` if nothing is open. */
  enqueue: (request: DialogRequest) => void;
  /** Settle the open request with the user's answer, then promote the next. */
  resolveCurrent: (value: boolean | string | null) => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,
  queue: [],
  enqueue: (request) =>
    set((s) => (s.current ? { queue: [...s.queue, request] } : { current: request })),
  resolveCurrent: (value) => {
    const { current, queue } = get();
    if (!current) return;
    // Each request's resolve is typed to its kind; the caller always supplies a
    // matching value (boolean for confirm, string|null for prompt).
    (current.resolve as (v: boolean | string | null) => void)(value);
    const [next, ...rest] = queue;
    set({ current: next ?? null, queue: rest });
  },
}));

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useDialogStore.getState().enqueue({ kind: "confirm", opts, resolve });
  });
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useDialogStore.getState().enqueue({ kind: "prompt", opts, resolve });
  });
}
