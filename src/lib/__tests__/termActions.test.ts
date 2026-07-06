// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { dispatchTermAction, registerTermActions } from "../termActions";

describe("termActions registry", () => {
  it("dispatches copy/paste to the registered pane", () => {
    const copy = vi.fn();
    const paste = vi.fn();
    const off = registerTermActions("pane-1", { copy, paste });
    expect(dispatchTermAction("pane-1", "copy")).toBe(true);
    expect(dispatchTermAction("pane-1", "paste")).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledTimes(1);
    off();
    expect(dispatchTermAction("pane-1", "copy")).toBe(false);
  });

  it("is a no-op for unknown panes", () => {
    expect(dispatchTermAction("nope", "paste")).toBe(false);
  });

  it("a remount replaces the slot and a stale unregister leaves it alone", () => {
    const first = { copy: vi.fn(), paste: vi.fn() };
    const second = { copy: vi.fn(), paste: vi.fn() };
    const offFirst = registerTermActions("pane-2", first);
    registerTermActions("pane-2", second);
    offFirst(); // stale cleanup from the unmounted instance must not remove the live one
    expect(dispatchTermAction("pane-2", "copy")).toBe(true);
    expect(second.copy).toHaveBeenCalledTimes(1);
    expect(first.copy).not.toHaveBeenCalled();
  });
});
