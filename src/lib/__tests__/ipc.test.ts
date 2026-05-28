// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri `invoke` boundary at module load. The `api` wrapper builds
// the invoke payload locally — what we want to assert is the payload shape,
// not the IPC plumbing.
const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeSpy(...args),
  Channel: class {
    onmessage?: (data: ArrayBuffer) => void;
  },
}));

import { api } from "../ipc";

beforeEach(() => {
  invokeSpy.mockReset();
  invokeSpy.mockResolvedValue(undefined);
});

describe("PTY handle threading (H-1)", () => {
  it("ptyWrite sends both id and token alongside the data", async () => {
    await api.ptyWrite({ id: "pty-x", token: "the-token" }, "hi");
    expect(invokeSpy).toHaveBeenCalledWith("pty_write", {
      id: "pty-x",
      token: "the-token",
      data: "hi",
    });
  });

  it("ptyResize threads the token alongside the cols/rows", async () => {
    await api.ptyResize({ id: "pty-y", token: "tok-y" }, 80, 24);
    expect(invokeSpy).toHaveBeenCalledWith("pty_resize", {
      id: "pty-y",
      token: "tok-y",
      cols: 80,
      rows: 24,
    });
  });

  it("ptyKill carries both halves of the handle", async () => {
    await api.ptyKill({ id: "pty-z", token: "tok-z" });
    expect(invokeSpy).toHaveBeenCalledWith("pty_kill", {
      id: "pty-z",
      token: "tok-z",
    });
  });

  it("ptyScroll threads the token", async () => {
    await api.ptyScroll({ id: "pty-w", token: "tok-w" }, -3);
    expect(invokeSpy).toHaveBeenCalledWith("pty_scroll", {
      id: "pty-w",
      token: "tok-w",
      delta: -3,
    });
  });

  it("ptySelectionText threads the token", async () => {
    await api.ptySelectionText({ id: "pty-q", token: "tok-q" }, [0, 0], [1, 5]);
    expect(invokeSpy).toHaveBeenCalledWith("pty_selection_text", {
      id: "pty-q",
      token: "tok-q",
      start: [0, 0],
      end: [1, 5],
    });
  });

  it("ptySetVisible threads the token", async () => {
    await api.ptySetVisible({ id: "pty-v", token: "tok-v" }, true);
    expect(invokeSpy).toHaveBeenCalledWith("pty_set_visible", {
      id: "pty-v",
      token: "tok-v",
      visible: true,
    });
  });
});
