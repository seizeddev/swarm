// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  hasMode,
  M_ALT_SCREEN,
  M_ALTERNATE_SCROLL,
  M_MOUSE_REPORT_CLICK,
  wheelScrollsBuffer,
} from "../term/mode";

describe("mode helpers", () => {
  it("hasMode tests a single bit", () => {
    expect(hasMode(M_ALT_SCREEN, M_ALT_SCREEN)).toBe(true);
    expect(hasMode(0, M_ALT_SCREEN)).toBe(false);
    expect(hasMode(M_ALT_SCREEN | M_ALTERNATE_SCROLL, M_ALTERNATE_SCROLL)).toBe(true);
  });

  it("wheelScrollsBuffer only when no mouse mode and not on the alt screen", () => {
    expect(wheelScrollsBuffer(0)).toBe(true);
    expect(wheelScrollsBuffer(M_MOUSE_REPORT_CLICK)).toBe(false); // program wants mouse
    expect(wheelScrollsBuffer(M_ALT_SCREEN)).toBe(false); // alt screen owns the wheel
  });
});
