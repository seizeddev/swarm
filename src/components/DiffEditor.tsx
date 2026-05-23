// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../lib/ipc";
import type { DiffHunk, DiffLine } from "../lib/types";

// One flat scroll row: a hunk header or a single diff line. Flattening lets the
// virtualizer treat the whole file as one list regardless of hunk boundaries.
type Row = { type: "header"; text: string } | { type: "line"; line: DiffLine };

function flatten(hunks: DiffHunk[]): Row[] {
  const rows: Row[] = [];
  for (const h of hunks) {
    rows.push({ type: "header", text: h.header });
    for (const line of h.lines) rows.push({ type: "line", line });
  }
  return rows;
}

function LineRow({ line }: { line: DiffLine }) {
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
    <div className="flex" style={{ background: bg }}>
      <span className="w-12 flex-none select-none px-1 text-right text-[var(--color-faint)]">
        {line.oldNo ?? ""}
      </span>
      <span className="w-12 flex-none select-none px-1 text-right text-[var(--color-faint)]">
        {line.newNo ?? ""}
      </span>
      <span className="w-4 flex-none select-none text-center" style={{ color: symColor }}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
      </span>
      <span className="whitespace-pre-wrap break-all pr-4 text-[var(--color-text)]">{line.text}</span>
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    api
      .fileDiffHunks(repoPath, file, staged)
      .then(setHunks)
      .catch(() => setHunks([]))
      .finally(() => setLoading(false));
  }, [repoPath, file, staged]);

  const rows = useMemo(() => flatten(hunks), [hunks]);

  // Only the visible window is in the DOM; rows are measured for real (lines
  // wrap with whitespace-pre-wrap, so heights vary).
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 19,
    overscan: 24,
  });

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="font-mono text-[12.5px] text-[var(--color-text)]">{file}</span>
        {staged && <span className="pill h-5 px-2 text-[11px]">staged</span>}
        <button className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 text-sm text-[var(--color-muted)]">Loading diff…</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-sm text-[var(--color-muted)]">
            No textual diff (binary or unchanged).
          </div>
        ) : (
          <div
            className="relative font-mono text-[12.5px] leading-[1.5]"
            style={{ height: virt.getTotalSize() }}
          >
            {virt.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
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
                  ) : (
                    <LineRow line={row.line} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
