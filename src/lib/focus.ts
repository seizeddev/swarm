// SPDX-License-Identifier: GPL-3.0-or-later

// The natively-focusable element types plus anything carrying an explicit
// tabindex. Disabled/hidden state is filtered below (a CSS selector can't see
// `aria-hidden` reliably across the tree).
const FOCUSABLE_SELECTOR = ["a[href]", "button", "input", "textarea", "select", "[tabindex]"].join(
  ",",
);

/**
 * Focusable descendants of `root`, in document order — the candidates a modal's
 * focus trap cycles through. Excludes elements that can't actually take focus:
 * tabindex=-1, disabled, hidden, or aria-hidden.
 */
export function focusablesWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute("disabled") &&
      !el.hidden &&
      el.getAttribute("aria-hidden") !== "true",
  );
}
