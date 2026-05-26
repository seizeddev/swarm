// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  cellInRange,
  expandLine,
  expandWord,
  orderCells,
  pixelToCell,
  rowText,
} from "../term/select";

describe("pixelToCell", () => {
  it("floors pixels to the cell the pointer is over", () => {
    expect(pixelToCell(15, 34, 10, 17, 80, 24)).toEqual({ col: 1, row: 2 });
  });
  it("clamps into the viewport on both axes", () => {
    expect(pixelToCell(-5, -5, 10, 17, 80, 24)).toEqual({ col: 0, row: 0 });
    expect(pixelToCell(99999, 99999, 10, 17, 80, 24)).toEqual({ col: 79, row: 23 });
  });
});

describe("orderCells", () => {
  it("returns the cells in reading order regardless of drag direction", () => {
    const a = { col: 5, row: 2 };
    const b = { col: 1, row: 4 };
    expect(orderCells(a, b)).toEqual({ start: a, end: b });
    expect(orderCells(b, a)).toEqual({ start: a, end: b });
  });
  it("orders by column on the same row", () => {
    expect(orderCells({ col: 9, row: 1 }, { col: 2, row: 1 })).toEqual({
      start: { col: 2, row: 1 },
      end: { col: 9, row: 1 },
    });
  });
});

describe("expandWord", () => {
  it("expands to the surrounding word", () => {
    expect(expandWord("foo bar baz", 5)).toEqual({ startCol: 4, endCol: 6 });
  });
  it("returns the single cell when on a separator or out of range", () => {
    expect(expandWord("foo bar", 3)).toEqual({ startCol: 3, endCol: 3 }); // the space
    expect(expandWord("foo", 9)).toEqual({ startCol: 9, endCol: 9 });
  });
  it("handles a word touching the line edges", () => {
    expect(expandWord("hello", 0)).toEqual({ startCol: 0, endCol: 4 });
  });
});

describe("expandLine", () => {
  it("trims trailing blanks", () => {
    expect(expandLine("hello world   ", 80)).toEqual({ startCol: 0, endCol: 10 });
  });
  it("falls back to the full width on a blank row", () => {
    expect(expandLine("    ", 40)).toEqual({ startCol: 0, endCol: 39 });
  });
});

describe("rowText", () => {
  it("concatenates run text, empty for a missing row", () => {
    expect(rowText([{ text: "ab" }, { text: "cd" }])).toBe("abcd");
    expect(rowText(undefined)).toBe("");
  });
});

describe("cellInRange", () => {
  const start = { col: 3, row: 1 };
  const end = { col: 5, row: 3 };
  it("single-row range is column-bounded", () => {
    expect(cellInRange({ col: 4, row: 2 }, { col: 2, row: 2 }, { col: 6, row: 2 })).toBe(true);
    expect(cellInRange({ col: 1, row: 2 }, { col: 2, row: 2 }, { col: 6, row: 2 })).toBe(false);
  });
  it("multi-row: full middle rows, bounded first/last", () => {
    expect(cellInRange({ col: 0, row: 2 }, start, end)).toBe(true); // middle row, any col
    expect(cellInRange({ col: 2, row: 1 }, start, end)).toBe(false); // before start col
    expect(cellInRange({ col: 9, row: 1 }, start, end)).toBe(true); // after start col
    expect(cellInRange({ col: 6, row: 3 }, start, end)).toBe(false); // past end col
    expect(cellInRange({ col: 0, row: 0 }, start, end)).toBe(false); // before range
    expect(cellInRange({ col: 0, row: 9 }, start, end)).toBe(false); // after range
  });
});
