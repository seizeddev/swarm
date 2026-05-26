// SPDX-License-Identifier: GPL-3.0-or-later
// Pure selection geometry: map pointer pixels to grid cells, order a drag into a
// reading-order range, and expand a click to a word or line. No DOM — the actual
// text extraction happens in the core (pty_selection_text, which reads scrollback
// correctly); this only computes the cell coordinates to hand it.

export interface Cell {
  col: number;
  row: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Map content-relative pixels (already past the canvas padding, in the same unit
// as cellW/cellH) to a grid cell, clamped into the viewport. floor() so the cell
// is the one the pointer is physically over.
export function pixelToCell(
  px: number,
  py: number,
  cellW: number,
  cellH: number,
  cols: number,
  rows: number,
): Cell {
  const col = clamp(Math.floor(px / cellW), 0, Math.max(0, cols - 1));
  const row = clamp(Math.floor(py / cellH), 0, Math.max(0, rows - 1));
  return { col, row };
}

// Order two cells into reading order (top-to-bottom, then left-to-right) so a
// drag in any direction yields a {start ≤ end} range. The end cell is inclusive —
// the core's bounds_to_string includes the cell at the end column.
export function orderCells(a: Cell, b: Cell): { start: Cell; end: Cell } {
  const aBefore = a.row < b.row || (a.row === b.row && a.col <= b.col);
  return aBefore ? { start: a, end: b } : { start: b, end: a };
}

// Default word-break characters (mirrors a typical terminal's semantic-escape set
// closely enough for double-click word selection).
const WORD_SEPARATORS = new Set([..." \t \"'`()[]{}<>|*,;:!?=&^%$#@~"]);

const isSep = (ch: string | undefined): boolean => ch === undefined || WORD_SEPARATORS.has(ch);

// Expand a column within a row's flattened text to the surrounding word. Returns
// the inclusive [startCol, endCol]; if the clicked cell is itself a separator (or
// blank), the selection is just that single cell.
export function expandWord(rowText: string, col: number): { startCol: number; endCol: number } {
  const chars = [...rowText];
  if (col < 0 || col >= chars.length || isSep(chars[col])) {
    return { startCol: col, endCol: col };
  }
  let s = col;
  let e = col;
  while (s > 0 && !isSep(chars[s - 1])) s--;
  while (e < chars.length - 1 && !isSep(chars[e + 1])) e++;
  return { startCol: s, endCol: e };
}

// Expand to a whole line: the trimmed extent of its content, or the single first
// cell when the row is blank. `cols` bounds an empty/whitespace row.
export function expandLine(rowText: string, cols: number): { startCol: number; endCol: number } {
  const chars = [...rowText];
  let e = chars.length - 1;
  while (e >= 0 && (chars[e] === " " || chars[e] === "\t")) e--;
  return { startCol: 0, endCol: e < 0 ? Math.max(0, cols - 1) : e };
}

// Flatten a row's runs into a single string indexed by column (each grid column,
// including wide-char spacer blanks, is exactly one char — see line_runs in Rust).
export function rowText(runs: { text: string }[] | undefined): string {
  if (!runs) return "";
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

// True when a cell falls inside the inclusive [start,end] reading-order range.
export function cellInRange(cell: Cell, start: Cell, end: Cell): boolean {
  if (cell.row < start.row || cell.row > end.row) return false;
  if (start.row === end.row) return cell.col >= start.col && cell.col <= end.col;
  if (cell.row === start.row) return cell.col >= start.col;
  if (cell.row === end.row) return cell.col <= end.col;
  return true;
}
