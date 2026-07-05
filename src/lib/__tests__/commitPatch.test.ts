// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseCommitPatch } from "../commitPatch";

const TEXT_CHUNK = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;

// Binary deltas have no ---/+++ lines — just the marker.
const BINARY_MODIFIED_CHUNK = `diff --git a/docs/logo.png b/docs/logo.png
index 3333333..4444444 100644
Binary files a/docs/logo.png and b/docs/logo.png differ
`;

const BINARY_ADDED_CHUNK = `diff --git a/docs/new.png b/docs/new.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/docs/new.png differ
`;

const BINARY_DELETED_CHUNK = `diff --git a/docs/gone.png b/docs/gone.png
deleted file mode 100644
index 6666666..0000000
Binary files a/docs/gone.png and /dev/null differ
`;

const RENAME_CHUNK = `diff --git a/old/name.txt b/new/name.txt
similarity index 100%
rename from old/name.txt
rename to new/name.txt
`;

describe("parseCommitPatch", () => {
  it("parses text hunks with add/del/ctx lines", () => {
    const [f] = parseCommitPatch(TEXT_CHUNK);
    expect(f.file).toBe("src/app.ts");
    expect(f.binary).toBe(false);
    expect(f.added).toBe(false);
    expect(f.deleted).toBe(false);
    expect(f.oldFile).toBeNull();
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines).toEqual([
      { kind: "ctx", text: "const a = 1;" },
      { kind: "del", text: "const b = 2;" },
      { kind: "add", text: "const b = 3;" },
    ]);
  });

  it("splits a multi-file patch into per-file sections", () => {
    const files = parseCommitPatch(TEXT_CHUNK + BINARY_MODIFIED_CHUNK);
    expect(files.map((f) => f.file)).toEqual(["src/app.ts", "docs/logo.png"]);
  });

  it("flags a modified binary file with zero hunks", () => {
    const [f] = parseCommitPatch(BINARY_MODIFIED_CHUNK);
    expect(f.file).toBe("docs/logo.png");
    expect(f.binary).toBe(true);
    expect(f.hunks).toHaveLength(0);
    expect(f.added).toBe(false);
    expect(f.deleted).toBe(false);
  });

  it("detects added/deleted binaries via the file-mode headers", () => {
    const [added] = parseCommitPatch(BINARY_ADDED_CHUNK);
    expect(added.file).toBe("docs/new.png");
    expect(added.binary).toBe(true);
    expect(added.added).toBe(true);
    expect(added.deleted).toBe(false);

    const [gone] = parseCommitPatch(BINARY_DELETED_CHUNK);
    expect(gone.file).toBe("docs/gone.png");
    expect(gone.binary).toBe(true);
    expect(gone.deleted).toBe(true);
    expect(gone.added).toBe(false);
  });

  it("surfaces renames with the old path", () => {
    const [f] = parseCommitPatch(RENAME_CHUNK);
    expect(f.renamed).toBe(true);
    expect(f.file).toBe("new/name.txt");
    expect(f.oldFile).toBe("old/name.txt");
    expect(f.hunks).toHaveLength(0);
  });

  it("returns an empty list for an empty patch", () => {
    expect(parseCommitPatch("")).toEqual([]);
  });
});
