// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { detect, joinRepoPath, pathBasename } from "../platform";

describe("detect", () => {
  it("recognises macOS via platform or userAgent", () => {
    expect(detect("MacIntel", "")).toEqual({ isMac: true, isWindows: false });
    expect(detect("", "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toMatchObject({ isMac: true });
  });

  it("recognises Windows via platform or userAgent", () => {
    expect(detect("Win32", "")).toEqual({ isMac: false, isWindows: true });
    expect(detect("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toMatchObject({
      isWindows: true,
    });
  });

  it("treats Linux as neither", () => {
    expect(detect("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
      isMac: false,
      isWindows: false,
    });
  });
});

describe("joinRepoPath", () => {
  it("joins with / on Unix", () => {
    expect(joinRepoPath("/Users/v/repo", "src/a.ts", false)).toBe("/Users/v/repo/src/a.ts");
  });

  it("converts the git-relative path to backslashes on Windows", () => {
    // git always reports "/"-separated paths; the joined absolute path must be
    // native so "Copy Path" doesn't hand the user a mixed-separator string.
    expect(joinRepoPath("C:\\Users\\v\\repo", "src/a.ts", true)).toBe(
      "C:\\Users\\v\\repo\\src\\a.ts",
    );
  });
});

describe("pathBasename", () => {
  it("handles both separators and trailing slashes", () => {
    expect(pathBasename("/Users/v/repo")).toBe("repo");
    expect(pathBasename("C:\\Users\\v\\repo")).toBe("repo");
    expect(pathBasename("C:\\Users\\v\\repo\\")).toBe("repo");
    expect(pathBasename("repo")).toBe("repo");
    expect(pathBasename("")).toBe("");
  });
});
