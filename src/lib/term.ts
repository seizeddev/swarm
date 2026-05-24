// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for the terminal grid: applying streamed frames to the row array
// and memoizing per-run CSS. Kept out of the component so they can be unit-tested.
import type { CSSProperties } from "react";
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
} from "./theme";
import type { WireLine, WireRun, WireUpdate } from "./types";

export const EMPTY_RUNS: WireRun[] = [];

const TEXT_DECODER = new TextDecoder();

// Decode a binary grid frame (see `encode` in terminal.rs) straight into the
// WireUpdate shape — no JSON parse. Little-endian throughout.
export function decodeUpdate(raw: ArrayBuffer | Uint8Array | number[]): WireUpdate {
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : Uint8Array.from(raw);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const kind = dv.getUint8(o) === 1 ? "delta" : "full";
  o += 1;
  const cursorVisible = dv.getUint8(o) !== 0;
  o += 1;
  const cols = dv.getUint16(o, true);
  o += 2;
  const rows = dv.getUint16(o, true);
  o += 2;
  const cursorX = dv.getUint16(o, true);
  o += 2;
  const cursorY = dv.getInt32(o, true);
  o += 4;
  const lineCount = dv.getUint32(o, true);
  o += 4;

  const lines: WireLine[] = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) {
    const y = dv.getUint16(o, true);
    o += 2;
    const runCount = dv.getUint16(o, true);
    o += 2;
    const runs: WireRun[] = new Array(runCount);
    for (let j = 0; j < runCount; j++) {
      const fg = dv.getInt32(o, true);
      o += 4;
      const bg = dv.getInt32(o, true);
      o += 4;
      const flags = dv.getUint16(o, true);
      o += 2;
      const len = dv.getUint16(o, true);
      o += 2;
      const text = len ? TEXT_DECODER.decode(bytes.subarray(o, o + len)) : "";
      o += len;
      runs[j] = { text, fg, bg, flags };
    }
    lines[i] = { y, runs };
  }
  return { kind, cols, rows, cursorX, cursorY, cursorVisible, lines };
}

// Apply a streamed frame to the per-row runs array. A `full` frame returns a
// fresh array of every row; a `delta` patches only the reported rows *in place*
// so untouched rows keep their array identity (lets `<TermLine>` bail re-render).
export function applyUpdate(lines: WireRun[][], u: WireUpdate): WireRun[][] {
  if (u.kind === "full") {
    const arr: WireRun[][] = new Array(u.rows);
    for (const l of u.lines) arr[l.y] = l.runs;
    for (let i = 0; i < u.rows; i++) if (arr[i] === undefined) arr[i] = EMPTY_RUNS;
    return arr;
  }
  for (const l of u.lines) lines[l.y] = l.runs;
  return lines;
}

function buildStyle(run: WireRun): CSSProperties {
  let fg = resolveColor(run.fg, "fg");
  let bg = resolveColor(run.bg, "bg");
  if (run.flags & F_INVERSE) [fg, bg] = [bg, fg];
  const s: CSSProperties = { color: fg };
  if (bg !== TERM_BG) s.background = bg;
  if (run.flags & F_BOLD) s.fontWeight = 700;
  if (run.flags & F_ITALIC) s.fontStyle = "italic";
  const deco: string[] = [];
  if (run.flags & F_UNDERLINE) deco.push("underline");
  if (run.flags & F_STRIKE) deco.push("line-through");
  if (deco.length) s.textDecoration = deco.join(" ");
  if (run.flags & F_DIM) s.opacity = 0.6;
  if (run.flags & F_HIDDEN) s.visibility = "hidden";
  return s;
}

// Style objects are a pure function of (fg, bg, flags), and a session uses only a
// handful of distinct combinations, so memoize them across every run and render
// instead of reallocating a style object per cell run.
const styleCache = new Map<string, CSSProperties>();
export function runStyle(run: WireRun): CSSProperties {
  const key = `${run.fg}|${run.bg}|${run.flags}`;
  let s = styleCache.get(key);
  if (s === undefined) {
    s = buildStyle(run);
    styleCache.set(key, s);
  }
  return s;
}
