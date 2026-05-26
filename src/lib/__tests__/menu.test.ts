// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "../menu";

describe("clampMenuPosition", () => {
  const VW = 1000;
  const VH = 800;

  it("leaves a menu that fits at the cursor untouched", () => {
    expect(clampMenuPosition(100, 100, 200, 300, VW, VH)).toEqual({ left: 100, top: 100 });
  });

  it("pulls a menu back from the right and bottom edges", () => {
    // Opened near the bottom-right; both axes flip inside with the margin.
    const { left, top } = clampMenuPosition(990, 790, 200, 300, VW, VH, 8);
    expect(left).toBe(VW - 200 - 8); // 792
    expect(top).toBe(VH - 300 - 8); // 492
  });

  it("never goes past the top-left margin", () => {
    // A cursor at the very corner with a huge menu clamps to the margin, not < 0.
    expect(clampMenuPosition(0, 0, 200, 300, VW, VH, 8)).toEqual({ left: 8, top: 8 });
  });

  it("defaults the margin to 8 when omitted", () => {
    const { left } = clampMenuPosition(10_000, 100, 200, 100, VW, VH);
    expect(left).toBe(VW - 200 - 8);
  });
});
