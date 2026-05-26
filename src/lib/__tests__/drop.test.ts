// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { dispatchDrop, joinPaths, quotePath, registerDrop } from "../drop";

describe("quotePath", () => {
  it("passes bare-safe paths through unquoted", () => {
    expect(quotePath("/usr/local/bin/file.txt")).toBe("/usr/local/bin/file.txt");
    expect(quotePath("relative/path-1_2.png")).toBe("relative/path-1_2.png");
  });

  it("single-quotes paths with spaces or metacharacters", () => {
    expect(quotePath("/my files/a b.txt")).toBe("'/my files/a b.txt'");
    expect(quotePath("/x/$(boom).txt")).toBe("'/x/$(boom).txt'");
  });

  it("escapes embedded single quotes the POSIX way", () => {
    expect(quotePath("/it's/here")).toBe("'/it'\\''s/here'");
  });

  it("quotes the empty string", () => {
    expect(quotePath("")).toBe("''");
  });
});

describe("joinPaths", () => {
  it("space-joins multiple quoted paths", () => {
    expect(joinPaths(["/a/b.txt", "/c d/e.png"])).toBe("/a/b.txt '/c d/e.png'");
  });
});

describe("drop registry", () => {
  it("routes paths to the registered pane handler", () => {
    const fn = vi.fn();
    const off = registerDrop("pane-1", fn);
    expect(dispatchDrop("pane-1", ["/x"])).toBe(true);
    expect(fn).toHaveBeenCalledWith(["/x"]);
    off();
    expect(dispatchDrop("pane-1", ["/y"])).toBe(false);
  });

  it("returns false for an unknown pane", () => {
    expect(dispatchDrop("nope", ["/x"])).toBe(false);
  });

  it("unregister only clears its own slot (a remount replaces it safely)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerDrop("p", first);
    registerDrop("p", second); // remount replaces the handler
    offFirst(); // stale cleanup must NOT remove the new handler
    expect(dispatchDrop("p", ["/z"])).toBe(true);
    expect(second).toHaveBeenCalledWith(["/z"]);
    expect(first).not.toHaveBeenCalled();
  });
});
