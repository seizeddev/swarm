// SPDX-License-Identifier: GPL-3.0-or-later
// Mirror of alacritty_terminal's `TermMode` bitflags (src/term/mod.rs). The core
// streams `term.mode().bits()` verbatim in every frame; these constants let the
// pure input/selection layers interpret it without a round-trip. Keep the bit
// positions in lock-step with the Rust enum — they are a wire contract.

export const M_APP_CURSOR = 1 << 1; // DECCKM: arrows/Home/End as SS3, not CSI
export const M_APP_KEYPAD = 1 << 2; // DECKPAM: numeric keypad as SS3
export const M_MOUSE_REPORT_CLICK = 1 << 3;
export const M_BRACKETED_PASTE = 1 << 4;
export const M_SGR_MOUSE = 1 << 5; // SGR 1006 extended mouse coordinates
const M_MOUSE_MOTION = 1 << 6; // report motion while a button is held (1002)
export const M_FOCUS_IN_OUT = 1 << 11; // emit ESC[I / ESC[O on focus/blur
export const M_ALT_SCREEN = 1 << 12;
const M_MOUSE_DRAG = 1 << 13; // any-motion reporting (1003)
export const M_ALTERNATE_SCROLL = 1 << 15; // wheel → arrow keys on the alt screen

// Any of the mouse-reporting modes is active: clicks/drags must be encoded and
// sent rather than driving local selection.
export const M_MOUSE_MODE = M_MOUSE_REPORT_CLICK | M_MOUSE_MOTION | M_MOUSE_DRAG;

export const hasMode = (mode: number, bit: number): boolean => (mode & bit) !== 0;

// True when the wheel should scroll our own scrollback rather than be reported to
// the program: only when no mouse mode is on AND we're not on the alternate screen
// running alternate-scroll (where the wheel maps to arrow keys instead).
export const wheelScrollsBuffer = (mode: number): boolean =>
  !hasMode(mode, M_MOUSE_MODE) && !hasMode(mode, M_ALT_SCREEN);
