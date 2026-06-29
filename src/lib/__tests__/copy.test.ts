// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The toast layer is mocked — this asserts copyToClipboard's observable behavior
// (what it writes + which confirmation it raises), not toast's internals.
vi.mock("../toast", () => ({ toast: vi.fn() }));
import { toast } from "../toast";
import { copyToClipboard } from "../copy";

describe("copyToClipboard", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("writes the text and raises a labelled confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    copyToClipboard("hello", "path");
    expect(writeText).toHaveBeenCalledWith("hello");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Copied path", "info"));
  });

  it("falls back to a generic label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    copyToClipboard("x");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Copied to clipboard", "info"));
  });

  it("surfaces a denied write as an error toast instead of swallowing it", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    copyToClipboard("x", "path");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't copy to clipboard", "error"),
    );
  });
});
