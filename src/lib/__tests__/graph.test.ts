// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../types";
import { buildGraph, laneColor } from "../graph";

// Minimal commit factory — only oid + parents matter to the lane algorithm.
const c = (oid: string, parents: string[] = []): CommitInfo => ({
  oid,
  short: oid.slice(0, 7),
  summary: oid,
  author: "a",
  time: 0,
  parents,
  refs: [],
  isHead: false,
});

describe("buildGraph", () => {
  it("handles an empty history", () => {
    const g = buildGraph([]);
    expect(g.rows).toEqual([]);
    expect(g.index.size).toBe(0);
    expect(g.cols).toBe(1);
  });

  it("keeps a linear history in a single lane", () => {
    const g = buildGraph([c("c3", ["c2"]), c("c2", ["c1"]), c("c1", [])]);
    expect(g.cols).toBe(1);
    expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(g.index.get("c2")).toEqual({ row: 1, col: 0 });
  });

  it("indexes every commit by oid with row + col", () => {
    const g = buildGraph([c("a", ["b"]), c("b", [])]);
    expect(g.index.get("a")).toEqual({ row: 0, col: 0 });
    expect(g.index.get("b")).toEqual({ row: 1, col: 0 });
  });

  it("opens a second lane for a merge's additional parent", () => {
    // M is a merge of A and B; both descend from base.
    const g = buildGraph([
      c("M", ["A", "B"]),
      c("A", ["base"]),
      c("B", ["base"]),
      c("base", []),
    ]);
    expect(g.cols).toBe(2);
    expect(g.index.get("M")).toEqual({ row: 0, col: 0 });
    expect(g.index.get("A")).toEqual({ row: 1, col: 0 });
    expect(g.index.get("B")).toEqual({ row: 2, col: 1 });
    expect(g.index.get("base")).toEqual({ row: 3, col: 0 });
  });

  it("reuses a freed lane for an unrelated later branch tip", () => {
    // After a branch closes, its lane should be reused rather than growing cols.
    const g = buildGraph([
      c("x", ["y"]),
      c("y", []), // y has no parents → lane 0 frees
      c("z", []), // independent root → should reuse lane 0
    ]);
    expect(g.cols).toBe(1);
    expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0]);
  });

  it("does not duplicate a lane when two children share one parent already tracked", () => {
    // The shared parent must occupy exactly one lane.
    const g = buildGraph([
      c("M", ["A", "B"]),
      c("A", ["base"]),
      c("B", ["base"]),
      c("base", []),
    ]);
    const baseLanes = g.rows.filter((r) => r.commit.oid === "base");
    expect(baseLanes).toHaveLength(1);
  });
});

describe("laneColor", () => {
  it("returns an hsl grey for lane 0", () => {
    expect(laneColor(0)).toBe("hsl(0 0% 74%)");
  });

  it("darkens by 9% per lane", () => {
    expect(laneColor(1)).toBe("hsl(0 0% 65%)");
    expect(laneColor(2)).toBe("hsl(0 0% 56%)");
  });

  it("wraps every 6 lanes", () => {
    expect(laneColor(6)).toBe(laneColor(0));
    expect(laneColor(7)).toBe(laneColor(1));
  });
});
