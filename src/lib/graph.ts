import type { CommitInfo } from "./types";

export interface GraphRow {
  commit: CommitInfo;
  col: number;
}
export interface Graph {
  rows: GraphRow[];
  cols: number;
  index: Map<string, { row: number; col: number }>;
}

// Assign each commit to a column (lane). Newest-first order. Lanes track the
// oid each lane is currently "waiting" to draw; a commit takes the lane that
// expected it (or a free one), then hands its lane to its first parent and
// opens new lanes for additional (merge) parents.
export function buildGraph(commits: CommitInfo[]): Graph {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const index = new Map<string, { row: number; col: number }>();

  commits.forEach((c, i) => {
    let col = lanes.indexOf(c.oid);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    // Free this lane and any duplicate lanes waiting on the same commit.
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.oid) lanes[k] = null;

    rows.push({ commit: c, col });
    index.set(c.oid, { row: i, col });

    const [p0, ...rest] = c.parents;
    if (p0 !== undefined && lanes.indexOf(p0) === -1) lanes[col] = p0;
    for (const pk of rest) {
      if (lanes.indexOf(pk) === -1) {
        let nc = lanes.indexOf(null);
        if (nc === -1) {
          nc = lanes.length;
          lanes.push(null);
        }
        lanes[nc] = pk;
      }
    }
  });

  const cols = rows.reduce((m, r) => Math.max(m, r.col), 0) + 1;
  return { rows, cols, index };
}

// Distinguishable but monochrome lane shades (lightness steps of grey).
export function laneColor(col: number): string {
  const l = 74 - (col % 6) * 9;
  return `hsl(0 0% ${l}%)`;
}
