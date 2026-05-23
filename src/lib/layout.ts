// A binary split tree of terminal panes. Leaves reference a pane id; splits
// arrange two children left/right ("row") or top/bottom ("col") at a ratio.

export type Dir = "row" | "col";

export type Layout =
  | { type: "leaf"; paneId: string }
  | { type: "split"; id: string; dir: Dir; a: Layout; b: Layout; ratio: number };

let sid = 0;
export const splitId = () => `split-${Date.now()}-${sid++}`;

export function leaf(paneId: string): Layout {
  return { type: "leaf", paneId };
}

export function leaves(n: Layout): string[] {
  return n.type === "leaf" ? [n.paneId] : [...leaves(n.a), ...leaves(n.b)];
}

export function replaceLeaf(n: Layout, paneId: string, repl: Layout): Layout {
  if (n.type === "leaf") return n.paneId === paneId ? repl : n;
  return { ...n, a: replaceLeaf(n.a, paneId, repl), b: replaceLeaf(n.b, paneId, repl) };
}

export function removeLeaf(n: Layout, paneId: string): Layout | null {
  if (n.type === "leaf") return n.paneId === paneId ? null : n;
  const a = removeLeaf(n.a, paneId);
  const b = removeLeaf(n.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...n, a, b };
}

export function setRatio(n: Layout, id: string, ratio: number): Layout {
  if (n.type === "leaf") return n;
  if (n.id === id) return { ...n, ratio };
  return { ...n, a: setRatio(n.a, id, ratio), b: setRatio(n.b, id, ratio) };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LeafRect {
  paneId: string;
  rect: Rect;
}
export interface DivRect {
  id: string;
  dir: Dir;
  rect: Rect; // full area of the split (for hit-testing during drag)
  ratio: number;
}

// Compute leaf rectangles and divider positions in percent units (0..100).
export function computeLayout(
  n: Layout,
  rect: Rect,
  leavesOut: LeafRect[],
  divsOut: DivRect[],
): void {
  if (n.type === "leaf") {
    leavesOut.push({ paneId: n.paneId, rect });
    return;
  }
  divsOut.push({ id: n.id, dir: n.dir, rect, ratio: n.ratio });
  if (n.dir === "row") {
    const wa = rect.w * n.ratio;
    computeLayout(n.a, { x: rect.x, y: rect.y, w: wa, h: rect.h }, leavesOut, divsOut);
    computeLayout(
      n.b,
      { x: rect.x + wa, y: rect.y, w: rect.w - wa, h: rect.h },
      leavesOut,
      divsOut,
    );
  } else {
    const ha = rect.h * n.ratio;
    computeLayout(n.a, { x: rect.x, y: rect.y, w: rect.w, h: ha }, leavesOut, divsOut);
    computeLayout(
      n.b,
      { x: rect.x, y: rect.y + ha, w: rect.w, h: rect.h - ha },
      leavesOut,
      divsOut,
    );
  }
}
