// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The registry reads the store snapshot and dispatches store actions, so mock the
// same boundaries store.test mocks — the store logic itself runs for real.
vi.mock("../ipc", () => ({
  api: {
    listAgents: vi.fn().mockResolvedValue([]),
    ghAvailable: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock("../updater", () => ({
  updater: { check: vi.fn(), downloadAndInstall: vi.fn(), relaunch: vi.fn() },
}));
vi.mock("../notify", () => ({ notifyOS: vi.fn() }));

import { buildCommands, filterCommands, type CommandHandlers } from "../commands";
import { useStore } from "../../store";
import type { RepoInfo } from "../types";

const repo = (name: string): RepoInfo => ({ path: `/${name}`, name, headBranch: "main" });

const handlers = (): CommandHandlers => ({
  newWorkspace: vi.fn(),
  closeWorkspace: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  zoomReset: vi.fn(),
  openShortcuts: vi.fn(),
  openIntegrations: vi.fn(),
});

beforeEach(() => {
  useStore.setState({ workspaces: [], activeWorkspaceId: null, sidebarVisible: true });
});

describe("buildCommands", () => {
  it("includes the static commands with menu-matching ids", () => {
    const ids = buildCommands(handlers()).map((c) => c.id);
    for (const id of [
      "new_workspace",
      "ws_next",
      "new_terminal",
      "split_right",
      "split_down",
      "close_pane",
      "toggle_sidebar",
      "panel_scm",
      "panel_history",
      "zoom_in",
      "shortcuts",
      "agent_integrations",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("omits Close Project when no workspace is open, includes it otherwise", () => {
    expect(buildCommands(handlers()).some((c) => c.id === "close_workspace")).toBe(false);
    useStore.setState({
      workspaces: [{ id: "w1", repo: repo("a") } as any],
      activeWorkspaceId: "w1",
    });
    expect(buildCommands(handlers()).some((c) => c.id === "close_workspace")).toBe(true);
  });

  it("adds one 'Switch to' command per non-active workspace, honouring the name override", () => {
    useStore.setState({
      workspaces: [
        { id: "w1", repo: repo("alpha") } as any,
        { id: "w2", repo: repo("beta"), name: "Custom" } as any,
      ],
      activeWorkspaceId: "w1",
    });
    const switches = buildCommands(handlers()).filter((c) => c.id.startsWith("switch_ws_"));
    expect(switches).toHaveLength(1); // active w1 is skipped
    expect(switches[0].id).toBe("switch_ws_w2");
    expect(switches[0].label).toBe("Switch to Custom"); // override, not repo.name
  });

  it("dispatches every handler-backed command to the injected handlers", () => {
    const h = handlers();
    useStore.setState({
      workspaces: [{ id: "w1", repo: repo("a") } as any],
      activeWorkspaceId: "w1",
    });
    const cmds = buildCommands(h);
    const run = (id: string) => cmds.find((c) => c.id === id)!.run();
    run("new_workspace");
    run("close_workspace");
    run("zoom_in");
    run("zoom_out");
    run("zoom_reset");
    run("shortcuts");
    run("agent_integrations");
    expect(h.newWorkspace).toHaveBeenCalledOnce();
    expect(h.closeWorkspace).toHaveBeenCalledOnce();
    expect(h.zoomIn).toHaveBeenCalledOnce();
    expect(h.zoomOut).toHaveBeenCalledOnce();
    expect(h.zoomReset).toHaveBeenCalledOnce();
    expect(h.openShortcuts).toHaveBeenCalledOnce();
    expect(h.openIntegrations).toHaveBeenCalledOnce();
  });

  it("runs the terminal + project store-action commands", () => {
    useStore.setState({
      workspaces: [{ id: "w1", repo: repo("a") } as any],
      activeWorkspaceId: "w1",
    });
    const cmds = buildCommands(handlers());
    const spies = {
      addPane: vi.spyOn(useStore.getState(), "addPane").mockImplementation(() => {}),
      splitActive: vi.spyOn(useStore.getState(), "splitActive").mockImplementation(() => {}),
      closeActivePane: vi
        .spyOn(useStore.getState(), "closeActivePane")
        .mockImplementation(() => {}),
      setPanel: vi.spyOn(useStore.getState(), "setPanel").mockImplementation(() => {}),
      cycleWorkspace: vi.spyOn(useStore.getState(), "cycleWorkspace").mockImplementation(() => {}),
    };
    cmds.find((c) => c.id === "new_terminal")!.run();
    cmds.find((c) => c.id === "split_right")!.run();
    cmds.find((c) => c.id === "split_down")!.run();
    cmds.find((c) => c.id === "close_pane")!.run();
    cmds.find((c) => c.id === "panel_scm")!.run();
    cmds.find((c) => c.id === "panel_prs")!.run();
    cmds.find((c) => c.id === "panel_notifications")!.run();
    cmds.find((c) => c.id === "ws_next")!.run();
    cmds.find((c) => c.id === "ws_prev")!.run();
    expect(spies.addPane).toHaveBeenCalled();
    expect(spies.splitActive).toHaveBeenCalledWith("row");
    expect(spies.splitActive).toHaveBeenCalledWith("col");
    expect(spies.closeActivePane).toHaveBeenCalled();
    expect(spies.setPanel).toHaveBeenCalledWith("scm");
    expect(spies.cycleWorkspace).toHaveBeenCalledWith(1);
    expect(spies.cycleWorkspace).toHaveBeenCalledWith(-1);
  });

  it("runs store actions through the same path the menu uses", () => {
    const cmds = buildCommands(handlers());
    expect(useStore.getState().sidebarVisible).toBe(true);
    cmds.find((c) => c.id === "toggle_sidebar")!.run();
    expect(useStore.getState().sidebarVisible).toBe(false);

    useStore.setState({
      workspaces: [{ id: "w9", repo: repo("z") } as any],
      activeWorkspaceId: null,
    });
    buildCommands(handlers())
      .find((c) => c.id === "switch_ws_w9")!
      .run();
    expect(useStore.getState().activeWorkspaceId).toBe("w9");
  });
});

describe("filterCommands", () => {
  const sample = [
    { id: "a", label: "New Terminal", group: "Terminals" as const, run: () => {} },
    { id: "b", label: "Split Right", group: "Terminals" as const, run: () => {} },
    { id: "c", label: "Source Control", group: "View" as const, run: () => {} },
  ];

  it("returns everything for an empty query", () => {
    expect(filterCommands(sample, "  ")).toHaveLength(3);
  });

  it("matches as a case-insensitive subsequence", () => {
    expect(filterCommands(sample, "newterm").map((c) => c.id)).toEqual(["a"]);
    expect(filterCommands(sample, "src").map((c) => c.id)).toEqual(["c"]); // S-r-c subsequence
  });

  it("excludes non-matches", () => {
    expect(filterCommands(sample, "zzz")).toHaveLength(0);
  });
});
