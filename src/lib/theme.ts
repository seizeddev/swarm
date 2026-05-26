// SPDX-License-Identifier: GPL-3.0-or-later
// Resolves the compact color ints sent by the Rust core into CSS colors.
// Encoding: (v & 0x01000000) => truecolor in low 24 bits; 256 => fg; 257 => bg;
// 0..255 => the xterm palette below; anything else falls back to fg.

// The terminal's neutral grey default foreground and the surface (clear) colour.
// Only the *surface* is shared with the app — it must match the pane wrapper's
// `--color-bg-deep` so the sub-cell remainder around the grid is seamless, hence
// `let` (overwritten at mount from the live CSS via `setTerminalSurface`, so it
// tracks any future palette shift). The ANSI palette below and the neutral grey
// `TERM_FG` are the terminal's *own* contract — deliberately not app-themed.
export const TERM_FG = "#d6d6db";
export let TERM_BG = "#161513";

// Selection wash: a neutral white tint (brightness, not hue) — the app is strictly
// monochrome (colour is reserved for git status). Both backends draw from this one
// source so the WebGL2 and Canvas2D selection are identical.
export const TERM_SELECTION = { r: 255, g: 255, b: 255, a: 0.18 };

export function selectionCss(): string {
  const { r, g, b, a } = TERM_SELECTION;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Parse a CSS colour (`rgb()`/`rgba()`/`#rgb`/`#rrggbb`) into a `#rrggbb` hex
// string, or null if unparseable. Alpha is ignored — the terminal surface is opaque.
export function cssColorToHex(s: string): string | null {
  const str = s.trim();
  const rgb = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  if (rgb) {
    const r = Math.round(Number(rgb[1]));
    const g = Math.round(Number(rgb[2]));
    const b = Math.round(Number(rgb[3]));
    if ([r, g, b].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    return hex(r, g, b);
  }
  const m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1];
    if (h.length === 3) {
      return ("#" + h.split("").map((c) => c + c).join("")).toLowerCase();
    }
    return ("#" + h).toLowerCase();
  }
  return null;
}

// Set the terminal surface (canvas clear) colour. Ignores an unparseable input so
// a bad value never blanks the terminal.
export function setTerminalSurface(bg: string): void {
  const parsed = cssColorToHex(bg);
  if (parsed) TERM_BG = parsed;
}

// 16 base colors — a calm, modern dark theme for the terminal's ANSI palette.
const BASE16 = [
  "#1b1b1f", "#ff6b81", "#46d39a", "#e8c474",
  "#7c9dff", "#b288ff", "#5ad4d4", "#c7c7cf",
  "#3a3a42", "#ff8095", "#6ce0b3", "#f0d390",
  "#9bb4ff", "#c9a6ff", "#7fe6e6", "#f4f4f7",
];

function buildPalette(): string[] {
  const p = [...BASE16];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        p.push(hex(steps[r], steps[g], steps[b]));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(hex(v, v, v));
  }
  return p;
}

function hex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

const PALETTE = buildPalette();

export function resolveColor(v: number, kind: "fg" | "bg"): string {
  if (v & 0x01000000) {
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    return hex(r, g, b);
  }
  if (v === 256) return TERM_FG;
  if (v === 257) return TERM_BG;
  if (v >= 0 && v < 256) return PALETTE[v];
  return kind === "fg" ? TERM_FG : TERM_BG;
}

// flag bitmask from the Rust core
export const F_BOLD = 1;
export const F_ITALIC = 1 << 1;
export const F_UNDERLINE = 1 << 2;
export const F_INVERSE = 1 << 3;
export const F_DIM = 1 << 4;
export const F_STRIKE = 1 << 5;
export const F_HIDDEN = 1 << 6;
// Bit 7 is set by the core when a run carries an OSC 8 hyperlink (see WireRun.link).
export const F_HYPERLINK = 1 << 7;
