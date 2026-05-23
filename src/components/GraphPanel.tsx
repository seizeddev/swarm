// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/ipc";
import { buildGraph, laneColor } from "../lib/graph";
import { useActiveWorkspace, useStore } from "../store";
import type { CommitInfo } from "../lib/types";

function relTime(sec: number): string {
  const d = Math.floor(Date.now() / 1000 - sec);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 2592000) return `${Math.floor(d / 86400)}d`;
  return `${Math.floor(d / 2592000)}mo`;
}

const ROW = 38;
const COLW = 15;
const XPAD = 14;
const DOT = 4;

export function GraphPanel() {
  const ws = useActiveWorkspace();
  const openCommit = useStore((s) => s.openCommit);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    if (!ws) return;
    setLoading(true);
    api
      .gitLog(ws.repo.path, 300)
      .then(setCommits)
      .finally(() => setLoading(false));
  };
  useEffect(load, [ws?.repo.path]);

  const g = useMemo(() => buildGraph(commits), [commits]);
  const x = (c: number) => XPAD + c * COLW;
  const gw = g.cols * COLW + XPAD;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Fixed-height rows, so only the visible window (+overscan) is in the DOM —
  // both the commit rows and the SVG nodes/edges anchored to them.
  const virt = useVirtualizer({
    count: g.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 16,
  });
  const items = virt.getVirtualItems();
  const cy = (row: number) => row * ROW + ROW / 2;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 flex-none items-center justify-between px-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          History
        </span>
        <button className="icon-btn h-7 w-7" title="Refresh" onClick={load}>
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ height: virt.getTotalSize(), minWidth: "100%" }}>
          {/* graph edges + nodes — only for rows in the visible window */}
          <svg
            width={gw}
            height={virt.getTotalSize()}
            className="absolute left-0 top-0"
            style={{ overflow: "visible" }}
          >
            {items.map((vi) => {
              const r = g.rows[vi.index];
              return r.commit.parents.map((p) => {
                const pi = g.index.get(p);
                if (!pi) return null;
                const x1 = x(r.col);
                const y1 = cy(vi.index);
                const x2 = x(pi.col);
                const y2 = cy(pi.row);
                const d =
                  x1 === x2
                    ? `M${x1},${y1} L${x2},${y2}`
                    : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
                return (
                  <path
                    key={r.commit.oid + p}
                    d={d}
                    fill="none"
                    stroke={laneColor(Math.max(r.col, pi.col))}
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                  />
                );
              });
            })}
            {items.map((vi) => {
              const r = g.rows[vi.index];
              const px = x(r.col);
              const py = cy(vi.index);
              return r.commit.isHead ? (
                <g key={r.commit.oid}>
                  <circle cx={px} cy={py} r={DOT + 2} fill="none" stroke="#fff" strokeWidth={1.5} />
                  <circle cx={px} cy={py} r={DOT - 1} fill="#fff" />
                </g>
              ) : (
                <circle key={r.commit.oid} cx={px} cy={py} r={DOT} fill={laneColor(r.col)} />
              );
            })}
          </svg>

          {/* commit rows */}
          {items.map((vi) => {
            const r = g.rows[vi.index];
            const activeCommit = ws?.editor.type === "commit" && ws.editor.oid === r.commit.oid;
            return (
              <div
                key={r.commit.oid}
                data-active={activeCommit}
                onClick={() => openCommit(r.commit.oid)}
                title={`${r.commit.author} · ${relTime(r.commit.time)} · ${r.commit.short}`}
                className="row absolute flex cursor-pointer items-center gap-1.5 overflow-hidden px-2.5"
                style={{ top: vi.start + 3, left: gw, right: 8, height: ROW - 6 }}
              >
                {r.commit.refs.map((ref) => (
                  <span
                    key={ref}
                    className="pill h-[18px] flex-none px-1.5 text-[10px]"
                    style={
                      r.commit.isHead
                        ? { background: "rgba(255,255,255,0.18)", color: "#fff" }
                        : undefined
                    }
                  >
                    {ref}
                  </span>
                ))}
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.commit.summary}</span>
                <span className="flex-none font-mono text-[10px] text-[var(--color-faint)]">
                  {relTime(r.commit.time)}
                </span>
              </div>
            );
          })}

          {!loading && !commits.length && (
            <p className="p-4 text-[13px] text-[var(--color-muted)]">No commits.</p>
          )}
        </div>
      </div>
    </div>
  );
}
