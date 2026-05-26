// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { glyphKey } from "../term/atlas";
import { F_BOLD, F_HIDDEN, F_INVERSE, F_ITALIC } from "../theme";

// glyphKey is the only pure part of the (canvas-bound) atlas; the rasterization
// itself is exercised live in the app. The key must distinguish everything that
// changes a glyph's pixels and ignore everything that doesn't.
describe("glyphKey", () => {
  it("differs by glyph, rasterizing style bits, and fg colour", () => {
    const base = glyphKey("A", 0, "#fff");
    expect(glyphKey("B", 0, "#fff")).not.toBe(base);
    expect(glyphKey("A", F_BOLD, "#fff")).not.toBe(base);
    expect(glyphKey("A", F_ITALIC, "#fff")).not.toBe(base);
    expect(glyphKey("A", 0, "#000")).not.toBe(base);
  });

  it("ignores style bits that don't change the glyph pixels (inverse/hidden)", () => {
    // Inverse/hidden are resolved by the backend (colour swap / skip), not baked
    // into the cached glyph, so they must not fragment the cache.
    expect(glyphKey("A", F_INVERSE, "#fff")).toBe(glyphKey("A", 0, "#fff"));
    expect(glyphKey("A", F_HIDDEN, "#fff")).toBe(glyphKey("A", 0, "#fff"));
  });
});
