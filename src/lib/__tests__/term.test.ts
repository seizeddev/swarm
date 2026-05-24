// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyUpdate, decodeUpdate, EMPTY_RUNS, runStyle } from "../term";
import { F_BOLD, F_INVERSE } from "../theme";
import type { WireRun, WireUpdate } from "../types";

// Mirror of the Rust `encode` layout, so the decoder is tested against the exact
// bytes the backend produces (the Rust side asserts this same layout).
function encode(u: WireUpdate): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const u16 = (n: number) => parts.push(n & 0xff, (n >> 8) & 0xff);
  const i32 = (n: number) => parts.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  parts.push(u.kind === "delta" ? 1 : 0);
  parts.push(u.cursorVisible ? 1 : 0);
  u16(u.cols);
  u16(u.rows);
  u16(u.cursorX);
  i32(u.cursorY);
  i32(u.lines.length); // u32 (lengths here are small)
  for (const l of u.lines) {
    u16(l.y);
    u16(l.runs.length);
    for (const r of l.runs) {
      i32(r.fg);
      i32(r.bg);
      u16(r.flags);
      const t = enc.encode(r.text);
      u16(t.length);
      parts.push(...t);
    }
  }
  return Uint8Array.from(parts);
}

const run = (text: string, fg = 256, bg = 257, flags = 0): WireRun => ({ text, fg, bg, flags });

const full = (rows: number, lines: { y: number; runs: WireRun[] }[]): WireUpdate => ({
  kind: "full",
  cols: 10,
  rows,
  cursorX: 0,
  cursorY: 0,
  cursorVisible: true,
  lines,
});

const delta = (lines: { y: number; runs: WireRun[] }[]): WireUpdate => ({
  kind: "delta",
  cols: 10,
  rows: 3,
  cursorX: 0,
  cursorY: 0,
  cursorVisible: true,
  lines,
});

describe("applyUpdate", () => {
  it("a full frame replaces every row and pads gaps with the shared empty array", () => {
    const out = applyUpdate([], full(3, [{ y: 0, runs: [run("a")] }, { y: 2, runs: [run("c")] }]));
    expect(out.length).toBe(3);
    expect(out[0][0].text).toBe("a");
    expect(out[2][0].text).toBe("c");
    // Gap row 1 falls back to the shared empty-runs constant (no allocation).
    expect(out[1]).toBe(EMPTY_RUNS);
  });

  it("a delta patches only the named rows and preserves the rest by reference", () => {
    const base = applyUpdate(
      [],
      full(3, [
        { y: 0, runs: [run("zero")] },
        { y: 1, runs: [run("one")] },
        { y: 2, runs: [run("two")] },
      ]),
    );
    const row0 = base[0];
    const row2 = base[2];
    const patched = [run("ONE!")];

    const out = applyUpdate(base, delta([{ y: 1, runs: patched }]));

    // Same container (mutated in place) and same untouched-row references → those
    // <TermLine>s memo-skip; only row 1 carries a new runs array.
    expect(out).toBe(base);
    expect(out[0]).toBe(row0);
    expect(out[2]).toBe(row2);
    expect(out[1]).toBe(patched);
    expect(out[1][0].text).toBe("ONE!");
  });
});

describe("decodeUpdate", () => {
  it("round-trips a frame through the binary layout", () => {
    const update: WireUpdate = {
      kind: "delta",
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 5,
      cursorVisible: true,
      lines: [
        { y: 2, runs: [run("Hi", 1, 257, 0), run("✓ ünïcödé", 46, 257, F_BOLD)] },
        { y: 7, runs: [] },
      ],
    };
    expect(decodeUpdate(encode(update))).toEqual(update);
  });

  it("decodes a full frame with multibyte text intact", () => {
    const update: WireUpdate = {
      kind: "full",
      cols: 10,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: false,
      lines: [{ y: 0, runs: [run("日本語", 256, 257, 0)] }],
    };
    const out = decodeUpdate(encode(update).buffer as ArrayBuffer);
    expect(out.kind).toBe("full");
    expect(out.lines[0].runs[0].text).toBe("日本語");
  });
});

describe("runStyle cache", () => {
  it("returns the identical object for repeated (fg,bg,flags) keys", () => {
    const a = runStyle(run("x", 1, 257, 0));
    const b = runStyle(run("y", 1, 257, 0)); // different text, same style key
    expect(a).toBe(b);
  });

  it("distinguishes styles that differ in flags", () => {
    const plain = runStyle(run("x", 1, 257, 0));
    const bold = runStyle(run("x", 1, 257, F_BOLD));
    expect(bold).not.toBe(plain);
    expect(bold.fontWeight).toBe(700);
  });

  it("INVERSE swaps foreground and background", () => {
    const normal = runStyle(run("x", 1, 2, 0));
    const inverted = runStyle(run("x", 1, 2, F_INVERSE));
    expect(inverted.color).toBe(normal.background);
  });
});
