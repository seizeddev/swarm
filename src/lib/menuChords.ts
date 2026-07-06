// SPDX-License-Identifier: GPL-3.0-or-later
// JS fallback for the native Windows/Linux menu accelerators (see
// `accel(mac, other)` in src-tauri/src/lib.rs — this map must mirror it).
// Native accelerator translation with a focused webview is not guaranteed on
// either platform (WebView2 pumps input through its own pipeline; GTK
// dispatch varies), so App also matches the chords in a window-capture
// keydown. The two paths are exactly-once by construction: if the native
// accelerator consumes the keydown the webview never sees it; if it doesn't,
// the JS handler fires and no menu event is emitted.
//
// macOS deliberately has NO entry here — its ⌘ accelerators are reliably
// handled by AppKit, and ⌘-chords never reach the terminal anyway.

export interface ChordEvent {
  code: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Command id (a native menu id from src-tauri/src/lib.rs) for an app-shortcut
 * chord on Windows/Linux, or null when the key belongs to the page/terminal.
 * Matched on `code` (physical key) like the native accelerators. AltGr on
 * Windows arrives as ctrl+alt — the alt branch only claims D and W, which
 * produce no character on the common European layouts.
 */
export function menuChordCommand(e: ChordEvent): string | null {
  if (e.key === "F11" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    return "toggle_fullscreen";
  }
  if (!e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey && !e.altKey) {
    switch (e.code) {
      case "KeyC":
        return "term_copy";
      case "KeyV":
        return "term_paste";
      case "KeyT":
        return "new_terminal";
      case "KeyW":
        return "close_pane";
      case "KeyD":
        return "split_right";
      case "KeyB":
        return "toggle_sidebar";
      case "KeyG":
        return "panel_scm";
      case "KeyI":
        return "panel_notifications";
      case "KeyN":
        return "new_workspace";
      case "BracketRight":
        return "ws_next";
      case "BracketLeft":
        return "ws_prev";
      case "Equal":
        return "zoom_in";
      default:
        return null;
    }
  }
  if (e.altKey && !e.shiftKey) {
    switch (e.code) {
      case "KeyD":
        return "split_down";
      case "KeyW":
        return "close_workspace";
      default:
        return null;
    }
  }
  if (!e.altKey && !e.shiftKey) {
    if (e.code === "Comma") return "settings";
    if (e.code === "Minus") return "zoom_out";
    if (e.code === "Digit0") return "zoom_reset";
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) return `ws_${digit[1]}`;
  }
  return null;
}
