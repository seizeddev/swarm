// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from "react";

/** One entry in a context menu. A separator or a section header carry no action;
 *  an item is a clickable row (optionally destructive/disabled). */
export type MenuItem =
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      onClick: () => void;
      /** Render in the danger hue + tone (irreversible actions). */
      destructive?: boolean;
      disabled?: boolean;
    };

/** Open menu: where it was summoned and what it shows. `null` = closed. */
export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

/**
 * Keep a menu of size `w`×`h` fully on screen when opened at the cursor (`x`,`y`).
 * Flips the menu back inside the viewport edges (never spilling past them), with
 * a small `margin`. Pure — unit-tested, and shared by every context menu.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin = 8,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, vw - w - margin));
  const top = Math.max(margin, Math.min(y, vh - h - margin));
  return { left, top };
}
