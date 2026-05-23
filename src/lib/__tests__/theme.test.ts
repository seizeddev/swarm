import { describe, expect, it } from "vitest";
import {
  F_BOLD,
  F_DIM,
  F_HIDDEN,
  F_INVERSE,
  F_ITALIC,
  F_STRIKE,
  F_UNDERLINE,
  resolveColor,
  TERM_BG,
  TERM_FG,
} from "../theme";

describe("resolveColor", () => {
  it("decodes a truecolor value from the low 24 bits", () => {
    const v = 0x01000000 | 0x123456;
    expect(resolveColor(v, "fg")).toBe("#123456");
  });

  it("pads truecolor channels to two hex digits", () => {
    const v = 0x01000000 | 0x010203;
    expect(resolveColor(v, "fg")).toBe("#010203");
  });

  it("maps 256 to the foreground and 257 to the background", () => {
    expect(resolveColor(256, "fg")).toBe(TERM_FG);
    expect(resolveColor(257, "bg")).toBe(TERM_BG);
  });

  it("resolves the 16 base palette colors", () => {
    expect(resolveColor(0, "fg")).toBe("#1b1b1f");
    expect(resolveColor(1, "fg")).toBe("#ff6b81");
    expect(resolveColor(15, "fg")).toBe("#f4f4f7");
  });

  it("resolves the 6x6x6 color cube boundaries", () => {
    expect(resolveColor(16, "fg")).toBe("#000000"); // first cube cell (0,0,0)
    expect(resolveColor(231, "fg")).toBe("#ffffff"); // last cube cell (5,5,5)
  });

  it("resolves the 24-step grayscale ramp", () => {
    expect(resolveColor(232, "fg")).toBe("#080808"); // 8
    expect(resolveColor(255, "fg")).toBe("#eeeeee"); // 8 + 23*10 = 238
  });

  it("falls back to fg/bg defaults for out-of-range indices", () => {
    expect(resolveColor(9999, "fg")).toBe(TERM_FG);
    expect(resolveColor(9999, "bg")).toBe(TERM_BG);
  });
});

describe("flag bitmask constants", () => {
  it("are distinct single-bit powers of two matching the Rust core", () => {
    expect(F_BOLD).toBe(1);
    expect(F_ITALIC).toBe(1 << 1);
    expect(F_UNDERLINE).toBe(1 << 2);
    expect(F_INVERSE).toBe(1 << 3);
    expect(F_DIM).toBe(1 << 4);
    expect(F_STRIKE).toBe(1 << 5);
    expect(F_HIDDEN).toBe(1 << 6);
    const all = [F_BOLD, F_ITALIC, F_UNDERLINE, F_INVERSE, F_DIM, F_STRIKE, F_HIDDEN];
    expect(new Set(all).size).toBe(all.length);
  });
});
