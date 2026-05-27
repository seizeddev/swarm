// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { focusablesWithin } from "../focus";

// Stub the minimal element/root surface focusablesWithin reads, so the predicate
// can be exercised in the node test env (no DOM). The selector handed to
// querySelectorAll is declarative; what matters is the filtering it applies.
interface Spec {
  id: string;
  tabIndex?: number;
  disabled?: boolean;
  hidden?: boolean;
  ariaHidden?: boolean;
}
function el(s: Spec): HTMLElement {
  return {
    id: s.id,
    tabIndex: s.tabIndex ?? 0,
    hidden: s.hidden ?? false,
    hasAttribute: (n: string) => (n === "disabled" ? !!s.disabled : false),
    getAttribute: (n: string) => (n === "aria-hidden" && s.ariaHidden ? "true" : null),
  } as unknown as HTMLElement;
}
function root(els: HTMLElement[]): ParentNode {
  return { querySelectorAll: () => els } as unknown as ParentNode;
}

describe("focusablesWithin", () => {
  it("returns focusable descendants in document order", () => {
    const els = [el({ id: "a" }), el({ id: "b" }), el({ id: "c" })];
    expect(focusablesWithin(root(els)).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes disabled, hidden, aria-hidden, and tabindex -1 elements", () => {
    const els = [
      el({ id: "ok" }),
      el({ id: "disabled", disabled: true }),
      el({ id: "hidden", hidden: true }),
      el({ id: "ariaHidden", ariaHidden: true }),
      el({ id: "removed", tabIndex: -1 }),
    ];
    expect(focusablesWithin(root(els)).map((e) => e.id)).toEqual(["ok"]);
  });

  it("returns an empty array when nothing is focusable", () => {
    expect(focusablesWithin(root([]))).toEqual([]);
  });
});
