// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { toast, useToastStore } from "../toast";

const reset = () => useToastStore.setState({ toasts: [] });

describe("toast store", () => {
  beforeEach(reset);

  it("push adds a toast, defaulting to the success kind", () => {
    useToastStore.getState().push("Committed");
    const t = useToastStore.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ message: "Committed", kind: "success" });
  });

  it("assigns each toast a unique id", () => {
    useToastStore.getState().push("a");
    useToastStore.getState().push("b");
    const [a, b] = useToastStore.getState().toasts;
    expect(a.id).not.toBe(b.id);
  });

  it("dismiss removes only the matching toast", () => {
    useToastStore.getState().push("a");
    useToastStore.getState().push("b");
    const firstId = useToastStore.getState().toasts[0].id;
    useToastStore.getState().dismiss(firstId);
    const left = useToastStore.getState().toasts;
    expect(left).toHaveLength(1);
    expect(left[0].message).toBe("b");
  });

  it("caps the stack at the most recent few, dropping the oldest", () => {
    for (let i = 0; i < 7; i++) useToastStore.getState().push(`t${i}`);
    const msgs = useToastStore.getState().toasts.map((t) => t.message);
    expect(msgs).toEqual(["t3", "t4", "t5", "t6"]);
  });

  it("the imperative toast() helper pushes with the requested kind", () => {
    toast("Copied path", "info");
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: "Copied path",
      kind: "info",
    });
  });
});
