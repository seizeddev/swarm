// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from "vitest";
import { confirmDialog, promptDialog, useDialogStore } from "../dialog";

beforeEach(() => useDialogStore.setState({ current: null, queue: [] }));

describe("dialog service", () => {
  it("confirm resolves true, then false, clearing current each time", async () => {
    const p = confirmDialog({ title: "Sure?" });
    expect(useDialogStore.getState().current?.kind).toBe("confirm");

    useDialogStore.getState().resolveCurrent(true);
    await expect(p).resolves.toBe(true);
    expect(useDialogStore.getState().current).toBeNull();

    const p2 = confirmDialog({ title: "Sure?" });
    useDialogStore.getState().resolveCurrent(false);
    await expect(p2).resolves.toBe(false);
  });

  it("prompt resolves the entered value, or null on cancel", async () => {
    const p = promptDialog({ title: "Name", defaultValue: "x" });
    expect(useDialogStore.getState().current?.kind).toBe("prompt");

    useDialogStore.getState().resolveCurrent("feature/foo");
    await expect(p).resolves.toBe("feature/foo");

    const p2 = promptDialog({ title: "Name" });
    useDialogStore.getState().resolveCurrent(null);
    await expect(p2).resolves.toBeNull();
  });

  it("queues parallel requests and resolves them FIFO", async () => {
    const a = confirmDialog({ title: "A" });
    const b = promptDialog({ title: "B" });
    // Only the first is shown; the second waits behind it.
    expect(useDialogStore.getState().current?.opts.title).toBe("A");
    expect(useDialogStore.getState().queue).toHaveLength(1);

    useDialogStore.getState().resolveCurrent(true);
    await expect(a).resolves.toBe(true);

    // Resolving the first promotes the queued one to current.
    expect(useDialogStore.getState().current?.opts.title).toBe("B");
    expect(useDialogStore.getState().queue).toHaveLength(0);

    useDialogStore.getState().resolveCurrent("hi");
    await expect(b).resolves.toBe("hi");
    expect(useDialogStore.getState().current).toBeNull();
  });

  it("resolveCurrent is a no-op when nothing is open", () => {
    expect(() => useDialogStore.getState().resolveCurrent(true)).not.toThrow();
    expect(useDialogStore.getState().current).toBeNull();
  });
});
