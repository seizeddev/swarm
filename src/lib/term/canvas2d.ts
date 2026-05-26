// SPDX-License-Identifier: GPL-3.0-or-later
// Canvas2D rendering backend: the always-available baseline and WebGL2 fallback.
// Paints only the dirty rows (bg fill + atlas glyphs), then the selection tint and
// the cursor overlay. Draws in device pixels — the atlas glyphs are already
// device-sized, so there is no ctx scaling and nothing drifts off the pixel grid.
import { F_DIM, F_HIDDEN, F_INVERSE, resolveColor, selectionCss, TERM_BG, TERM_FG } from "../theme";
import type { CellMetrics } from "./metrics";
import type { GlyphAtlas } from "./atlas";
import type { RenderFrame, RendererBackend } from "./renderer";
import { cellInRange } from "./select";
import type { WireRun } from "../types";

/* v8 ignore start -- requires a real 2D canvas context (node test env has none). */

export class Canvas2DBackend implements RendererBackend {
  readonly kind = "canvas2d" as const;
  private ctx: CanvasRenderingContext2D;
  private metrics: CellMetrics;
  private atlas: GlyphAtlas;

  constructor(canvas: HTMLCanvasElement, metrics: CellMetrics, atlas: GlyphAtlas) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas2d: 2D context unavailable");
    this.ctx = ctx;
    this.metrics = metrics;
    this.atlas = atlas;
  }

  resize(deviceW: number, deviceH: number): void {
    const c = this.ctx.canvas;
    if (c.width !== deviceW || c.height !== deviceH) {
      c.width = deviceW;
      c.height = deviceH;
    }
  }

  setMetrics(metrics: CellMetrics, atlas: GlyphAtlas): void {
    this.metrics = metrics;
    this.atlas = atlas;
  }

  draw(frame: RenderFrame): void {
    this.atlas.beginFrame();
    const { grid, dirty } = frame;
    const { cellW, cellH } = this.metrics;
    const rows = dirty ?? Array.from({ length: grid.rows }, (_, i) => i);
    for (const y of rows) this.drawRow(frame, y, cellW, cellH);
    // Cursor overlay sits on top of whatever rows were repainted this frame; its
    // own row is always in `dirty` (Grid marks it), so it never leaves a ghost.
    this.drawCursor(frame, cellW, cellH);
  }

  private drawRow(frame: RenderFrame, y: number, cellW: number, cellH: number): void {
    const { grid, selection, hover } = frame;
    const ctx = this.ctx;
    const top = y * cellH;
    // Clear the whole row to the terminal background first.
    ctx.fillStyle = TERM_BG;
    ctx.fillRect(0, top, grid.cols * cellW, cellH);

    const runs = grid.lines[y];
    let col = 0;
    if (runs) {
      for (const run of runs) {
        col = this.drawRun(run, col, top, cellW, cellH);
      }
    }

    // Selection tint over the cells of this row that fall in range.
    if (selection) {
      for (let x = 0; x < grid.cols; x++) {
        if (cellInRange({ col: x, row: y }, selection.start, selection.end)) {
          ctx.fillStyle = selectionCss();
          let run = x;
          while (run < grid.cols && cellInRange({ col: run, row: y }, selection.start, selection.end))
            run++;
          ctx.fillRect(x * cellW, top, (run - x) * cellW, cellH);
          x = run;
        }
      }
    }

    // Hovered hyperlink underline.
    if (hover && hover.row === y) {
      ctx.fillStyle = TERM_FG;
      const x0 = hover.startCol * cellW;
      ctx.fillRect(x0, top + cellH - Math.max(1, Math.round(this.metrics.dpr)), (hover.endCol - hover.startCol + 1) * cellW, Math.max(1, Math.round(this.metrics.dpr)));
    }
  }

  private drawRun(run: WireRun, col: number, top: number, cellW: number, cellH: number): number {
    const ctx = this.ctx;
    let fg = resolveColor(run.fg, "fg");
    let bg = resolveColor(run.bg, "bg");
    if (run.flags & F_INVERSE) [fg, bg] = [bg, fg];
    const hidden = (run.flags & F_HIDDEN) !== 0;
    const dim = (run.flags & F_DIM) !== 0;

    const chars = [...run.text];
    // Background fill for the run (skip when it's the default terminal bg — the row
    // was already cleared to it).
    if (bg !== TERM_BG) {
      ctx.fillStyle = bg;
      ctx.fillRect(col * cellW, top, chars.length * cellW, cellH);
    }
    if (hidden) return col + chars.length;

    ctx.globalAlpha = dim ? 0.6 : 1;
    const SPACE = " ";
    for (const ch of chars) {
      if (ch !== SPACE) {
        const slot = this.atlas.get(ch, run.flags, fg);
        const w = slot.wide ? cellW * 2 : cellW;
        ctx.drawImage(this.atlas.canvas, slot.x, slot.y, w, cellH, col * cellW, top, w, cellH);
      }
      col++;
    }
    ctx.globalAlpha = 1;
    return col;
  }

  private drawCursor(frame: RenderFrame, cellW: number, cellH: number): void {
    const { grid, focused } = frame;
    if (!grid.cursorVisible) return;
    const y = grid.cursorY;
    if (y < 0 || y >= grid.rows) return;
    this.ctx.globalAlpha = focused ? 0.85 : 0.32;
    this.ctx.fillStyle = TERM_FG;
    this.ctx.fillRect(grid.cursorX * cellW, y * cellH, cellW, cellH);
    this.ctx.globalAlpha = 1;
  }

  dispose(): void {
    /* nothing to release for 2D */
  }
}
/* v8 ignore stop */
