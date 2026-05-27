// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { CheckCircle2, Clock, Dot, XCircle } from "lucide-react";
import { checkGlyph } from "../checks";

describe("checkGlyph", () => {
  it("passing → check glyph + matching label", () => {
    const g = checkGlyph("passing");
    expect(g.Icon).toBe(CheckCircle2);
    expect(g.label).toMatch(/passing/i);
  });

  it("failing → x glyph, danger tone", () => {
    const g = checkGlyph("failing");
    expect(g.Icon).toBe(XCircle);
    expect(g.color).toBe("var(--color-danger)");
    expect(g.label).toMatch(/failing/i);
  });

  it("pending → clock glyph, warning tone", () => {
    const g = checkGlyph("pending");
    expect(g.Icon).toBe(Clock);
    expect(g.color).toBe("var(--color-warning)");
    expect(g.label).toMatch(/pending/i);
  });

  it("absent/unknown checks → neutral dot + 'no checks' label", () => {
    for (const v of [null, "", "weird-value"]) {
      const g = checkGlyph(v);
      expect(g.Icon).toBe(Dot);
      expect(g.label).toMatch(/no checks/i);
    }
  });

  // The a11y guarantee: status is encoded by SHAPE, so the four states are
  // distinguishable without relying on colour alone.
  it("gives a distinct glyph per state", () => {
    const icons = new Set(
      ["passing", "failing", "pending", null].map((v) => checkGlyph(v).Icon),
    );
    expect(icons.size).toBe(4);
  });
});
