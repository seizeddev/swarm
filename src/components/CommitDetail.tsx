// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/ipc";
import { tokenize } from "../lib/diff";
import type { CommitDetail as Detail } from "../lib/types";

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

// Monochrome code emphasis — shared vocabulary with the DiffEditor.
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

type DLine = { kind: "add" | "del" | "ctx"; text: string };
type Hunk = { header: string; lines: DLine[] };
type FileDiff = { file: string; added: boolean; deleted: boolean; hunks: Hunk[] };

// Split a full commit patch into per-file sections (GitHub-style).
function parseCommitPatch(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  const chunks = patch.split(/(?=^diff --git )/m).filter((c) => c.startsWith("diff --git"));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const plus = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const minus = chunk.match(/^--- a\/(.+)$/m)?.[1];
    const gitm = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = plus && plus !== "/dev/null" ? plus : (gitm?.[2] ?? minus ?? "file");
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const raw of lines) {
      if (raw.startsWith("@@")) {
        cur = { header: raw, lines: [] };
        hunks.push(cur);
      } else if (cur) {
        const c = raw[0];
        if (c === "+" && !raw.startsWith("+++"))
          cur.lines.push({ kind: "add", text: raw.slice(1) });
        else if (c === "-" && !raw.startsWith("---"))
          cur.lines.push({ kind: "del", text: raw.slice(1) });
        else if (c === " ") cur.lines.push({ kind: "ctx", text: raw.slice(1) });
      }
    }
    out.push({
      file,
      added: plus !== undefined && minus === "/dev/null",
      deleted: plus === "/dev/null",
      hunks,
    });
  }
  return out;
}

export function CommitDetail({
  repoPath,
  oid,
  onClose,
}: {
  repoPath: string;
  oid: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [patch, setPatch] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    setPatch("");
    setDetail(null);
    setTruncated(false);
    api.commitDetail(repoPath, oid).then(setDetail);
    api.commitDiff(repoPath, oid).then((d) => {
      setPatch(d.patch);
      setTruncated(d.truncated);
    });
  }, [repoPath, oid]);

  const files = useMemo(() => parseCommitPatch(patch), [patch]);
  if (!detail)
    return (
      <div className="flex flex-col gap-3 p-6" aria-busy="true" aria-label="Loading commit">
        <div className="skeleton h-5 w-2/3" />
        <div className="skeleton h-3.5 w-2/5" />
        <div className="skeleton mt-3 h-24 w-full" />
      </div>
    );

  const [title, ...rest] = detail.message.trim().split("\n");
  const body = rest.join("\n").trim();
  const date = new Date(detail.time * 1000).toLocaleString();

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="selectable font-mono text-base text-[var(--color-muted)]">
          {detail.short}
        </span>
        <button type="button" className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-6">
          {/* message */}
          <h1 className="selectable text-lg font-semibold leading-snug tracking-[-0.015em]">
            {title}
          </h1>
          {body && (
            <pre className="selectable mt-2 whitespace-pre-wrap break-words font-sans text-base leading-relaxed text-[var(--color-muted)]">
              {body}
            </pre>
          )}
          <p className="mt-3 text-sm text-[var(--color-faint)]">
            {detail.author} · {date} · {detail.files.length} file
            {detail.files.length === 1 ? "" : "s"} changed
          </p>

          {truncated && (
            <div
              role="status"
              className="surface mt-4 px-3.5 py-2 text-sm text-[var(--color-muted)]"
              data-testid="diff-truncated"
            >
              Diff truncated — showing the first 5,000 lines. Open the commit in your editor for the
              full patch.
            </div>
          )}

          {/* per-file diffs, stacked */}
          <div className="mt-5 space-y-4">
            {files.map((f) => (
              <div key={f.file} className="surface overflow-hidden">
                <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3.5 py-2">
                  <span className="selectable font-mono text-base">{f.file}</span>
                  {f.added && <span className="pill h-5 px-2 text-2xs">added</span>}
                  {f.deleted && (
                    <span
                      className="pill h-5 px-2 text-2xs"
                      style={{ color: "var(--color-danger)" }}
                    >
                      deleted
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto font-mono text-[12.5px] leading-[1.5]">
                  {f.hunks.map((h, hi) => (
                    <div key={hi}>
                      <div className="bg-[var(--color-surface-1)] px-3.5 py-0.5 text-[var(--color-info)]">
                        {h.header}
                      </div>
                      {h.lines.map((l, li) => (
                        <div
                          key={li}
                          className="flex px-3.5"
                          style={{
                            background:
                              l.kind === "add"
                                ? "var(--color-success-soft)"
                                : l.kind === "del"
                                  ? "var(--color-danger-soft)"
                                  : "transparent",
                          }}
                        >
                          <span
                            className="w-4 flex-none select-none"
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
                          <span className="selectable whitespace-pre text-[var(--color-text)]">
                            <CodeSpans text={l.text} />
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
