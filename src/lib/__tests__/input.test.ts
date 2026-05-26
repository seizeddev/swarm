// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  encodeKey,
  encodeMouse,
  focusEvent,
  pasteIsBracketed,
  reportsMouse,
  wheelFallback,
  wrapPaste,
} from "../term/input";
import {
  M_ALT_SCREEN,
  M_ALTERNATE_SCROLL,
  M_APP_CURSOR,
  M_APP_KEYPAD,
  M_BRACKETED_PASTE,
  M_FOCUS_IN_OUT,
  M_MOUSE_REPORT_CLICK,
  M_SGR_MOUSE,
} from "../term/mode";

const ev = (p: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, location: 0, ...p }) as KeyboardEvent;

describe("encodeKey — modes", () => {
  it("ignores ⌘ combinations (left to the app)", () => {
    expect(encodeKey(ev({ key: "a", metaKey: true }))).toBeNull();
  });

  it("arrows are CSI by default, SS3 under DECCKM (APP_CURSOR)", () => {
    expect(encodeKey(ev({ key: "ArrowUp" }))).toBe("\x1b[A");
    expect(encodeKey(ev({ key: "ArrowUp" }), M_APP_CURSOR)).toBe("\x1bOA");
    expect(encodeKey(ev({ key: "End" }), M_APP_CURSOR)).toBe("\x1bOF");
  });

  it("modified arrows always use CSI 1;<mod><letter> (even under DECCKM)", () => {
    expect(encodeKey(ev({ key: "ArrowRight", ctrlKey: true }), M_APP_CURSOR)).toBe("\x1b[1;5C");
    expect(encodeKey(ev({ key: "ArrowLeft", shiftKey: true }))).toBe("\x1b[1;2D");
    expect(encodeKey(ev({ key: "ArrowUp", altKey: true }))).toBe("\x1b[1;3A");
  });

  it("tilde keys carry the modifier parameter", () => {
    expect(encodeKey(ev({ key: "PageUp" }))).toBe("\x1b[5~");
    expect(encodeKey(ev({ key: "Delete", ctrlKey: true }))).toBe("\x1b[3;5~");
    expect(encodeKey(ev({ key: "Insert" }))).toBe("\x1b[2~");
    expect(encodeKey(ev({ key: "PageDown" }))).toBe("\x1b[6~");
  });

  it("function keys: F1–F4 SS3, F5–F12 tilde, modified F1 → CSI", () => {
    expect(encodeKey(ev({ key: "F1" }))).toBe("\x1bOP");
    expect(encodeKey(ev({ key: "F4" }))).toBe("\x1bOS");
    expect(encodeKey(ev({ key: "F1", shiftKey: true }))).toBe("\x1b[1;2P");
    expect(encodeKey(ev({ key: "F5" }))).toBe("\x1b[15~");
    expect(encodeKey(ev({ key: "F12" }))).toBe("\x1b[24~");
    expect(encodeKey(ev({ key: "F6", ctrlKey: true }))).toBe("\x1b[17;5~");
  });

  it("numeric keypad sends SS3 under APP_KEYPAD only from the numpad", () => {
    expect(encodeKey(ev({ key: "1", location: 3 }), M_APP_KEYPAD)).toBe("\x1bOq");
    expect(encodeKey(ev({ key: "+", location: 3 }), M_APP_KEYPAD)).toBe("\x1bOk");
    // Not from the numpad → normal character.
    expect(encodeKey(ev({ key: "1", location: 0 }), M_APP_KEYPAD)).toBe("1");
    // Without APP_KEYPAD → normal character even from the numpad.
    expect(encodeKey(ev({ key: "1", location: 3 }))).toBe("1");
  });

  it("named control keys, Ctrl letters/symbols, printable + Alt", () => {
    expect(encodeKey(ev({ key: "Enter" }))).toBe("\r");
    expect(encodeKey(ev({ key: "Backspace" }))).toBe("\x7f");
    expect(encodeKey(ev({ key: "c", ctrlKey: true }))).toBe("\x03");
    expect(encodeKey(ev({ key: " ", ctrlKey: true }))).toBe("\x00");
    expect(encodeKey(ev({ key: "[", ctrlKey: true }))).toBe("\x1b");
    expect(encodeKey(ev({ key: "a" }))).toBe("a");
    expect(encodeKey(ev({ key: "b", altKey: true }))).toBe("\x1bb");
    expect(encodeKey(ev({ key: "Shift" }))).toBeNull();
  });
});

describe("encodeMouse", () => {
  const clickMode = M_MOUSE_REPORT_CLICK;
  const sgrMode = M_MOUSE_REPORT_CLICK | M_SGR_MOUSE;

  it("returns null for a click when no mouse mode is on", () => {
    expect(encodeMouse({ type: "press", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false }, 0)).toBeNull();
  });

  it("SGR 1006 press/release with 1-based coords and M/m finals", () => {
    expect(encodeMouse({ type: "press", button: 0, col: 4, row: 2, shift: false, alt: false, ctrl: false }, sgrMode)).toBe("\x1b[<0;5;3M");
    expect(encodeMouse({ type: "release", button: 0, col: 4, row: 2, shift: false, alt: false, ctrl: false }, sgrMode)).toBe("\x1b[<0;5;3m");
  });

  it("SGR adds the motion bit and modifier bits", () => {
    expect(encodeMouse({ type: "move", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false }, sgrMode)).toBe("\x1b[<32;1;1M");
    expect(encodeMouse({ type: "press", button: 2, col: 0, row: 0, shift: true, alt: true, ctrl: true }, sgrMode)).toBe("\x1b[<30;1;1M"); // 2+4+8+16
  });

  it("wheel up/down encode 64/65", () => {
    expect(encodeMouse({ type: "wheel", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false, wheelUp: true }, sgrMode)).toBe("\x1b[<64;1;1M");
    expect(encodeMouse({ type: "wheel", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false, wheelUp: false }, sgrMode)).toBe("\x1b[<65;1;1M");
  });

  it("legacy X10 encoding when SGR is not negotiated", () => {
    // press left at (0,0): CSI M, button 0+32=' ', x 1+32='!', y 1+32='!'
    expect(encodeMouse({ type: "press", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false }, clickMode)).toBe("\x1b[M !!");
    // release reports button 3 (35='#')
    expect(encodeMouse({ type: "release", button: 0, col: 0, row: 0, shift: false, alt: false, ctrl: false }, clickMode)).toBe("\x1b[M#!!");
  });
});

describe("paste / focus / wheel helpers", () => {
  it("wrapPaste brackets only under BRACKETED_PASTE", () => {
    expect(wrapPaste("hi", 0)).toBe("hi");
    expect(wrapPaste("hi", M_BRACKETED_PASTE)).toBe("\x1b[200~hi\x1b[201~");
    expect(pasteIsBracketed(M_BRACKETED_PASTE)).toBe(true);
  });

  it("focusEvent emits ESC[I/ESC[O only under FOCUS_IN_OUT", () => {
    expect(focusEvent(0, true)).toBeNull();
    expect(focusEvent(M_FOCUS_IN_OUT, true)).toBe("\x1b[I");
    expect(focusEvent(M_FOCUS_IN_OUT, false)).toBe("\x1b[O");
  });

  it("reportsMouse reflects the mouse-mode bits", () => {
    expect(reportsMouse(0)).toBe(false);
    expect(reportsMouse(M_MOUSE_REPORT_CLICK)).toBe(true);
  });

  it("wheelFallback → arrows only on the alt screen with alternate-scroll", () => {
    expect(wheelFallback(0, true)).toBeNull();
    expect(wheelFallback(M_ALT_SCREEN | M_ALTERNATE_SCROLL, true, 2)).toBe("\x1b[A\x1b[A");
    expect(wheelFallback(M_ALT_SCREEN | M_ALTERNATE_SCROLL, false, 1)).toBe("\x1b[B");
    expect(wheelFallback(M_ALT_SCREEN | M_ALTERNATE_SCROLL | M_APP_CURSOR, true, 1)).toBe("\x1bOA");
  });
});
