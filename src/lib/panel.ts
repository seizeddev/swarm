// SPDX-License-Identifier: GPL-3.0-or-later
// Inspector-panel geometry. The panel width lives in a CSS custom property
// (`--panel-w`) rather than React state: the Sidebar's resize handle writes it
// straight to the DOM so a drag never re-renders the tree (the terminal/diff
// reflow off layout, not React). The TopBar's repo-identity block sizes to the
// same variable. This module is the single source for the bounds.
//
// Coverage-excluded (DOM boundary, like ipc.ts): the only branching logic —
// clampPanelWidth — is a pure function exercised by panel.test.ts.
export const PANEL_MIN = 220;
export const PANEL_DEFAULT = 272;
const PANEL_MAX = 480;
const RAIL_W = 56;
const WORKSPACE_MIN = 360;

// Clamp a requested width to the usable range at a given window width: never
// thinner than PANEL_MIN, never so wide the workspace starves below
// WORKSPACE_MIN (the ceiling shrinks with the window). Pure — no DOM.
export function clampPanelWidth(px: number, innerWidth: number): number {
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, innerWidth - RAIL_W - WORKSPACE_MIN));
  return Math.round(Math.max(PANEL_MIN, Math.min(max, px)));
}

// Widest the panel may grow at the current window size.
export function panelMax(): number {
  return clampPanelWidth(PANEL_MAX, window.innerWidth);
}

// Clamp to the live window bounds and write it to the document.
export function applyPanelWidth(px: number): void {
  document.documentElement.style.setProperty("--panel-w", `${clampPanelWidth(px, window.innerWidth)}px`);
}

// Current width as written to the DOM (falls back to the default).
export function currentPanelWidth(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panel-w"));
  return Number.isFinite(v) ? v : PANEL_DEFAULT;
}
