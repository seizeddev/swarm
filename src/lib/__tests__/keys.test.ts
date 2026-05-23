// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { encodeKey } from "../keys";

// encodeKey only reads key/ctrlKey/altKey/metaKey — a plain object suffices.
const ev = (p: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, altKey: false, metaKey: false, ...p }) as KeyboardEvent;

describe("encodeKey", () => {
  it("ignores any key combined with meta (⌘)", () => {
    expect(encodeKey(ev({ key: "a", metaKey: true }))).toBeNull();
    expect(encodeKey(ev({ key: "Enter", metaKey: true }))).toBeNull();
  });

  it("maps named keys to control sequences", () => {
    expect(encodeKey(ev({ key: "Enter" }))).toBe("\r");
    expect(encodeKey(ev({ key: "Tab" }))).toBe("\t");
    expect(encodeKey(ev({ key: "Backspace" }))).toBe("\x7f");
    expect(encodeKey(ev({ key: "Escape" }))).toBe("\x1b");
  });

  it("maps arrows and navigation keys to CSI sequences", () => {
    expect(encodeKey(ev({ key: "ArrowUp" }))).toBe("\x1b[A");
    expect(encodeKey(ev({ key: "ArrowDown" }))).toBe("\x1b[B");
    expect(encodeKey(ev({ key: "ArrowRight" }))).toBe("\x1b[C");
    expect(encodeKey(ev({ key: "ArrowLeft" }))).toBe("\x1b[D");
    expect(encodeKey(ev({ key: "Home" }))).toBe("\x1b[H");
    expect(encodeKey(ev({ key: "End" }))).toBe("\x1b[F");
    expect(encodeKey(ev({ key: "PageUp" }))).toBe("\x1b[5~");
    expect(encodeKey(ev({ key: "PageDown" }))).toBe("\x1b[6~");
    expect(encodeKey(ev({ key: "Delete" }))).toBe("\x1b[3~");
    expect(encodeKey(ev({ key: "Insert" }))).toBe("\x1b[2~");
  });

  it("encodes Ctrl+A..Z as bytes 0x01..0x1a", () => {
    expect(encodeKey(ev({ key: "a", ctrlKey: true }))).toBe("\x01");
    expect(encodeKey(ev({ key: "c", ctrlKey: true }))).toBe("\x03"); // SIGINT
    expect(encodeKey(ev({ key: "z", ctrlKey: true }))).toBe("\x1a");
  });

  it("uppercases Ctrl+letter (shift held) to the same control byte", () => {
    expect(encodeKey(ev({ key: "C", ctrlKey: true }))).toBe("\x03");
  });

  it("encodes Ctrl+Space as NUL", () => {
    expect(encodeKey(ev({ key: " ", ctrlKey: true }))).toBe("\x00");
  });

  it("encodes the Ctrl symbol group", () => {
    expect(encodeKey(ev({ key: "[", ctrlKey: true }))).toBe("\x1b");
    expect(encodeKey(ev({ key: "\\", ctrlKey: true }))).toBe("\x1c");
    expect(encodeKey(ev({ key: "]", ctrlKey: true }))).toBe("\x1d");
    expect(encodeKey(ev({ key: "^", ctrlKey: true }))).toBe("\x1e");
    expect(encodeKey(ev({ key: "_", ctrlKey: true }))).toBe("\x1f");
  });

  it("passes printable characters through unchanged", () => {
    expect(encodeKey(ev({ key: "a" }))).toBe("a");
    expect(encodeKey(ev({ key: "Z" }))).toBe("Z");
    expect(encodeKey(ev({ key: "1" }))).toBe("1");
  });

  it("prefixes Alt+char with ESC (meta sends-escape)", () => {
    expect(encodeKey(ev({ key: "b", altKey: true }))).toBe("\x1bb");
  });

  it("returns null for unhandled multi-char keys", () => {
    expect(encodeKey(ev({ key: "F1" }))).toBeNull();
    expect(encodeKey(ev({ key: "CapsLock" }))).toBeNull();
    expect(encodeKey(ev({ key: "Shift" }))).toBeNull();
  });
});
