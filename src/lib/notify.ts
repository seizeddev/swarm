// SPDX-License-Identifier: GPL-3.0-or-later
// Native OS notifications (multi-platform, with sound, click-to-focus). Emitted
// by the Rust `notify_os` command rather than tauri-plugin-notification: the
// plugin's desktop backend exposes no click callback, and we want a click to
// focus the window and open the originating pane. The store fires these only
// when the swarm window is in the background — an in-app badge is useless when
// you can't see it.
//
// Inspired by cmux's model (always record in-app; raise an OS banner only when
// the user isn't already looking, click jumps to the pane) — our own
// implementation, no code shared (cmux is GPL/commercial dual-licensed).
import { api } from "./ipc";
import { isMac, isWindows } from "./platform";

// The "plop". Per-platform because the sound field means different things on
// each OS:
//   - macOS: a named system sound from /System/Library/Sounds. "Pop" is the
//     soft bubble plop (what cmux's default sounds like) — NOT the iOS-style
//     tri-tone the generic "default" maps to.
//   - Linux: an XDG sound-theme name.
//   - Windows: the toast uses its system default sound (the Rust side ignores
//     this), so leave it undefined.
function plopSound(): string | undefined {
  if (isMac) return "Pop";
  if (isWindows) return undefined;
  return "message-new-instant";
}

/**
 * Post a native notification with the system sound. Clicking it focuses the
 * window and opens the pane (handled in Rust + the `notif:activate` listener).
 * Swallows errors so a build without the command / a non-Tauri test env is a
 * no-op; in-app notifications still work.
 */
export async function notifyOS(
  title: string,
  body: string,
  paneId: string,
  workspaceId: string,
): Promise<void> {
  try {
    await api.notifyOs(title, body, plopSound(), paneId, workspaceId);
  } catch {
    /* no backend / non-tauri env — ignore */
  }
}
