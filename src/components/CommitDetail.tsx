// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/ipc";
import { tokenize } from "../lib/diff";
import { parseCommitPatch, type FileDiff } from "../lib/commitPatch";
import { formatBytes, imageMime } from "../lib/media";
import type { BlobSide, CommitDetail as Detail, CommitFileBlobs } from "../lib/types";

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

// One side of an image preview: the rendered image plus a dimensions/size
// caption (dimensions read off the decoded image itself).
function ImageSide({
  label,
  side,
  mime,
  tone,
}: {
  label: string | null;
  side: BlobSide;
  mime: string;
  tone: "old" | "new";
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const edge = tone === "old" ? "var(--color-danger)" : "var(--color-success)";
  return (
    <figure className="flex min-w-0 flex-1 flex-col items-center gap-1.5 px-3 py-4">
      {label && (
        <figcaption className="text-xs uppercase tracking-wide" style={{ color: edge }}>
          {label}
        </figcaption>
      )}
      {side.base64 ? (
        <img
          src={`data:${mime};base64,${side.base64}`}
          alt={label ?? "Image preview"}
          className="img-checker max-h-72 max-w-full rounded border object-contain"
          style={{ borderColor: edge }}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
      ) : (
        <div className="px-4 py-6 text-sm text-[var(--color-muted)]">Too large to preview</div>
      )}
      <figcaption className="nums text-xs text-[var(--color-faint)]">
        {dims ? `${dims.w}×${dims.h} · ` : ""}
        {formatBytes(side.size)}
      </figcaption>
    </figure>
  );
}

// Body of a binary file in the commit view: images render inline (before/after
// for a modified image), everything else gets a size caption instead of the
// old silent empty box. Blobs are fetched lazily per file; image bytes only
// when the extension is renderable.
function BinaryBody({ repoPath, oid, f }: { repoPath: string; oid: string; f: FileDiff }) {
  const mime = imageMime(f.file);
  const [blobs, setBlobs] = useState<CommitFileBlobs | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBlobs(null);
    setFailed(false);
    api
      .commitFileBlobs(repoPath, oid, f.oldFile ?? f.file, f.file, mime !== null)
      .then((b) => {
        if (!cancelled) setBlobs(b);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, oid, f, mime]);

  if (failed)
    return (
      <div className="px-3.5 py-2.5 text-sm text-[var(--color-muted)]">
        Couldn't load file contents.
      </div>
    );
  if (!blobs)
    return (
      <div className="p-3" aria-busy="true" aria-label={`Loading ${f.file}`}>
        <div className="skeleton h-20 w-full" />
      </div>
    );

  if (mime && (blobs.old || blobs.new)) {
    const both = blobs.old !== null && blobs.new !== null;
    return (
      <div className="flex items-stretch justify-center divide-x divide-[var(--color-border)]">
        {blobs.old && (
          <ImageSide label={both ? "Before" : null} side={blobs.old} mime={mime} tone="old" />
        )}
        {blobs.new && (
          <ImageSide label={both ? "After" : null} side={blobs.new} mime={mime} tone="new" />
        )}
      </div>
    );
  }

  const oldSize = blobs.old ? formatBytes(blobs.old.size) : null;
  const newSize = blobs.new ? formatBytes(blobs.new.size) : null;
  return (
    <div className="nums px-3.5 py-2.5 text-sm text-[var(--color-muted)]">
      Binary file ·{" "}
      {oldSize && newSize ? `${oldSize} → ${newSize}` : (newSize ?? `was ${oldSize ?? "empty"}`)}
    </div>
  );
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
  // Failed-load + a retry nonce. The old `.catch(() => {})` left detail null on a
  // failure, so a failed fetch showed the loading skeleton forever; this surfaces
  // the error with a way out (bumping nonce re-runs the effect).
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Arrow-keying through the commit list hits this effect every keystroke.
  // Without a debounce we'd spawn an off-thread libgit2 walk per commit and
  // then race-overwrite each setPatch with stale results. Both calls are
  // gated on `cancelled` so the late return for a no-longer-visible commit
  // is a no-op. The 120 ms debounce is well under interactive perception but
  // long enough that holding ↓ doesn't fan out one walk per row.
  useEffect(() => {
    setPatch("");
    setDetail(null);
    setTruncated(false);
    setFailed(false);
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .commitDetail(repoPath, oid)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
      api
        .commitDiff(repoPath, oid)
        .then((d) => {
          if (cancelled) return;
          setPatch(d.patch);
          setTruncated(d.truncated);
        })
        .catch(() => {});
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [repoPath, oid, nonce]);

  const files = useMemo(() => parseCommitPatch(patch), [patch]);
  if (failed)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base text-[var(--color-muted)]">Couldn't load this commit.</p>
        <button type="button" className="btn" onClick={() => setNonce((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
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
          <h1 className="selectable text-lg font-semibold leading-snug tracking-[-0.01em]">
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
                  <span className="selectable min-w-0 truncate font-mono text-base">
                    {f.renamed && f.oldFile ? `${f.oldFile} → ${f.file}` : f.file}
                  </span>
                  {f.added && <span className="pill-sm">added</span>}
                  {f.deleted && (
                    <span className="pill-sm" style={{ color: "var(--color-danger)" }}>
                      deleted
                    </span>
                  )}
                  {f.renamed && <span className="pill-sm">renamed</span>}
                </div>
                {f.binary ? (
                  <BinaryBody repoPath={repoPath} oid={oid} f={f} />
                ) : f.hunks.length === 0 ? (
                  <div className="px-3.5 py-2.5 text-sm text-[var(--color-muted)]">
                    No content changes.
                  </div>
                ) : (
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
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
