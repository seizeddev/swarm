// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { clampPanelWidth, PANEL_DEFAULT, PANEL_MIN } from "../panel";

describe("clampPanelWidth", () => {
  // Roomy window: ceiling is the absolute max (480), floor is PANEL_MIN.
  it("respects the floor and the absolute ceiling on a wide window", () => {
    expect(clampPanelWidth(100, 1280)).toBe(PANEL_MIN);
    expect(clampPanelWidth(9999, 1280)).toBe(480);
    expect(clampPanelWidth(PANEL_DEFAULT, 1280)).toBe(PANEL_DEFAULT);
  });

  // Narrow window: the ceiling shrinks to keep WORKSPACE_MIN (360) for the
  // workspace — innerWidth - rail(56) - 360.
  it("shrinks the ceiling so the workspace keeps its minimum", () => {
    // 768 - 56 - 360 = 352
    expect(clampPanelWidth(480, 768)).toBe(352);
    // Even when the math goes below the floor, never returns < PANEL_MIN.
    expect(clampPanelWidth(480, 480)).toBe(PANEL_MIN);
  });

  it("rounds to whole pixels", () => {
    expect(Number.isInteger(clampPanelWidth(272.6, 1280))).toBe(true);
  });
});
