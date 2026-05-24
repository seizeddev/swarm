// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/ipc";
import { tokenize, wordDiff, type Seg } from "../lib/diff";
import type { DiffHunk, DiffLine } from "../lib/types";

// One flat scroll row: a hunk header, or a single diff line carrying optional
// word-diff segments (present only when the line is part of a modified pair).
type Row =
  | { type: "header"; text: string }
  | { type: "line"; line: DiffLine; word?: Seg[] };

// Fraction of a line that may change before we stop calling it an "edit" of its
// counterpart — past this the lines are unrelated, so a word diff would just
// light up everything. Such lines fall back to a whole-line highlight.
const SIMILARITY_CUTOFF = 0.6;

function changedRatio(segs: Seg[]): number {
  let changed = 0;
  let total = 0;
  for (const s of segs) {
    total += s.text.length;
    if (s.changed) changed += s.text.length;
  }
  return total === 0 ? 0 : changed / total;
}

// Flatten hunks into rows, pairing each run of removed lines with the run of
// added lines that follows it so we can show intra-line (word) diffs.
function buildRows(hunks: DiffHunk[]): Row[] {
  const rows: Row[] = [];
  for (const h of hunks) {
    rows.push({ type: "header", text: h.header });
    const lines = h.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "del") {
        let d = i;
        while (d < lines.length && lines[d].kind === "del") d++;
        let a = d;
        while (a < lines.length && lines[a].kind === "add") a++;
        const dels = lines.slice(i, d);
        const adds = lines.slice(d, a);
        const paired = Math.min(dels.length, adds.length);
        dels.forEach((line, p) => {
          const wd = p < paired ? wordDiff(line.text, adds[p].text) : null;
          rows.push({ type: "line", line, word: wd && changedRatio(wd.a) <= SIMILARITY_CUTOFF ? wd.a : undefined });
        });
        adds.forEach((line, p) => {
          const wd = p < paired ? wordDiff(dels[p].text, line.text) : null;
          rows.push({ type: "line", line, word: wd && changedRatio(wd.b) <= SIMILARITY_CUTOFF ? wd.b : undefined });
        });
        i = a;
      } else {
        rows.push({ type: "line", line: lines[i] });
        i++;
      }
    }
  }
  return rows;
}

function tokClass(kind: string): string {
  switch (kind) {
    case "comment":
      return "italic text-[var(--color-faint)]";
    case "string":
      return "text-[var(--color-muted)]";
    case "keyword":
      return "font-semibold";
    default:
      return "";
  }
}

// Monochrome code emphasis — weight/brightness, never hue.
function CodeSpans({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t, i) => (
        <span key={i} className={tokClass(t.kind)}>
          {t.text}
        </span>
      ))}
    </>
  );
}

// Intra-line diff — only the changed tokens get the stronger box.
function WordSpans({ segs, add }: { segs: Seg[]; add: boolean }) {
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className={add ? "dl-word-add" : "dl-word-del"}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function LineRow({ row }: { row: Extract<Row, { type: "line" }> }) {
  const { line, word } = row;
  const bg =
    line.kind === "add"
      ? "var(--color-success-soft)"
      : line.kind === "del"
        ? "var(--color-danger-soft)"
        : "transparent";
  const symColor =
    line.kind === "add"
      ? "var(--color-success)"
      : line.kind === "del"
        ? "var(--color-danger)"
        : "var(--color-faint)";
  return (
    <div className="flex transition-colors hover:bg-white/[0.02]" style={{ background: bg }}>
      <span className="nums w-11 flex-none select-none px-1.5 text-right text-[var(--color-faint)]">
        {line.oldNo ?? ""}
      </span>
      <span className="nums w-11 flex-none select-none px-1.5 text-right text-[var(--color-faint)]">
        {line.newNo ?? ""}
      </span>
      <span
        className="w-5 flex-none select-none border-l border-[var(--color-border)] text-center"
        style={{ color: symColor }}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
      </span>
      <span className="selectable whitespace-pre-wrap break-all pr-4 text-[var(--color-text)]">
        {word ? <WordSpans segs={word} add={line.kind === "add"} /> : <CodeSpans text={line.text} />}
      </span>
    </div>
  );
}

// ── Split (side-by-side) view ────────────────────────────────────────
type Side = { line: DiffLine; word?: Seg[] };
type SplitRow =
  | { type: "header"; text: string }
  | { type: "pair"; left: Side | null; right: Side | null };

// Reconstruct the old/new columns from the unified hunks: context lines sit on
// both sides, a removed/added run pairs up index-wise (so a modified line shows
// its before/after side by side, each with its own word diff).
function buildSplitRows(hunks: DiffHunk[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const h of hunks) {
    rows.push({ type: "header", text: h.header });
    const lines = h.lines;
    let i = 0;
    while (i < lines.length) {
      const kind = lines[i].kind;
      if (kind === "del") {
        let d = i;
        while (d < lines.length && lines[d].kind === "del") d++;
        let a = d;
        while (a < lines.length && lines[a].kind === "add") a++;
        const dels = lines.slice(i, d);
        const adds = lines.slice(d, a);
        const paired = Math.min(dels.length, adds.length);
        for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
          const dl = dels[p];
          const ad = adds[p];
          const wd = p < paired ? wordDiff(dl.text, ad.text) : null;
          rows.push({
            type: "pair",
            left: dl ? { line: dl, word: wd && changedRatio(wd.a) <= SIMILARITY_CUTOFF ? wd.a : undefined } : null,
            right: ad ? { line: ad, word: wd && changedRatio(wd.b) <= SIMILARITY_CUTOFF ? wd.b : undefined } : null,
          });
        }
        i = a;
      } else if (kind === "add") {
        rows.push({ type: "pair", left: null, right: { line: lines[i] } });
        i++;
      } else {
        rows.push({ type: "pair", left: { line: lines[i] }, right: { line: lines[i] } });
        i++;
      }
    }
  }
  return rows;
}

function SplitHalf({ side, left }: { side: Side | null; left: boolean }) {
  if (!side) return <div className="flex-1 self-stretch bg-white/[0.015]" />;
  const { line, word } = side;
  const bg =
    line.kind === "add"
      ? "var(--color-success-soft)"
      : line.kind === "del"
        ? "var(--color-danger-soft)"
        : "transparent";
  const symColor =
    line.kind === "add"
      ? "var(--color-success)"
      : line.kind === "del"
        ? "var(--color-danger)"
        : "var(--color-faint)";
  return (
    <div className="flex min-w-0 flex-1" style={{ background: bg }}>
      <span className="nums w-10 flex-none select-none px-1.5 text-right text-[var(--color-faint)]">
        {(left ? line.oldNo : line.newNo) ?? ""}
      </span>
      <span className="w-5 flex-none select-none text-center" style={{ color: symColor }}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
      </span>
      <span className="selectable min-w-0 whitespace-pre-wrap break-all pr-3 text-[var(--color-text)]">
        {word ? <WordSpans segs={word} add={line.kind === "add"} /> : <CodeSpans text={line.text} />}
      </span>
    </div>
  );
}

function SplitRowView({ row }: { row: Extract<SplitRow, { type: "pair" }> }) {
  return (
    <div className="flex transition-colors hover:bg-white/[0.02]">
      <SplitHalf side={row.left} left />
      <div className="w-px flex-none bg-[var(--color-border)]" />
      <SplitHalf side={row.right} left={false} />
    </div>
  );
}

export function DiffEditor({
  repoPath,
  file,
  staged,
  onClose,
}: {
  repoPath: string;
  file: string;
  staged: boolean;
  onClose: () => void;
}) {
  // Hunks are parsed in Rust (libgit2 gives line numbers directly), so even a
  // 10k-line patch never blocks the JS main thread with a string parse.
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [loading, setLoading] = useState(true);
  // View preference is sticky across files and sessions.
  const [split, setSplit] = useState(() => localStorage.getItem("diffSplit") === "1");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    api
      .fileDiffHunks(repoPath, file, staged)
      .then(setHunks)
      .catch(() => setHunks([]))
      .finally(() => setLoading(false));
  }, [repoPath, file, staged]);

  const rows = useMemo(() => buildRows(hunks), [hunks]);
  const splitRows = useMemo(() => buildSplitRows(hunks), [hunks]);
  const view = split ? splitRows : rows;
  const { added, removed } = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.kind === "add") added++;
        else if (l.kind === "del") removed++;
      }
    return { added, removed };
  }, [hunks]);

  // Only the visible window is in the DOM; rows are measured for real (lines
  // wrap with whitespace-pre-wrap, so heights vary).
  const virt = useVirtualizer({
    count: view.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 19,
    overscan: 24,
  });
  // Toggling unified⇄split changes what sits at each index — drop the cached
  // measurements so rows re-measure at their new heights.
  useEffect(() => virt.measure(), [split, virt]);
  const items = virt.getVirtualItems();

  // The hunk header for whatever line is currently at the top of the viewport —
  // pinned so you never lose your place in a long file.
  let stickyHeader: string | null = null;
  if (items.length) {
    for (let i = items[0].index; i >= 0; i--) {
      const r = view[i];
      if (r.type === "header") {
        stickyHeader = r.text;
        break;
      }
    }
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="selectable truncate font-mono text-[12.5px] text-[var(--color-text)]">
          {file}
        </span>
        {staged && <span className="pill h-5 px-2 text-[11px]">staged</span>}
        {!loading && (added > 0 || removed > 0) && (
          <span className="nums flex-none font-mono text-[11px]">
            <span style={{ color: "var(--color-success)" }}>+{added}</span>{" "}
            <span style={{ color: "var(--color-danger)" }}>−{removed}</span>
          </span>
        )}
        <button
          className="icon-btn ml-auto h-7 w-7"
          data-active={split}
          onClick={() =>
            setSplit((v) => {
              localStorage.setItem("diffSplit", v ? "0" : "1");
              return !v;
            })
          }
          title={split ? "Unified view" : "Split view"}
        >
          <Columns2 size={14} />
        </button>
        <button className="icon-btn h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="absolute inset-0 overflow-auto">
          {loading ? (
            <div className="p-4 text-sm text-[var(--color-muted)]">Loading diff…</div>
          ) : view.length === 0 ? (
            <div className="p-4 text-sm text-[var(--color-muted)]">
              No textual diff (binary or unchanged).
            </div>
          ) : (
            <div
              className="relative font-mono text-[12.5px] leading-[1.5]"
              style={{ height: virt.getTotalSize() }}
            >
              {items.map((vi) => {
                const row = view[vi.index];
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virt.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {row.type === "header" ? (
                      <div className="bg-[var(--color-surface-1)] px-4 py-1 text-[var(--color-info)]">
                        {row.text}
                      </div>
                    ) : row.type === "pair" ? (
                      <SplitRowView row={row} />
                    ) : (
                      <LineRow row={row} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* Pinned current-hunk header (hidden while the real first header is in view). */}
        {!loading && stickyHeader && (items[0]?.index ?? 0) > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-1 font-mono text-[12.5px] text-[var(--color-info)] shadow-[0_1px_0_rgba(0,0,0,0.3)]">
            {stickyHeader}
          </div>
        )}
      </div>
    </div>
  );
}
