import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaf } from "../layout";
import { loadSnap, type Snap, saveSnap } from "../persist";

// Mock the Tauri IPC boundary — persist.ts must not touch the real backend.
vi.mock("../ipc", () => ({
  api: {
    saveSession: vi.fn(),
    loadSession: vi.fn(),
  },
}));

import { api } from "../ipc";

const sampleSnap = (): Snap => ({
  v: 1,
  activeWorkspaceId: "ws-1",
  workspaces: [
    {
      id: "ws-1",
      repoPath: "/repo",
      panel: "terminals",
      activeTab: "tab-1",
      tabs: [{ id: "tab-1", layout: leaf("pane-1"), activeLeaf: "pane-1" }],
      panes: [
        {
          paneId: "pane-1",
          tabId: "tab-1",
          agentId: "claude",
          command: "claude",
          args: [],
          cwd: "/repo",
          title: "Claude Code",
          sessionId: "uuid-1",
        },
      ],
    },
  ],
});

beforeEach(() => {
  vi.mocked(api.saveSession).mockResolvedValue(undefined);
  vi.mocked(api.loadSession).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("saveSnap", () => {
  it("serializes the snapshot and forwards it to the backend", () => {
    const snap = sampleSnap();
    saveSnap(snap);
    expect(api.saveSession).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(api.saveSession).mock.calls[0][0];
    expect(JSON.parse(arg)).toEqual(snap);
  });

  it("swallows backend rejections without throwing", () => {
    vi.mocked(api.saveSession).mockRejectedValue(new Error("disk full"));
    expect(() => saveSnap(sampleSnap())).not.toThrow();
  });
});

describe("loadSnap", () => {
  it("parses a stored snapshot", async () => {
    const snap = sampleSnap();
    vi.mocked(api.loadSession).mockResolvedValue(JSON.stringify(snap));
    await expect(loadSnap()).resolves.toEqual(snap);
  });

  it("returns null when nothing is stored", async () => {
    vi.mocked(api.loadSession).mockResolvedValue(null);
    await expect(loadSnap()).resolves.toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.mocked(api.loadSession).mockResolvedValue("{not json");
    await expect(loadSnap()).resolves.toBeNull();
  });

  it("returns null when the backend call rejects", async () => {
    vi.mocked(api.loadSession).mockRejectedValue(new Error("ipc down"));
    await expect(loadSnap()).resolves.toBeNull();
  });
});
