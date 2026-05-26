// SPDX-License-Identifier: GPL-3.0-or-later
// Resolves the compact color ints sent by the Rust core into CSS colors.
// Encoding: (v & 0x01000000) => truecolor in low 24 bits; 256 => fg; 257 => bg;
// 0..255 => the xterm palette below; anything else falls back to fg.

export const TERM_FG = "#d6d6db";
export const TERM_BG = "#161616";

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
