import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/ipc";
import type { CommitDetail as Detail } from "../lib/types";

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
    const file =
      plus && plus !== "/dev/null"
        ? plus
        : gitm?.[2] ?? minus ?? "file";
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const raw of lines) {
      if (raw.startsWith("@@")) {
        cur = { header: raw, lines: [] };
        hunks.push(cur);
      } else if (cur) {
        const c = raw[0];
        if (c === "+" && !raw.startsWith("+++")) cur.lines.push({ kind: "add", text: raw.slice(1) });
        else if (c === "-" && !raw.startsWith("---")) cur.lines.push({ kind: "del", text: raw.slice(1) });
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

  useEffect(() => {
    setPatch("");
    setDetail(null);
    api.commitDetail(repoPath, oid).then(setDetail);
    api.commitDiff(repoPath, oid).then(setPatch);
  }, [repoPath, oid]);

  const files = useMemo(() => parseCommitPatch(patch), [patch]);
  if (!detail) return <div className="p-6 text-sm text-[var(--color-muted)]">Loading…</div>;

  const [title, ...rest] = detail.message.trim().split("\n");
  const body = rest.join("\n").trim();
  const date = new Date(detail.time * 1000).toLocaleString();

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="font-mono text-[12.5px] text-[var(--color-muted)]">{detail.short}</span>
        <button className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {/* message */}
          <h1 className="text-[18px] font-semibold leading-snug">{title}</h1>
          {body && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-[var(--color-muted)]">
              {body}
            </pre>
          )}
          <p className="mt-3 text-[12px] text-[var(--color-faint)]">
            {detail.author} · {date} · {detail.files.length} file
            {detail.files.length === 1 ? "" : "s"} changed
          </p>

          {/* per-file diffs, stacked */}
          <div className="mt-5 space-y-4">
            {files.map((f) => (
              <div key={f.file} className="surface overflow-hidden">
                <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3.5 py-2">
                  <span className="font-mono text-[12.5px]">{f.file}</span>
                  {f.added && <span className="pill h-5 px-2 text-[10px]">added</span>}
                  {f.deleted && (
                    <span className="pill h-5 px-2 text-[10px]" style={{ color: "#ff6b6b" }}>
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
                                ? "rgba(54,211,153,0.10)"
                                : l.kind === "del"
                                  ? "rgba(255,107,107,0.10)"
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
                                    ? "#ff6b6b"
                                    : "var(--color-faint)",
                            }}
                          >
                            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                          </span>
                          <span className="whitespace-pre text-[var(--color-text)]">{l.text}</span>
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
