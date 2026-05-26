// SPDX-License-Identifier: GPL-3.0-or-later
// The terminal grid model: decode the binary frames streamed by the Rust core
// (see `encode` in terminal.rs) and fold them into a row×runs model with cursor,
// mode flags, scroll offset, and per-row damage tracking. Pure (no DOM/GPU), so
// the renderer backends read a stable model and this stays unit-testable.
import { F_HYPERLINK } from "../theme";
import type { WireLine, WireRun, WireUpdate } from "../types";

export const EMPTY_RUNS: WireRun[] = [];

const TEXT_DECODER = new TextDecoder();

// Wire format version — must match WIRE_VERSION in terminal.rs. A frame whose
// first byte differs is from an incompatible core and is dropped (no-op).
export const WIRE_VERSION = 2;

// Header: u8 version · u8 kind · u8 cursorVisible · u8 _reserved · u16 cols ·
// u16 rows · u16 cursorX · i32 cursorY · u32 mode · u32 displayOffset ·
// u32 history · u32 lineCount.
const HEADER_BYTES = 30;
const RUN_FIXED_BYTES = 12; // fg(4) + bg(4) + flags(2) + textLen(2)

// A no-op frame: patches nothing, leaves the cursor hidden. Returned for a frame
// too short or of the wrong version, so a corrupt/truncated/legacy IPC payload
// degrades to "do nothing" instead of throwing or misrendering.
const NOOP_UPDATE: WireUpdate = {
  kind: "delta",
  cols: 0,
  rows: 0,
  cursorX: 0,
  cursorY: 0,
  cursorVisible: false,
  mode: 0,
  displayOffset: 0,
  history: 0,
  lines: [],
};

// Decode a binary grid frame straight into the WireUpdate shape — no JSON parse.
// Little-endian throughout. Every read is bounds-checked against the buffer
// length: a frame that ends mid-field stops cleanly with whatever decoded so far
// (missing rows render blank) rather than over-reading the DataView.
export function decodeUpdate(raw: ArrayBuffer | Uint8Array | number[]): WireUpdate {
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : Uint8Array.from(raw);
  const total = bytes.byteLength;
  // Too short to even hold the fixed header → nothing to apply.
  if (total < HEADER_BYTES) return NOOP_UPDATE;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, total);
  let o = 0;
  if (dv.getUint8(o) !== WIRE_VERSION) return NOOP_UPDATE; // incompatible core
  o += 1;
  const kind = dv.getUint8(o) === 1 ? "delta" : "full";
  o += 1;
  const cursorVisible = dv.getUint8(o) !== 0;
  o += 1;
  o += 1; // reserved
  const cols = dv.getUint16(o, true);
  o += 2;
  const rows = dv.getUint16(o, true);
  o += 2;
  const cursorX = dv.getUint16(o, true);
  o += 2;
  const cursorY = dv.getInt32(o, true);
  o += 4;
  const mode = dv.getUint32(o, true);
  o += 4;
  const displayOffset = dv.getUint32(o, true);
  o += 4;
  const history = dv.getUint32(o, true);
  o += 4;
  const lineCount = dv.getUint32(o, true);
  o += 4;

  const lines: WireLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (o + 4 > total) break; // truncated before this line's header
    const y = dv.getUint16(o, true);
    o += 2;
    const runCount = dv.getUint16(o, true);
    o += 2;
    const runs: WireRun[] = [];
    let truncated = false;
    for (let j = 0; j < runCount; j++) {
      if (o + RUN_FIXED_BYTES > total) {
        truncated = true;
        break;
      }
      const fg = dv.getInt32(o, true);
      o += 4;
      const bg = dv.getInt32(o, true);
      o += 4;
      const flags = dv.getUint16(o, true);
      o += 2;
      const len = dv.getUint16(o, true);
      o += 2;
      if (o + len > total) {
        truncated = true;
        break;
      }
      const text = len ? TEXT_DECODER.decode(bytes.subarray(o, o + len)) : "";
      o += len;
      const run: WireRun = { text, fg, bg, flags };
      if (flags & F_HYPERLINK) {
        if (o + 2 > total) {
          truncated = true;
          break;
        }
        const linkLen = dv.getUint16(o, true);
        o += 2;
        if (o + linkLen > total) {
          truncated = true;
          break;
        }
        run.link = linkLen ? TEXT_DECODER.decode(bytes.subarray(o, o + linkLen)) : "";
        o += linkLen;
      }
      runs[j] = run;
    }
    lines.push({ y, runs });
    if (truncated) break;
  }
  return { kind, cols, rows, cursorX, cursorY, cursorVisible, mode, displayOffset, history, lines };
}

// The live grid model. `apply` folds a decoded frame in and records which rows
// changed; the renderer drains `takeDirty()` to repaint only those rows (or the
// whole grid after a full frame / resize). Holds no DOM or GPU state.
export class Grid {
  cols = 0;
  rows = 0;
  lines: WireRun[][] = [];
  cursorX = 0;
  cursorY = 0;
  cursorVisible = false;
  mode = 0;
  displayOffset = 0;
  history = 0;

  private dirtyRows = new Set<number>();
  private allDirty = true;

  apply(u: WireUpdate): void {
    const prevCursorY = this.cursorY;
    this.cols = u.cols;
    this.mode = u.mode;
    this.displayOffset = u.displayOffset;
    this.history = u.history;
    this.cursorX = u.cursorX;
    this.cursorY = u.cursorY;
    this.cursorVisible = u.cursorVisible;

    // A full frame, or a delta whose row count disagrees with ours (a resize
    // raced ahead of this frame), rebuilds the whole row array and forces a full
    // repaint — patching individual rows into a mis-sized array would misalign.
    if (u.kind === "full" || this.rows !== u.rows) {
      const arr: WireRun[][] = new Array(u.rows);
      for (const l of u.lines) arr[l.y] = l.runs;
      for (let i = 0; i < u.rows; i++) {
        if (arr[i] === undefined) arr[i] = this.lines[i] ?? EMPTY_RUNS;
      }
      this.lines = arr;
      this.rows = u.rows;
      this.allDirty = true;
      this.dirtyRows.clear();
      return;
    }

    for (const l of u.lines) {
      this.lines[l.y] = l.runs;
      this.dirtyRows.add(l.y);
    }
    // The cursor's previous and current rows must repaint so the old block is
    // cleared and the new one drawn even when the row text itself didn't change.
    this.dirtyRows.add(prevCursorY);
    this.dirtyRows.add(this.cursorY);
  }

  // Drain the rows needing repaint. `null` means "repaint everything" (after a
  // full frame or resize). Resets the damage set; the caller must redraw all of
  // the returned rows before the next `apply`.
  takeDirty(): number[] | null {
    if (this.allDirty) {
      this.allDirty = false;
      this.dirtyRows.clear();
      return null;
    }
    const rows = [...this.dirtyRows].filter((y) => y >= 0 && y < this.rows);
    this.dirtyRows.clear();
    return rows;
  }

  // Force a full repaint on the next frame (e.g. after a DPR change re-rasterized
  // the atlas, a backend swap, or the pane becoming visible again).
  markAllDirty(): void {
    this.allDirty = true;
  }

  // The run covering viewport cell (col,row), or null. Used for OSC 8 hover/click
  // hit-testing without the renderer having to expose its internals.
  runAt(col: number, row: number): WireRun | null {
    const runs = this.lines[row];
    if (!runs) return null;
    let x = 0;
    for (const r of runs) {
      // Codepoint count (not `.length`), so a wide/astral char advances the column
      // correctly. Only runs on hover, so the spread allocation is fine here.
      const w = [...r.text].length;
      if (col < x + w) return r;
      x += w;
    }
    return null;
  }
}
