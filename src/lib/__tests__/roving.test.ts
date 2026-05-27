// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { rovingIndex } from "../roving";

describe("rovingIndex", () => {
  it("moves forward on ArrowRight/ArrowDown, wrapping at the end", () => {
    expect(rovingIndex(0, "ArrowRight", 3)).toBe(1);
    expect(rovingIndex(0, "ArrowDown", 3)).toBe(1);
    expect(rovingIndex(2, "ArrowRight", 3)).toBe(0); // wrap
  });

  it("moves backward on ArrowLeft/ArrowUp, wrapping at the start", () => {
    expect(rovingIndex(1, "ArrowLeft", 3)).toBe(0);
    expect(rovingIndex(1, "ArrowUp", 3)).toBe(0);
    expect(rovingIndex(0, "ArrowLeft", 3)).toBe(2); // wrap
  });

  it("jumps to the ends on Home/End", () => {
    expect(rovingIndex(2, "Home", 3)).toBe(0);
    expect(rovingIndex(0, "End", 3)).toBe(2);
  });

  it("returns null for keys it does not handle (caller leaves focus put)", () => {
    expect(rovingIndex(0, "Enter", 3)).toBeNull();
    expect(rovingIndex(0, "a", 3)).toBeNull();
  });

  it("returns null when there is nothing to move through", () => {
    expect(rovingIndex(0, "ArrowRight", 0)).toBeNull();
  });
});
