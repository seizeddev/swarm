// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/ipc";

type DLine = { kind: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number };
type Hunk = { header: string; lines: DLine[] };

function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = raw[0];
    if (c === "+" && !raw.startsWith("+++")) cur.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    else if (c === "-" && !raw.startsWith("---")) cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    else if (c === " ") cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return hunks;
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
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .fileDiff(repoPath, file, staged)
      .then(setPatch)
      .finally(() => setLoading(false));
  }, [repoPath, file, staged]);

  const hunks = useMemo(() => parsePatch(patch), [patch]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="font-mono text-[12.5px] text-[var(--color-text)]">{file}</span>
        {staged && <span className="pill h-5 px-2 text-[11px]">staged</span>}
        <button className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 text-sm text-[var(--color-muted)]">Loading diff…</div>
        ) : hunks.length === 0 ? (
          <div className="p-4 text-sm text-[var(--color-muted)]">
            No textual diff (binary or unchanged).
          </div>
        ) : (
          <div className="font-mono text-[12.5px] leading-[1.5]">
            {hunks.map((h, hi) => (
              <div key={hi}>
                <div className="bg-[var(--color-surface-1)] px-4 py-1 text-[var(--color-info)]">
                  {h.header}
                </div>
                {h.lines.map((l, li) => (
                  <div
                    key={li}
                    className="flex"
                    style={{
                      background:
                        l.kind === "add"
                          ? "var(--color-success-soft)"
                          : l.kind === "del"
                            ? "var(--color-danger-soft)"
                            : "transparent",
                    }}
                  >
                    <span className="w-12 flex-none select-none px-1 text-right text-[var(--color-faint)]">
                      {l.oldNo ?? ""}
                    </span>
                    <span className="w-12 flex-none select-none px-1 text-right text-[var(--color-faint)]">
                      {l.newNo ?? ""}
                    </span>
                    <span
                      className="w-4 flex-none select-none text-center"
                      style={{
                        color:
                          l.kind === "add"
                            ? "var(--color-success)"
                            : l.kind === "del"
                              ? "var(--color-danger)"
                              : "var(--color-faint)",
                      }}
                    >
                      {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all pr-4 text-[var(--color-text)]">
                      {l.text}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
