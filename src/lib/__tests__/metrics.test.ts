// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computeMetrics, fontString } from "../term/metrics";

describe("computeMetrics", () => {
  it("rounds the cell box to integer device pixels", () => {
    const m = computeMetrics({
      advanceCssPx: 7.53,
      lineHeightCssPx: 17,
      ascentCssPx: 10,
      descentCssPx: 3,
      fontPx: 12.5,
      font: "12.5px mono",
      dpr: 2,
    });
    expect(m.cellW).toBe(15); // round(7.53*2)
    expect(m.cellH).toBe(34); // round(17*2)
    expect(Number.isInteger(m.cellW)).toBe(true);
    expect(Number.isInteger(m.cellH)).toBe(true);
    expect(m.dpr).toBe(2);
  });

  it("centres the baseline within the line box (half-leading)", () => {
    const m = computeMetrics({
      advanceCssPx: 8,
      lineHeightCssPx: 20,
      ascentCssPx: 12,
      descentCssPx: 4,
      fontPx: 16,
      font: "16px mono",
      dpr: 1,
    });
    // ink = 16; topPad = (20-16)/2 = 2; baseline = round(2 + 12) = 14
    expect(m.baseline).toBe(14);
  });

  it("never collapses to a zero-size cell", () => {
    const m = computeMetrics({
      advanceCssPx: 0,
      lineHeightCssPx: 0,
      ascentCssPx: 0,
      descentCssPx: 0,
      fontPx: 1,
      font: "1px mono",
      dpr: 1,
    });
    expect(m.cellW).toBe(1);
    expect(m.cellH).toBe(1);
  });
});

describe("fontString", () => {
  it("builds the CSS shorthand with weight/style", () => {
    expect(fontString(12.5, "Mono")).toBe("400 12.5px Mono");
    expect(fontString(12.5, "Mono", true)).toBe("700 12.5px Mono");
    expect(fontString(12.5, "Mono", false, true)).toBe("italic 400 12.5px Mono");
    expect(fontString(12.5, "Mono", true, true)).toBe("italic 700 12.5px Mono");
  });
});
