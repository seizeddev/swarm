// SPDX-License-Identifier: GPL-3.0-or-later
// Translate a browser KeyboardEvent into the bytes a PTY expects.
// Returns null when the event should be ignored.
export function encodeKey(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, metaKey } = e;

  if (metaKey) return null; // leave ⌘ shortcuts to the app

  const simple: Record<string, string> = {
    Enter: "\r",
    Tab: "\t",
    Backspace: "\x7f",
    Escape: "\x1b",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
    Delete: "\x1b[3~",
    Insert: "\x1b[2~",
  };
  if (key in simple) return simple[key];

  if (ctrlKey && key.length === 1) {
    const c = key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // Ctrl+A..Z
    if (key === " ") return "\x00";
    const others: Record<string, string> = {
      "[": "\x1b",
      "\\": "\x1c",
      "]": "\x1d",
      "^": "\x1e",
      "_": "\x1f",
    };
    if (key in others) return others[key];
  }

  if (key.length === 1) {
    return altKey ? "\x1b" + key : key;
  }
  return null;
}
