// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { lineDiff, tokenize, wordDiff } from "../diff";

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");
const changed = (segs: { text: string; changed: boolean }[]) =>
  segs
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join("");

describe("wordDiff", () => {
  it("reconstructs both sides exactly", () => {
    const { a, b } = wordDiff("const x = 1;", "const y = 2;");
    expect(text(a)).toBe("const x = 1;");
    expect(text(b)).toBe("const y = 2;");
  });

  it("marks only the differing words", () => {
    const { a, b } = wordDiff("const x = 1;", "const y = 2;");
    expect(changed(a)).toBe("x1");
    expect(changed(b)).toBe("y2");
  });

  it("flags nothing changed for identical lines", () => {
    const { a, b } = wordDiff("same line", "same line");
    expect(changed(a)).toBe("");
    expect(changed(b)).toBe("");
  });

  it("handles pure insertion and deletion", () => {
    expect(changed(wordDiff("", "added").b)).toBe("added");
    expect(changed(wordDiff("removed", "").a)).toBe("removed");
  });

  it("aligns on a shared prefix and suffix", () => {
    const { a, b } = wordDiff("foo(bar)", "foo(baz)");
    expect(changed(a)).toBe("bar");
    expect(changed(b)).toBe("baz");
  });
});

describe("tokenize", () => {
  const kinds = (line: string, kind: string) =>
    tokenize(line)
      .filter((t) => t.kind === kind)
      .map((t) => t.text);

  it("losslessly covers the input", () => {
    const line = "const n = 42; // note";
    expect(
      tokenize(line)
        .map((t) => t.text)
        .join(""),
    ).toBe(line);
  });

  it("classifies keywords, numbers, strings and comments", () => {
    expect(kinds("const x = 1", "keyword")).toContain("const");
    expect(kinds("x = 42", "number")).toContain("42");
    expect(kinds('a = "hi"', "string")).toContain('"hi"');
    expect(kinds("x // trailing", "comment")).toContain("// trailing");
    expect(kinds("# python comment", "comment")).toContain("# python comment");
  });

  it("treats unknown identifiers as plain", () => {
    expect(kinds("myVariable", "keyword")).toHaveLength(0);
    expect(kinds("myVariable", "plain")).toContain("myVariable");
  });

  it("keeps a string with an embedded keyword as one string", () => {
    expect(kinds('"return value"', "string")).toEqual(['"return value"']);
    expect(kinds('"return value"', "keyword")).toHaveLength(0);
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines, keeping common ones as context", () => {
    const out = lineDiff("a\nb\nc", "a\nB\nc");
    expect(out).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
    ]);
  });

  it("treats an empty before as a pure creation", () => {
    const out = lineDiff("", "x\ny");
    expect(out).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  it("treats an empty after as a pure removal", () => {
    const out = lineDiff("x\ny", "");
    expect(out.every((l) => l.kind === "del")).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("ignores a trailing newline (no spurious blank line)", () => {
    const out = lineDiff("a\n", "a\n");
    expect(out).toEqual([{ kind: "ctx", text: "a" }]);
  });

  it("reports no changes for identical content", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === "ctx")).toBe(true);
  });
});
