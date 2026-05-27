// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Roving-tabindex math for a 1-D widget (a tablist, a menu). Given the focused
 * index and a key, returns the index to move to — wrapping at both ends — or
 * `null` when the key isn't a navigation key, so the caller can leave focus put
 * and not preventDefault. Both axes are handled (Arrow Left/Up = back, Right/Down
 * = forward) so the same helper drives the horizontal tab strip and the vertical
 * context menu.
 */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
