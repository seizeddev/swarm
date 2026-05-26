// SPDX-License-Identifier: GPL-3.0-or-later
// Glyph atlas: rasterize each (glyph, style, colour) once onto a 2D offscreen
// canvas and cache the slot, LRU-evicting when full. This is the single source of
// rasterized glyphs for BOTH backends — Canvas2D drawImage's straight from it, and
// WebGL2 uploads it as a texture. Because the glyphs are produced by the browser's
// own 2D text rasterizer in both cases, WebGL text is pixel-identical to Canvas2D
// (the classic "blurry WebGL terminal" trap is structurally avoided).
import { F_BOLD, F_ITALIC, F_STRIKE, F_UNDERLINE } from "../theme";
import { fontString, type CellMetrics } from "./metrics";

export interface GlyphSlot {
  // Pixel rect of the glyph inside the atlas canvas/texture.
  x: number;
  y: number;
  w: number;
  h: number;
  // True when the glyph spans two cells (wide CJK/emoji).
  wide: boolean;
}

// Cache key: the glyph plus everything that changes its pixels — style bits that
// affect rasterization (bold/italic/underline/strike/dim) and the resolved fg.
export function glyphKey(char: string, flags: number, fg: string): string {
  const styleBits = flags & (F_BOLD | F_ITALIC | F_UNDERLINE | F_STRIKE);
  return `${char}\u0000${styleBits}\u0000${fg}`;
}

/* v8 ignore start -- the atlas is a canvas object: rasterization and slot upload
   need a real 2D context, unavailable in the node test env. glyphKey above (the
   only pure logic) is exported and unit-tested; the rest is exercised live. */

const ATLAS_PX = 2048; // texture budget per axis (well within every GPU's limit)

// Transparent gutter (device px) reserved on the right and bottom of every slot.
// The backends sample exactly the glyph's cellW×cellH box from the slot origin,
// but NEAREST texture sampling can pick a texel one past the edge when the cell
// quad isn't a perfect 1:1 pixel map (fractional DPR / sub-pixel canvas size) —
// bleeding a thin strip of the *neighbouring* slot's glyph into the cell edge.
// Slots are stacked with no horizontal risk (a narrow glyph already leaves its 2nd
// cell-width empty), but vertically they were flush, so a green box-drawing glyph
// one row down in the atlas leaked a green sliver onto the bottom edge of the cell
// above. The gutter makes any such over-read land in cleared padding instead.
const SLOT_PAD = 2;

export class GlyphAtlas {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private metrics: CellMetrics;
  private family: string;
  private slotW = 1;
  private slotH = 1;
  private slotCols = 1;
  private capacity = 1;
  private freeList: number[] = [];
  private cache = new Map<string, { slot: GlyphSlot; index: number }>();
  // Slot indices already used (their UVs scheduled) in the current frame. The
  // eviction picker avoids these so a single oversized frame can't recycle a slot
  // it already drew from (the upload happens after the glyph loop). Cleared by
  // beginFrame() at the top of every backend draw().
  private usedThisFrame = new Set<number>();
  // Bumped whenever the backing pixels change wholesale (reset/eviction-clear), so
  // the WebGL backend knows to re-upload the texture.
  version = 0;

  constructor(metrics: CellMetrics, family: string) {
    this.metrics = metrics;
    this.family = family;
    this.canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(ATLAS_PX, ATLAS_PX)
        : Object.assign(document.createElement("canvas"), { width: ATLAS_PX, height: ATLAS_PX });
    const ctx = (this.canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: false });
    if (!ctx) throw new Error("atlas: 2D context unavailable");
    this.ctx = ctx as CanvasRenderingContext2D;
    this.layout();
  }

  // (Re)compute the slot grid for the current metrics and drop all cached glyphs.
  private layout(): void {
    // Every slot is two cells wide so a wide glyph fits without a second pass, plus
    // a transparent gutter (SLOT_PAD) on the right and bottom so edge bleed from
    // NEAREST sampling lands in cleared padding, never a neighbouring glyph.
    this.slotW = this.metrics.cellW * 2 + SLOT_PAD;
    this.slotH = this.metrics.cellH + SLOT_PAD;
    this.slotCols = Math.max(1, Math.floor(ATLAS_PX / this.slotW));
    const slotRows = Math.max(1, Math.floor(ATLAS_PX / this.slotH));
    this.capacity = this.slotCols * slotRows;
    this.freeList = Array.from({ length: this.capacity }, (_, i) => this.capacity - 1 - i);
    this.cache.clear();
    this.ctx.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    this.version++;
  }

  // Swap to new metrics (font size / DPR change): re-rasterize lazily from scratch.
  reset(metrics: CellMetrics): void {
    this.metrics = metrics;
    this.layout();
  }

  // Start a render frame: forget which slots were used last frame, so eviction can
  // recycle them again but never a slot scheduled earlier in *this* frame.
  beginFrame(): void {
    this.usedThisFrame.clear();
  }

  private slotRect(index: number): GlyphSlot {
    const col = index % this.slotCols;
    const row = Math.floor(index / this.slotCols);
    return { x: col * this.slotW, y: row * this.slotH, w: this.slotW, h: this.slotH, wide: false };
  }

  // Fetch the slot for a glyph, rasterizing on a miss. LRU: a hit is re-inserted so
  // the Map's insertion order is the eviction order; on overflow the oldest entry's
  // slot is recycled.
  get(char: string, flags: number, fg: string): GlyphSlot {
    const key = glyphKey(char, flags, fg);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.usedThisFrame.add(hit.index);
      return hit.slot;
    }
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop() as number;
    } else {
      // LRU eviction, but skip any victim already scheduled this frame (its UVs are
      // pending upload). Walk oldest→newest for the first free one; if every slot is
      // in use this frame (a single frame exceeding the whole atlas — degenerate),
      // fall back to the oldest.
      let victimKey: string | null = null;
      for (const [k, v] of this.cache) {
        if (!this.usedThisFrame.has(v.index)) {
          victimKey = k;
          break;
        }
      }
      const oldestKey = victimKey ?? (this.cache.keys().next().value as string);
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      index = oldest ? oldest.index : 0;
    }
    const slot = this.rasterize(index, char, flags, fg);
    this.cache.set(key, { slot, index });
    this.usedThisFrame.add(index);
    // A new glyph changed the backing pixels — bump the version so the WebGL2
    // backend re-uploads the texture (the Canvas2D backend reads the atlas canvas
    // directly, so it doesn't need this, but the bump is cheap and shared).
    this.version++;
    return slot;
  }

  private rasterize(index: number, char: string, flags: number, fg: string): GlyphSlot {
    const slot = this.slotRect(index);
    const ctx = this.ctx;
    ctx.clearRect(slot.x, slot.y, slot.w, slot.h);
    const bold = (flags & F_BOLD) !== 0;
    const italic = (flags & F_ITALIC) !== 0;
    ctx.font = fontString(this.metrics.fontPx, this.family, bold, italic);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = fg;
    // Match the device-pixel scale: the atlas is in device px, so scale the glyph.
    const adv = ctx.measureText(char).width * this.metrics.dpr;
    slot.wide = adv > this.metrics.cellW * 1.5;
    ctx.save();
    ctx.translate(slot.x, slot.y);
    ctx.scale(this.metrics.dpr, this.metrics.dpr);
    ctx.fillText(char, 0, this.metrics.baseline / this.metrics.dpr);
    ctx.restore();
    const lineW = Math.max(1, Math.round(this.metrics.dpr));
    if (flags & F_UNDERLINE) {
      ctx.fillRect(slot.x, slot.y + this.metrics.baseline + lineW, this.cellSpan(slot), lineW);
    }
    if (flags & F_STRIKE) {
      ctx.fillRect(slot.x, slot.y + Math.round(slot.h * 0.5), this.cellSpan(slot), lineW);
    }
    return slot;
  }

  private cellSpan(slot: GlyphSlot): number {
    return slot.wide ? this.metrics.cellW * 2 : this.metrics.cellW;
  }
}
/* v8 ignore stop */
