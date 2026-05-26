// SPDX-License-Identifier: GPL-3.0-or-later
// Translate browser input events into the byte sequences a PTY expects, honouring
// the emulator's current `TermMode` (streamed in every frame). Pure and exhaustive
// so it can be unit-tested across every key/mouse/mode combination — no DOM beyond
// the event shape. Supersedes the old keys.ts (arrows-only, mode-blind).
import {
  hasMode,
  M_ALT_SCREEN,
  M_ALTERNATE_SCROLL,
  M_APP_CURSOR,
  M_APP_KEYPAD,
  M_BRACKETED_PASTE,
  M_FOCUS_IN_OUT,
  M_MOUSE_MODE,
  M_SGR_MOUSE,
} from "./mode";

const ESC = "\x1b";

// xterm modifier parameter: 1 + a bitmask of shift(1) alt(2) ctrl(4) meta(8).
// Returns 1 when no modifier is held (the value xterm omits, but callers check).
function modParam(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
}

// A cursor/nav key whose final letter is `A`..`H`. With a modifier it is always
// CSI `1;<mod><letter>`; bare, it is SS3 `O<letter>` under DECCKM (APP_CURSOR) and
// CSI `[<letter>` otherwise — this is exactly what vim/less read for arrow keys.
function cursorSeq(letter: string, mod: number, appCursor: boolean): string {
  if (mod > 1) return `${ESC}[1;${mod}${letter}`;
  return appCursor ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

// A `CSI <n> ~` key (PageUp/Down, Insert, Delete, F5+). With a modifier the form
// is `CSI <n>;<mod>~`.
function tildeSeq(n: number, mod: number): string {
  return mod > 1 ? `${ESC}[${n};${mod}~` : `${ESC}[${n}~`;
}

const CURSOR_LETTER: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const TILDE_CODE: Record<string, number> = {
  PageUp: 5,
  PageDown: 6,
  Insert: 2,
  Delete: 3,
};

// F5..F12 map to `CSI <n> ~`. F1..F4 are handled separately (SS3 P/Q/R/S).
const FN_TILDE: Record<string, number> = {
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
const FN_SS3: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

// Numeric-keypad keys in application-keypad mode (DECKPAM): SS3-encoded so a TUI
// can tell them from the main row. Only consulted when the event came from the
// numpad (KeyboardEvent.location === 3) and APP_KEYPAD is set.
const KEYPAD_SS3: Record<string, string> = {
  "0": "p",
  "1": "q",
  "2": "r",
  "3": "s",
  "4": "t",
  "5": "u",
  "6": "v",
  "7": "w",
  "8": "x",
  "9": "y",
  "*": "j",
  "+": "k",
  "-": "m",
  ".": "n",
  "/": "o",
  Enter: "M",
};

const DOM_KEY_LOCATION_NUMPAD = 3;

// Encode a KeyboardEvent into PTY bytes, or null if it should be ignored (and the
// browser default left alone). `mode` is the emulator's current TermMode bits.
export function encodeKey(e: KeyboardEvent, mode = 0): string | null {
  const { key, ctrlKey, altKey, metaKey } = e;
  if (metaKey) return null; // ⌘ shortcuts belong to the app

  const mod = modParam(e);
  const appCursor = hasMode(mode, M_APP_CURSOR);

  if (key in CURSOR_LETTER) return cursorSeq(CURSOR_LETTER[key], mod, appCursor);
  if (key in TILDE_CODE) return tildeSeq(TILDE_CODE[key], mod);

  if (key in FN_SS3) {
    // F1..F4: SS3 bare, CSI `1;<mod>` letter when modified.
    return mod > 1 ? `${ESC}[1;${mod}${FN_SS3[key]}` : `${ESC}O${FN_SS3[key]}`;
  }
  if (key in FN_TILDE) return tildeSeq(FN_TILDE[key], mod);

  // Application keypad: a numpad key becomes an SS3 sequence (bare only — a
  // modified numpad key falls through to its normal character/Ctrl handling).
  if (
    hasMode(mode, M_APP_KEYPAD) &&
    e.location === DOM_KEY_LOCATION_NUMPAD &&
    mod === 1 &&
    key in KEYPAD_SS3
  ) {
    return `${ESC}O${KEYPAD_SS3[key]}`;
  }

  const simple: Record<string, string> = {
    Enter: "\r",
    Tab: "\t",
    Backspace: "\x7f",
    Escape: "\x1b",
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
      _: "\x1f",
    };
    if (key in others) return others[key];
  }

  if (key.length === 1) {
    return altKey ? ESC + key : key;
  }
  return null;
}

export interface MouseEventInfo {
  // "press" covers a button going down; "release" a button up; "move" a motion
  // (only encode when the program asked for motion reports); "wheel" a scroll tick.
  type: "press" | "release" | "move" | "wheel";
  // 0 left, 1 middle, 2 right (ignored for wheel, which uses `wheelUp`).
  button: number;
  col: number; // 0-based viewport column
  row: number; // 0-based viewport row
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelUp?: boolean;
}

// True when button clicks/drags should be reported to the program rather than
// driving local selection.
export const reportsMouse = (mode: number): boolean => hasMode(mode, M_MOUSE_MODE);

// Encode a mouse event for the program. Returns null when the current mode does
// not report this event (e.g. a bare click while no mouse mode is on). SGR 1006
// (`CSI < b;x;y M|m`, 1-based) when SGR_MOUSE is negotiated, else legacy X10
// (`CSI M` with byte-offset coordinates) which older mouse modes expect.
export function encodeMouse(e: MouseEventInfo, mode: number): string | null {
  const wheel = e.type === "wheel";
  if (!wheel && !reportsMouse(mode)) return null;

  // Button code. Wheel: 64 (up) / 65 (down). Release in X10 uses button 3.
  let b: number;
  if (wheel) {
    b = e.wheelUp ? 64 : 65;
  } else {
    b = e.button & 3;
    if (e.type === "move") b += 32; // motion bit
  }
  if (e.shift) b += 4;
  if (e.alt) b += 8;
  if (e.ctrl) b += 16;

  const x = e.col + 1;
  const y = e.row + 1;

  if (hasMode(mode, M_SGR_MOUSE)) {
    const final = e.type === "release" ? "m" : "M";
    return `${ESC}[<${b};${x};${y}${final}`;
  }

  // Legacy X10: release reports button 3; coordinates are byte-offset by 32 and
  // clamped so they never exceed a single encodable byte (255).
  if (e.type === "release") b = (b & ~3) | 3;
  const cb = String.fromCharCode(Math.min(b + 32, 255));
  const cx = String.fromCharCode(Math.min(x + 32, 255));
  const cy = String.fromCharCode(Math.min(y + 32, 255));
  return `${ESC}[M${cb}${cx}${cy}`;
}

// Bracketed-paste wrapping (DEC 2004). When BRACKETED_PASTE is on, the program is
// told the run is a paste — so it won't treat embedded newlines as Enter, and the
// multi-line execution-guard confirm in the orchestrator can be skipped. Otherwise
// the text is sent verbatim (and the orchestrator keeps the confirm).
export const BRACKET_PASTE_START = `${ESC}[200~`;
export const BRACKET_PASTE_END = `${ESC}[201~`;
export const pasteIsBracketed = (mode: number): boolean => hasMode(mode, M_BRACKETED_PASTE);
export function wrapPaste(text: string, mode: number): string {
  return pasteIsBracketed(mode) ? `${BRACKET_PASTE_START}${text}${BRACKET_PASTE_END}` : text;
}

// Focus-event reporting (DEC 1004): when FOCUS_IN_OUT is on, the program wants
// ESC[I on focus and ESC[O on blur. Returns the bytes, or null when off.
export function focusEvent(mode: number, focused: boolean): string | null {
  if (!hasMode(mode, M_FOCUS_IN_OUT)) return null;
  return focused ? `${ESC}[I` : `${ESC}[O`;
}

// Wheel-tick fallback for when the program isn't in mouse mode: on the alternate
// screen with alternate-scroll, the wheel sends arrow keys (so pagers/editors
// scroll); otherwise the orchestrator scrolls our own scrollback. Returns the
// arrow bytes to send, or null to mean "scroll the local buffer instead".
export function wheelFallback(mode: number, up: boolean, lines = 3): string | null {
  if (hasMode(mode, M_ALT_SCREEN) && hasMode(mode, M_ALTERNATE_SCROLL)) {
    const seq = up ? `${ESC}OA` : `${ESC}OB`; // SS3 arrows match app-cursor pagers
    const csi = up ? `${ESC}[A` : `${ESC}[B`;
    const one = hasMode(mode, M_APP_CURSOR) ? seq : csi;
    return one.repeat(Math.max(1, lines));
  }
  return null;
}
