// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { decodeUpdate, EMPTY_RUNS, Grid } from "../term/grid";
import { F_BOLD, F_HYPERLINK } from "../theme";
import type { WireRun, WireUpdate } from "../types";

// Mirror of the Rust v2 `encode` layout (terminal.rs), so the decoder is tested
// against the exact bytes the backend produces (the Rust side asserts this layout).
function encode(u: WireUpdate): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const u16 = (n: number) => parts.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n: number) =>
    parts.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  parts.push(2); // version
  parts.push(u.kind === "delta" ? 1 : 0);
  parts.push(u.cursorVisible ? 1 : 0);
  parts.push(0); // reserved
  u16(u.cols);
  u16(u.rows);
  u16(u.cursorX);
  u32(u.cursorY >>> 0); // i32 little-endian; values here are non-negative
  u32(u.mode);
  u32(u.displayOffset);
  u32(u.history);
  u32(u.lines.length);
  for (const l of u.lines) {
    u16(l.y);
    u16(l.runs.length);
    for (const r of l.runs) {
      u32(r.fg >>> 0);
      u32(r.bg >>> 0);
      u16(r.flags);
      const t = enc.encode(r.text);
      u16(t.length);
      parts.push(...t);
      if (r.flags & F_HYPERLINK) {
        const lk = enc.encode(r.link ?? "");
        u16(lk.length);
        parts.push(...lk);
      }
    }
  }
  return Uint8Array.from(parts);
}

const run = (text: string, fg = 256, bg = 257, flags = 0, link?: string): WireRun =>
  link === undefined ? { text, fg, bg, flags } : { text, fg, bg, flags, link };

const frame = (over: Partial<WireUpdate>): WireUpdate => ({
  kind: "full",
  cols: 10,
  rows: 3,
  cursorX: 0,
  cursorY: 0,
  cursorVisible: true,
  mode: 0,
  displayOffset: 0,
  history: 0,
  lines: [],
  ...over,
});

describe("decodeUpdate (wire v2)", () => {
  it("round-trips mode/displayOffset/history and a plain run", () => {
    const u = frame({
      kind: "delta",
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 5,
      mode: 0x1c,
      displayOffset: 7,
      history: 99,
      lines: [{ y: 2, runs: [run("Hi", 1, 257, 0)] }],
    });
    expect(decodeUpdate(encode(u))).toEqual(u);
  });

  it("decodes a hyperlink run (flag bit 7 → trailing length-prefixed URI)", () => {
    const u = frame({
      lines: [{ y: 0, runs: [run("docs", 256, 257, F_HYPERLINK, "https://example.com")] }],
    });
    const out = decodeUpdate(encode(u));
    expect(out.lines[0].runs[0].link).toBe("https://example.com");
    expect(out.lines[0].runs[0].flags & F_HYPERLINK).toBeTruthy();
  });

  it("keeps multibyte text intact across the buffer", () => {
    const u = frame({ rows: 1, lines: [{ y: 0, runs: [run("日本語✓", 46, 257, F_BOLD)] }] });
    const out = decodeUpdate(encode(u).buffer as ArrayBuffer);
    expect(out.lines[0].runs[0].text).toBe("日本語✓");
  });

  it("returns a harmless no-op when too short for the header", () => {
    const out = decodeUpdate(new Uint8Array([2, 1, 0]));
    expect(out.lines).toEqual([]);
    expect(out.cols).toBe(0);
  });

  it("rejects a frame from an incompatible wire version", () => {
    const bytes = encode(frame({ lines: [{ y: 0, runs: [run("x")] }] }));
    bytes[0] = 99; // bad version
    const out = decodeUpdate(bytes);
    expect(out.lines).toEqual([]);
  });

  it("stops cleanly when truncated mid-run instead of over-reading", () => {
    const bytes = encode(
      frame({
        lines: [
          { y: 0, runs: [run("ok")] },
          { y: 1, runs: [run("cut")] },
        ],
      }),
    );
    const out = decodeUpdate(bytes.subarray(0, bytes.byteLength - 2));
    expect(out.lines[0].runs[0].text).toBe("ok");
    const last = out.lines[out.lines.length - 1];
    expect(last.runs.some((r) => r.text === "cut")).toBe(false);
  });

  it("stops when a hyperlink length runs past the buffer", () => {
    const bytes = encode(
      frame({ lines: [{ y: 0, runs: [run("a", 256, 257, F_HYPERLINK, "https://x")] }] }),
    );
    // Lop off the link bytes so the declared linkLen overruns.
    const out = decodeUpdate(bytes.subarray(0, bytes.byteLength - 5));
    expect(out.lines[0]?.runs[0]?.link).not.toBe("https://x");
  });

  it("accepts a number[] payload as well as a buffer", () => {
    const bytes = Array.from(encode(frame({ lines: [{ y: 0, runs: [run("z")] }] })));
    expect(decodeUpdate(bytes).lines[0].runs[0].text).toBe("z");
  });
});

describe("Grid", () => {
  it("applies a full frame, exposes mode/scroll, and reports all-dirty once", () => {
    const g = new Grid();
    g.apply(
      frame({
        rows: 3,
        mode: 0x14,
        displayOffset: 2,
        history: 50,
        cursorX: 4,
        cursorY: 1,
        lines: [
          { y: 0, runs: [run("a")] },
          { y: 2, runs: [run("c")] },
        ],
      }),
    );
    expect(g.rows).toBe(3);
    expect(g.mode).toBe(0x14);
    expect(g.displayOffset).toBe(2);
    expect(g.history).toBe(50);
    expect(g.cursorX).toBe(4);
    expect(g.lines[0][0].text).toBe("a");
    expect(g.lines[1]).toBe(EMPTY_RUNS); // gap padded with shared empty
    expect(g.takeDirty()).toBeNull(); // full → repaint everything
    expect(g.takeDirty()).toEqual([]); // drained
  });

  it("a delta patches only named rows and marks them + the cursor rows dirty", () => {
    const g = new Grid();
    g.apply(
      frame({
        rows: 4,
        lines: [
          { y: 0, runs: [run("0")] },
          { y: 1, runs: [run("1")] },
          { y: 2, runs: [run("2")] },
          { y: 3, runs: [run("3")] },
        ],
      }),
    );
    g.takeDirty(); // drain the full
    const row3 = g.lines[3];
    g.apply(
      frame({
        kind: "delta",
        rows: 4,
        cursorX: 0,
        cursorY: 2,
        lines: [{ y: 1, runs: [run("ONE")] }],
      }),
    );
    const dirty = g.takeDirty();
    expect(dirty).not.toBeNull();
    expect(new Set(dirty)).toEqual(new Set([0, 1, 2])); // patched row 1 + cursor moved 0→2
    expect(g.lines[1][0].text).toBe("ONE");
    expect(g.lines[3]).toBe(row3); // untouched rows keep their reference
  });

  it("a delta whose row count disagrees forces a full rebuild", () => {
    const g = new Grid();
    g.apply(frame({ rows: 3 }));
    g.takeDirty();
    g.apply(frame({ kind: "delta", rows: 5, lines: [{ y: 0, runs: [run("x")] }] }));
    expect(g.rows).toBe(5);
    expect(g.takeDirty()).toBeNull(); // mismatch → repaint all
  });

  it("markAllDirty forces the next frame to repaint everything", () => {
    const g = new Grid();
    g.apply(frame({ rows: 2 }));
    g.takeDirty();
    g.markAllDirty();
    expect(g.takeDirty()).toBeNull();
  });

  it("runAt resolves the run covering a column and clamps out of range", () => {
    const g = new Grid();
    g.apply(frame({ rows: 1, lines: [{ y: 0, runs: [run("ab"), run("cd", 1)] }] }));
    expect(g.runAt(0, 0)?.text).toBe("ab");
    expect(g.runAt(2, 0)?.fg).toBe(1); // into the second run
    expect(g.runAt(99, 0)).toBeNull();
    expect(g.runAt(0, 9)).toBeNull(); // no such row
  });
});
