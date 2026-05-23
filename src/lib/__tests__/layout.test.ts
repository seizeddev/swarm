import { describe, expect, it } from "vitest";
import {
  computeLayout,
  type DivRect,
  type Layout,
  leaf,
  leaves,
  type LeafRect,
  type Rect,
  removeLeaf,
  replaceLeaf,
  setRatio,
  splitId,
} from "../layout";

const split = (dir: "row" | "col", a: Layout, b: Layout, ratio = 0.5, id = "s"): Layout => ({
  type: "split",
  id,
  dir,
  a,
  b,
  ratio,
});

describe("splitId", () => {
  it("produces unique ids on each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => splitId()));
    expect(ids.size).toBe(100);
  });
  it("is prefixed with split-", () => {
    expect(splitId()).toMatch(/^split-/);
  });
});

describe("leaf / leaves", () => {
  it("wraps a pane id", () => {
    expect(leaf("p1")).toEqual({ type: "leaf", paneId: "p1" });
  });

  it("collects a single leaf", () => {
    expect(leaves(leaf("p1"))).toEqual(["p1"]);
  });

  it("collects leaves left-to-right (depth-first a before b)", () => {
    const tree = split("row", leaf("p1"), split("col", leaf("p2"), leaf("p3")));
    expect(leaves(tree)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("replaceLeaf", () => {
  it("replaces the matching leaf with the replacement subtree", () => {
    const tree = split("row", leaf("p1"), leaf("p2"));
    const repl = split("col", leaf("p2"), leaf("p3"), 0.5, "inner");
    const out = replaceLeaf(tree, "p2", repl);
    expect(leaves(out)).toEqual(["p1", "p2", "p3"]);
  });

  it("returns the leaf unchanged when id does not match", () => {
    const l = leaf("p1");
    expect(replaceLeaf(l, "other", leaf("x"))).toBe(l);
  });

  it("does not mutate the original tree", () => {
    const tree = split("row", leaf("p1"), leaf("p2"));
    replaceLeaf(tree, "p1", leaf("z"));
    expect(leaves(tree)).toEqual(["p1", "p2"]);
  });
});

describe("removeLeaf", () => {
  it("returns null when the only leaf is removed", () => {
    expect(removeLeaf(leaf("p1"), "p1")).toBeNull();
  });

  it("returns the leaf when a non-matching id is removed", () => {
    const l = leaf("p1");
    expect(removeLeaf(l, "other")).toBe(l);
  });

  it("collapses a split to the surviving sibling", () => {
    const tree = split("row", leaf("p1"), leaf("p2"));
    expect(removeLeaf(tree, "p1")).toEqual(leaf("p2"));
    expect(removeLeaf(tree, "p2")).toEqual(leaf("p1"));
  });

  it("removes a deeply nested leaf and collapses its parent", () => {
    const tree = split("row", leaf("p1"), split("col", leaf("p2"), leaf("p3"), 0.5, "inner"));
    const out = removeLeaf(tree, "p2");
    // inner split collapses to p3; outer split keeps p1 + p3
    expect(leaves(out!)).toEqual(["p1", "p3"]);
  });

  it("returns null when every leaf is gone (both sides null)", () => {
    const tree = split("row", leaf("p1"), leaf("p1"));
    // Removing p1 nulls both children → whole tree null
    expect(removeLeaf(tree, "p1")).toBeNull();
  });
});

describe("setRatio", () => {
  it("updates the ratio of the matching split", () => {
    const tree = split("row", leaf("p1"), leaf("p2"), 0.5, "target");
    const out = setRatio(tree, "target", 0.3) as Extract<Layout, { type: "split" }>;
    expect(out.ratio).toBeCloseTo(0.3);
  });

  it("leaves non-matching splits untouched", () => {
    const tree = split("row", leaf("p1"), leaf("p2"), 0.5, "a");
    const out = setRatio(tree, "nonexistent", 0.9) as Extract<Layout, { type: "split" }>;
    expect(out.ratio).toBe(0.5);
  });

  it("updates a nested split", () => {
    const inner = split("col", leaf("p2"), leaf("p3"), 0.5, "inner");
    const tree = split("row", leaf("p1"), inner, 0.5, "outer");
    const out = setRatio(tree, "inner", 0.8);
    const innerOut = (out as Extract<Layout, { type: "split" }>).b as Extract<
      Layout,
      { type: "split" }
    >;
    expect(innerOut.ratio).toBe(0.8);
  });

  it("is a no-op for a bare leaf", () => {
    const l = leaf("p1");
    expect(setRatio(l, "x", 0.2)).toBe(l);
  });
});

describe("computeLayout", () => {
  const full: Rect = { x: 0, y: 0, w: 100, h: 100 };

  it("places a single leaf in the whole rect", () => {
    const ls: LeafRect[] = [];
    const ds: DivRect[] = [];
    computeLayout(leaf("p1"), full, ls, ds);
    expect(ls).toEqual([{ paneId: "p1", rect: full }]);
    expect(ds).toEqual([]);
  });

  it("splits a row by ratio into left/right halves", () => {
    const ls: LeafRect[] = [];
    const ds: DivRect[] = [];
    computeLayout(split("row", leaf("p1"), leaf("p2"), 0.5), full, ls, ds);
    expect(ls[0].rect).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(ls[1].rect).toEqual({ x: 50, y: 0, w: 50, h: 100 });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ dir: "row", ratio: 0.5 });
  });

  it("splits a col by ratio into top/bottom", () => {
    const ls: LeafRect[] = [];
    const ds: DivRect[] = [];
    computeLayout(split("col", leaf("p1"), leaf("p2"), 0.25), full, ls, ds);
    expect(ls[0].rect).toEqual({ x: 0, y: 0, w: 100, h: 25 });
    expect(ls[1].rect).toEqual({ x: 0, y: 25, w: 100, h: 75 });
  });

  it("honours non-even ratios and conserves total width", () => {
    const ls: LeafRect[] = [];
    const ds: DivRect[] = [];
    computeLayout(split("row", leaf("p1"), leaf("p2"), 0.3), full, ls, ds);
    expect(ls[0].rect.w).toBeCloseTo(30);
    expect(ls[1].rect.w).toBeCloseTo(70);
    expect(ls[0].rect.w + ls[1].rect.w).toBeCloseTo(full.w);
  });

  it("recurses through nested splits accumulating dividers", () => {
    const inner = split("col", leaf("p2"), leaf("p3"), 0.5, "inner");
    const tree = split("row", leaf("p1"), inner, 0.5, "outer");
    const ls: LeafRect[] = [];
    const ds: DivRect[] = [];
    computeLayout(tree, full, ls, ds);
    expect(ls.map((l) => l.paneId)).toEqual(["p1", "p2", "p3"]);
    expect(ds.map((d) => d.id)).toEqual(["outer", "inner"]);
    // inner split occupies the right half
    expect(ds[1].rect).toEqual({ x: 50, y: 0, w: 50, h: 100 });
  });
});
