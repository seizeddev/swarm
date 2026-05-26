// SPDX-License-Identifier: GPL-3.0-or-later
// The renderer abstraction: a backend draws the grid model onto one <canvas>.
// WebGL2 is the primary GPU path; Canvas2D is the always-available baseline and
// the fallback when WebGL2 is missing or its context is lost. Both share the glyph
// atlas, the integer cell metrics, and the dirty-row contract — only the draw
// calls differ. This file is the seam; the concrete backends live alongside it.
import type { CellMetrics } from "./metrics";
import type { GlyphAtlas } from "./atlas";
import type { Grid } from "./grid";
import type { Cell } from "./select";

// Everything a backend needs to paint one frame. `dirty` is the row list from
// Grid.takeDirty() (null = repaint all). The backend draws bg + glyphs for those
// rows, then the selection tint and the cursor overlay on top.
export interface RenderFrame {
  grid: Grid;
  dirty: number[] | null;
  selection: { start: Cell; end: Cell } | null;
  focused: boolean;
  // Inclusive cell range of the hovered OSC 8 link to underline, or null.
  hover: { row: number; startCol: number; endCol: number } | null;
}

export interface RendererBackend {
  readonly kind: "webgl2" | "canvas2d";
  // Resize the drawing buffer to an integer device-pixel size (cols×cellW, etc.).
  resize(deviceW: number, deviceH: number): void;
  // Re-bind metrics + atlas after a DPR / font-size change (forces a full repaint).
  setMetrics(metrics: CellMetrics, atlas: GlyphAtlas): void;
  // Paint one frame.
  draw(frame: RenderFrame): void;
  // Release GPU/canvas resources.
  dispose(): void;
}

/* v8 ignore start -- backend construction touches WebGL/Canvas, unavailable in
   the node test env; the backends themselves are coverage-excluded. */
import { Canvas2DBackend } from "./canvas2d";
import { WebGL2Backend } from "./webgl2";

// Build the best available backend for `canvas`. Tries WebGL2 first; on any
// failure (no context, init throws) falls back to Canvas2D, which always works.
// `onLost` is invoked when a WebGL2 context is lost, so the caller can rebuild
// (re-tries WebGL2, else lands on Canvas2D).
export function createRenderer(
  canvas: HTMLCanvasElement,
  metrics: CellMetrics,
  atlas: GlyphAtlas,
  onLost?: () => void,
): RendererBackend {
  // Escape hatch for diagnosing backend-specific rendering: set
  // `localStorage["swarm.renderer"] = "canvas2d"` (or "webgl2") to force one.
  let forced: string | null = null;
  try {
    forced = localStorage.getItem("swarm.renderer");
  } catch {
    /* localStorage unavailable (private mode / sandbox) — ignore */
  }
  if (forced === "canvas2d") return new Canvas2DBackend(canvas, metrics, atlas);
  try {
    const gl = WebGL2Backend.tryCreate(canvas, metrics, atlas);
    if (gl) {
      if (onLost) gl.setOnLost(onLost);
      return gl;
    }
  } catch {
    /* fall through to the Canvas2D baseline */
  }
  return new Canvas2DBackend(canvas, metrics, atlas);
}
/* v8 ignore stop */
