// SPDX-License-Identifier: GPL-3.0-or-later

export type DLine = { kind: "add" | "del" | "ctx"; text: string };
export type Hunk = { header: string; lines: DLine[] };
export type FileDiff = {
  file: string;
  /** Pre-change path when it differs from `file` (rename), else null. */
  oldFile: string | null;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  /** True when git emitted a "Binary files … differ" marker instead of hunks
   * (images and other non-text content). Such files have zero hunks. */
  binary: boolean;
  hunks: Hunk[];
};

// Split a full commit patch into per-file sections (GitHub-style).
// Binary deltas carry no ---/+++ lines, so added/deleted also fall back to
// the "new file mode"/"deleted file mode" extended headers.
export function parseCommitPatch(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  const chunks = patch.split(/(?=^diff --git )/m).filter((c) => c.startsWith("diff --git"));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const plus = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const minus = chunk.match(/^--- a\/(.+)$/m)?.[1];
    const gitm = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const renameTo = chunk.match(/^rename to (.+)$/m)?.[1];
    const renameFrom = chunk.match(/^rename from (.+)$/m)?.[1];
    const file = plus && plus !== "/dev/null" ? plus : (renameTo ?? gitm?.[2] ?? minus ?? "file");
    const oldRaw = minus && minus !== "/dev/null" ? minus : (renameFrom ?? gitm?.[1] ?? null);
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
      oldFile: oldRaw && oldRaw !== file ? oldRaw : null,
      added: (plus !== undefined && minus === "/dev/null") || /^new file mode /m.test(chunk),
      deleted: plus === "/dev/null" || /^deleted file mode /m.test(chunk),
      renamed: renameFrom !== undefined,
      binary: /^Binary files .* differ$/m.test(chunk),
      hunks,
    });
  }
  return out;
}
