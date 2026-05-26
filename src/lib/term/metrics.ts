// SPDX-License-Identifier: GPL-3.0-or-later
// Cell metrics for the canvas renderers. The whole point of this module is to
// resolve the cell box to *integer device pixels* once, so glyphs land on the
// pixel grid and neither the cursor nor the text drifts across a row (the
// fractional-width drift that plagued the old DOM cell-grid). The pure maths is
// unit-tested; the one function that calls measureText is isolated and v8-ignored.

export interface CellMetrics {
  /** Cell advance width, integer device px. */
  cellW: number;
  /** Cell height (line box), integer device px. */
  cellH: number;
  /** Distance from the cell top to the alphabetic baseline, device px. */
  baseline: number;
  /** Device-pixel ratio the metrics were computed for. */
  dpr: number;
  /** CSS-px font size. */
  fontPx: number;
  /** CSS font shorthand used to rasterize (so the atlas matches exactly). */
  font: string;
}

// Combine the raw font measurements (all CSS px) and the DPR into integer device
// metrics. cellH is the line box; the baseline vertically centres the glyph ink
// box within it (half-leading above and below), which keeps text optically
// centred regardless of the font's intrinsic ascent/descent split.
export function computeMetrics(args: {
  advanceCssPx: number;
  lineHeightCssPx: number;
  ascentCssPx: number;
  descentCssPx: number;
  fontPx: number;
  font: string;
  dpr: number;
}): CellMetrics {
  const { advanceCssPx, lineHeightCssPx, ascentCssPx, descentCssPx, fontPx, font, dpr } = args;
  const cellW = Math.max(1, Math.round(advanceCssPx * dpr));
  const cellH = Math.max(1, Math.round(lineHeightCssPx * dpr));
  const inkHeight = (ascentCssPx + descentCssPx) * dpr;
  const topPad = (cellH - inkHeight) / 2;
  const baseline = Math.round(topPad + ascentCssPx * dpr);
  return { cellW, cellH, baseline, dpr, fontPx, font };
}

// Build the CSS font shorthand for a (weight, style, size, family) tuple — shared
// by the measurer and the atlas so a measured cell and a rasterized glyph use the
// byte-identical font string.
export function fontString(fontPx: number, family: string, bold = false, italic = false): string {
  const style = italic ? "italic " : "";
  const weight = bold ? "700 " : "400 ";
  return `${style}${weight}${fontPx}px ${family}`;
}

/* v8 ignore start -- measureText needs a real 2D context (no jsdom/node canvas);
   this is a thin wrapper over the pure computeMetrics above, which is tested. */
export function measureCell(
  ctx: CanvasRenderingContext2D,
  fontPx: number,
  family: string,
  lineHeightCssPx: number,
  dpr: number,
): CellMetrics {
  const font = fontString(fontPx, family);
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("M");
  // A monospace advance is stable across glyphs; measuring a 10-wide string and
  // dividing averages out any sub-pixel rounding in a single measureText.
  const advanceCssPx = ctx.measureText("MMMMMMMMMM").width / 10;
  const ascentCssPx = m.actualBoundingBoxAscent || fontPx * 0.8;
  const descentCssPx = m.actualBoundingBoxDescent || fontPx * 0.2;
  return computeMetrics({
    advanceCssPx,
    lineHeightCssPx,
    ascentCssPx,
    descentCssPx,
    fontPx,
    font,
    dpr,
  });
}
/* v8 ignore stop */
