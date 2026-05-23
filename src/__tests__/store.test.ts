import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDef, RepoInfo } from "../lib/types";

// Mock the Tauri IPC boundary. Every backend call is a vi.fn() we configure
// per-test; the store logic itself runs for real.
vi.mock("../lib/ipc", () => ({
  api: {
    repoInfo: vi.fn(),
    listWorktrees: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    changes: vi.fn(),
    fileDiff: vi.fn(),
    diffStats: vi.fn(),
    listBranches: vi.fn(),
    gitLog: vi.fn(),
    commitDetail: vi.fn(),
    commitFileDiff: vi.fn(),
    commitDiff: vi.fn(),
    saveSession: vi.fn(),
    loadSession: vi.fn(),
    eventsDir: vi.fn(),
    prepareCodexHome: vi.fn(),
    commitAll: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    commit: vi.fn(),
    prForBranch: vi.fn(),
    prList: vi.fn(),
    ghLogin: vi.fn(),
    ghAvailable: vi.fn(),
    listAgents: vi.fn(),
    claudeSessionExists: vi.fn(),
    ptySpawn: vi.fn(),
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    ptyKill: vi.fn(),
    ptyAlive: vi.fn(),
  },
}));

// Mock the self-update boundary the same way: the plugin calls are vi.fn()s,
// the store's lifecycle logic runs for real.
vi.mock("../lib/updater", () => ({
  updater: {
    check: vi.fn(),
    downloadAndInstall: vi.fn(),
    relaunch: vi.fn(),
  },
}));

import { api } from "../lib/ipc";
import { updater } from "../lib/updater";
import { useActiveWorkspace, useStore } from "../store";

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const upd = updater as unknown as Record<string, ReturnType<typeof vi.fn>>;

const SHELL: AgentDef = {
  id: "shell",
  name: "Shell",
  command: "bash",
  args: [],
  installed: true,
  resume: [],
};
const CLAUDE: AgentDef = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  args: [],
  installed: true,
  resume: ["--continue"],
};

const repo = (path = "/repo"): RepoInfo => ({
  path,
  name: path.split("/").pop()!,
  headBranch: "main",
  headShort: "abc1234",
  isDetached: false,
  remoteUrl: null,
  dirty: false,
});

const INITIAL = {
  workspaces: [],
  activeWorkspaceId: null,
  panes: [],
  notifications: [],
  agents: [],
  ghAvailable: false,
  busy: false,
  error: null,
  hydrated: false,
  sidebarVisible: true,
  eventsDir: null,
  codexHome: null,
  update: { status: "idle" as const, progress: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ ...INITIAL });
  // Sensible resolved defaults; tests override as needed.
  m.repoInfo.mockResolvedValue(repo());
  m.ghAvailable.mockResolvedValue(false);
  m.listAgents.mockResolvedValue([SHELL, CLAUDE]);
  m.claudeSessionExists.mockResolvedValue(true);
  m.changes.mockResolvedValue([]);
  m.diffStats.mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
  m.eventsDir.mockResolvedValue("/events");
  m.prepareCodexHome.mockResolvedValue("/codex-home");
  m.ghLogin.mockResolvedValue("octocat");
  m.prList.mockResolvedValue([]);
  m.loadSession.mockResolvedValue(null);
  for (const fn of ["stage", "unstage", "stageAll", "unstageAll", "saveSession"]) {
    m[fn].mockResolvedValue(undefined);
  }
  m.commit.mockResolvedValue("deadbee");
  m.commitAll.mockResolvedValue("deadbee");
  upd.check.mockResolvedValue(null);
  upd.downloadAndInstall.mockResolvedValue(undefined);
  upd.relaunch.mockResolvedValue(undefined);
});

const s = () => useStore.getState();

describe("addWorkspace", () => {
  it("creates a workspace, makes it active, and spawns one shell pane", async () => {
    await s().addWorkspace("/repo");
    const st = s();
    expect(st.workspaces).toHaveLength(1);
    expect(st.activeWorkspaceId).toBe(st.workspaces[0].id);
    expect(st.panes).toHaveLength(1);
    expect(st.panes[0].agentId).toBe("shell");
    expect(st.panes[0].cwd).toBe("/repo");
    expect(st.busy).toBe(false);
  });

  it("refreshes git status for the new workspace", async () => {
    m.changes.mockResolvedValue([
      { path: "a.txt", oldPath: null, status: "modified", staged: false, unstaged: true },
    ]);
    m.diffStats.mockResolvedValue({ filesChanged: 1, insertions: 2, deletions: 1 });
    await s().addWorkspace("/repo");
    const ws = s().workspaces[0];
    expect(ws.changes).toHaveLength(1);
    expect(ws.diffStats).toEqual({ filesChanged: 1, insertions: 2, deletions: 1 });
  });

  it("records an error and clears busy when the repo cannot be opened", async () => {
    m.repoInfo.mockRejectedValue(new Error("not a git repository"));
    await s().addWorkspace("/bad");
    expect(s().error).toBe("not a git repository");
    expect(s().busy).toBe(false);
    expect(s().workspaces).toHaveLength(0);
  });

  it("loads the gh login and PRs when gh is available", async () => {
    m.ghAvailable.mockResolvedValue(true);
    m.prList.mockResolvedValue([
      {
        number: 7,
        title: "Feat",
        url: "u",
        state: "OPEN",
        isDraft: false,
        author: "me",
        headRef: "feat",
        reviewDecision: null,
        checks: "passing",
      },
    ]);
    await s().addWorkspace("/repo");
    await vi.waitFor(() => expect(s().workspaces[0].prs).toHaveLength(1));
    expect(s().workspaces[0].ghLogin).toBe("octocat");
  });
});

describe("pane creation", () => {
  beforeEach(async () => {
    useStore.setState({ agents: [SHELL, CLAUDE], eventsDir: "/events" });
    await s().addWorkspace("/repo");
  });

  it("gives a Claude pane a session id and instrumented launch args", () => {
    s().addPane(CLAUDE);
    const pane = s().panes.find((p) => p.agentId === "claude")!;
    expect(pane.sessionId).toBeTruthy();
    expect(pane.args).toContain("--session-id");
    expect(pane.args).toContain(pane.sessionId);
    expect(pane.args).toContain("--settings");
  });

  it("wires SWARM_EVENT_FILE into each pane's env", () => {
    const pane = s().panes[0];
    expect(pane.env).toContainEqual(["SWARM_EVENT_FILE", `/events/${pane.paneId}`]);
  });

  it("adds CODEX_HOME only for codex panes", () => {
    useStore.setState({ codexHome: "/codex-home" });
    const codex: AgentDef = { ...SHELL, id: "codex", name: "Codex", command: "codex" };
    s().addPane(codex);
    const pane = s().panes.find((p) => p.agentId === "codex")!;
    expect(pane.env).toContainEqual(["CODEX_HOME", "/codex-home"]);
  });

  it("opens each new pane in its own tab and makes it active", () => {
    const before = s().workspaces[0].tabs.length;
    s().addPane(SHELL);
    const ws = s().workspaces[0];
    expect(ws.tabs.length).toBe(before + 1);
    expect(ws.activeTab).toBe(ws.tabs[ws.tabs.length - 1].id);
  });
});

describe("split + remove panes", () => {
  beforeEach(async () => {
    useStore.setState({ agents: [SHELL, CLAUDE] });
    await s().addWorkspace("/repo");
  });

  it("splits the active pane into a two-leaf layout", () => {
    s().splitActive("row", SHELL);
    const ws = s().workspaces[0];
    const tab = ws.tabs.find((t) => t.id === ws.activeTab)!;
    expect(tab.layout.type).toBe("split");
    expect(s().panes.filter((p) => p.tabId === tab.id)).toHaveLength(2);
  });

  it("collapses the split back to the sibling when one pane is removed", () => {
    s().splitActive("row", SHELL);
    const ws = s().workspaces[0];
    const tab = ws.tabs.find((t) => t.id === ws.activeTab)!;
    const [, second] = s().panes.filter((p) => p.tabId === tab.id);
    s().removePane(second.paneId);
    const after = s().workspaces[0].tabs.find((t) => t.id === tab.id)!;
    expect(after.layout.type).toBe("leaf");
    expect(after.activeLeaf).not.toBe(second.paneId);
  });

  it("removes the tab entirely when its last pane is closed", () => {
    const ws = s().workspaces[0];
    const tab = ws.tabs[0];
    const only = s().panes.find((p) => p.tabId === tab.id)!;
    s().removePane(only.paneId);
    const after = s().workspaces[0];
    expect(after.tabs.find((t) => t.id === tab.id)).toBeUndefined();
    expect(after.activeTab).toBeNull();
  });
});

describe("editor + panel switching", () => {
  beforeEach(async () => {
    await s().addWorkspace("/repo");
  });

  it("opens a diff editor and returns to the terminal", () => {
    s().openDiff("a.txt", false);
    expect(s().workspaces[0].editor).toEqual({ type: "diff", file: "a.txt", staged: false });
    s().showTerminal();
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
  });

  it("opens a commit editor by oid", () => {
    s().openCommit("abc123");
    expect(s().workspaces[0].editor).toEqual({ type: "commit", oid: "abc123" });
  });

  it("switches the sidebar panel and forces the sidebar visible", () => {
    useStore.setState({ sidebarVisible: false });
    s().setPanel("scm");
    expect(s().workspaces[0].panel).toBe("scm");
    expect(s().sidebarVisible).toBe(true);
  });

  it("leaves the editor untouched when switching to a non-terminal panel", () => {
    s().openDiff("a.txt", false);
    s().setPanel("prs");
    expect(s().workspaces[0].editor).toEqual({ type: "diff", file: "a.txt", staged: false });
  });

  it("restores the terminal editor when selecting the terminals panel", () => {
    s().openCommit("abc123");
    s().setPanel("scm");
    expect(s().workspaces[0].editor).toEqual({ type: "commit", oid: "abc123" });
    s().setPanel("terminals");
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].panel).toBe("terminals");
  });

  it("toggles the sidebar", () => {
    const before = s().sidebarVisible;
    s().toggleSidebar();
    expect(s().sidebarVisible).toBe(!before);
  });
});

describe("notifications + attention", () => {
  let ptyId: string;
  let paneId: string;
  beforeEach(async () => {
    await s().addWorkspace("/repo");
    paneId = s().panes[0].paneId;
    ptyId = "pty-1";
    s().bindPty(paneId, ptyId);
  });

  it("suppresses notifications while the pane is visible", () => {
    s().onNotify(ptyId, "Title", "Body");
    expect(s().notifications).toHaveLength(0);
    expect(s().panes[0].attention).toBe(false);
  });

  it("records a notification + attention when the pane is not visible", () => {
    s().openDiff("a.txt", false); // pane no longer visible (editor != terminal)
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications).toHaveLength(1);
    expect(s().notifications[0]).toMatchObject({ paneId, title: "Build", body: "Done" });
    expect(s().panes[0].attention).toBe(true);
  });

  it("falls back to the pane title when the notification title is empty", () => {
    s().openDiff("a.txt", false);
    s().onNotify(ptyId, "", "body only");
    expect(s().notifications[0].title).toBe(s().panes[0].title);
  });

  it("flags attention without a notification on onAttention", () => {
    s().openDiff("a.txt", false);
    s().onAttention(ptyId);
    expect(s().notifications).toHaveLength(0);
    expect(s().panes[0].attention).toBe(true);
  });

  it("clears attention when the pane is selected", () => {
    s().openDiff("a.txt", false);
    s().onAttention(ptyId);
    expect(s().panes[0].attention).toBe(true);
    s().selectPane(paneId);
    expect(s().panes[0].attention).toBe(false);
  });

  it("updates the pane title on onTitle and ignores blank titles", () => {
    s().onTitle(ptyId, "  vim  ");
    expect(s().panes[0].title).toBe("vim");
    s().onTitle(ptyId, "   ");
    expect(s().panes[0].title).toBe("vim");
  });

  it("caps stored notifications at 100", () => {
    s().openDiff("a.txt", false);
    for (let i = 0; i < 130; i++) s().onPaneNotify(paneId, `n${i}`);
    expect(s().notifications.length).toBe(100);
    // newest first
    expect(s().notifications[0].body).toBe("n129");
  });

  it("clears all notifications", () => {
    s().openDiff("a.txt", false);
    s().onNotify(ptyId, "x", "y");
    s().clearNotifications();
    expect(s().notifications).toHaveLength(0);
  });

  it("dismisses a single notification by id, leaving the rest", () => {
    s().openDiff("a.txt", false);
    s().onPaneNotify(paneId, "first");
    s().onPaneNotify(paneId, "second");
    const target = s().notifications.find((n) => n.body === "first")!;
    s().dismissNotification(target.id);
    expect(s().notifications.map((n) => n.body)).toEqual(["second"]);
  });
});

describe("workspace navigation", () => {
  beforeEach(async () => {
    await s().addWorkspace("/a");
    m.repoInfo.mockResolvedValue(repo("/b"));
    await s().addWorkspace("/b");
    m.repoInfo.mockResolvedValue(repo("/c"));
    await s().addWorkspace("/c");
  });

  it("cycles forward and wraps around", () => {
    const ids = s().workspaces.map((w) => w.id);
    s().setActiveWorkspace(ids[2]);
    s().cycleWorkspace(1);
    expect(s().activeWorkspaceId).toBe(ids[0]);
  });

  it("cycles backward and wraps around", () => {
    const ids = s().workspaces.map((w) => w.id);
    s().setActiveWorkspace(ids[0]);
    s().cycleWorkspace(-1);
    expect(s().activeWorkspaceId).toBe(ids[2]);
  });

  it("focuses a workspace by 1-based index", () => {
    const ids = s().workspaces.map((w) => w.id);
    s().focusWorkspaceIndex(2);
    expect(s().activeWorkspaceId).toBe(ids[1]);
  });

  it("ignores an out-of-range index", () => {
    const before = s().activeWorkspaceId;
    s().focusWorkspaceIndex(99);
    expect(s().activeWorkspaceId).toBe(before);
  });

  it("closes a workspace and re-points active to a survivor", () => {
    const ids = s().workspaces.map((w) => w.id);
    s().setActiveWorkspace(ids[1]);
    s().closeWorkspace(ids[1]);
    expect(s().workspaces.map((w) => w.id)).toEqual([ids[0], ids[2]]);
    expect(s().activeWorkspaceId).toBe(ids[0]);
    expect(s().panes.some((p) => p.workspaceId === ids[1])).toBe(false);
  });
});

describe("staging + commit", () => {
  beforeEach(async () => {
    await s().addWorkspace("/repo");
  });

  it("stages a path then refreshes status", async () => {
    await s().stage("a.txt");
    expect(m.stage).toHaveBeenCalledWith("/repo", ["a.txt"]);
    expect(m.changes).toHaveBeenCalledTimes(2); // once on add, once after stage
  });

  it("auto-stages everything when nothing is staged before committing", async () => {
    useStore.setState({
      workspaces: s().workspaces.map((w) => ({
        ...w,
        commitMsg: "do it",
        changes: [
          { path: "a.txt", oldPath: null, status: "modified", staged: false, unstaged: true },
        ],
      })),
    });
    await s().commit();
    expect(m.stageAll).toHaveBeenCalledWith("/repo");
    expect(m.commit).toHaveBeenCalledWith("/repo", "do it");
    expect(s().workspaces[0].commitMsg).toBe("");
  });

  it("does not auto-stage when a file is already staged", async () => {
    useStore.setState({
      workspaces: s().workspaces.map((w) => ({
        ...w,
        commitMsg: "msg",
        changes: [
          { path: "a.txt", oldPath: null, status: "modified", staged: true, unstaged: false },
        ],
      })),
    });
    await s().commit();
    expect(m.stageAll).not.toHaveBeenCalled();
    expect(m.commit).toHaveBeenCalled();
  });

  it("refuses to commit with an empty message", async () => {
    useStore.setState({
      workspaces: s().workspaces.map((w) => ({ ...w, commitMsg: "   " })),
    });
    await s().commit();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it("unstages a single path and the whole index", async () => {
    await s().unstage("a.txt");
    expect(m.unstage).toHaveBeenCalledWith("/repo", ["a.txt"]);
    await s().stageAll();
    expect(m.stageAll).toHaveBeenCalledWith("/repo");
    await s().unstageAll();
    expect(m.unstageAll).toHaveBeenCalledWith("/repo");
  });

  it("surfaces a commit failure as an error and clears busy", async () => {
    m.commit.mockRejectedValue(new Error("nothing to commit"));
    useStore.setState({
      workspaces: s().workspaces.map((w) => ({
        ...w,
        commitMsg: "msg",
        changes: [
          { path: "a.txt", oldPath: null, status: "modified", staged: true, unstaged: false },
        ],
      })),
    });
    await s().commit();
    expect(s().error).toBe("nothing to commit");
    expect(s().busy).toBe(false);
  });
});

describe("misc workspace actions", () => {
  beforeEach(async () => {
    await s().addWorkspace("/repo");
  });

  it("sets the commit message", () => {
    s().setCommitMsg("WIP");
    expect(s().workspaces[0].commitMsg).toBe("WIP");
  });

  it("opens a PR editor", () => {
    const pr = {
      number: 3,
      title: "T",
      url: "u",
      state: "OPEN",
      isDraft: false,
      author: "a",
      headRef: "h",
      reviewDecision: null,
      checks: null as null,
    };
    s().openPr(pr);
    expect(s().workspaces[0].editor).toMatchObject({ type: "pr", pr });
  });

  it("selects a tab and resets the editor to terminal", () => {
    s().openDiff("a.txt", false);
    const tabId = s().workspaces[0].activeTab!;
    s().selectTab(tabId);
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].activeTab).toBe(tabId);
  });

  it("selecting a tab from another panel returns the sidebar to terminals", () => {
    const tabId = s().workspaces[0].activeTab!;
    s().setPanel("notifications");
    s().openCommit("abc123");
    expect(s().workspaces[0].panel).toBe("notifications");
    s().selectTab(tabId);
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].panel).toBe("terminals");
  });

  it("selecting a pane from another panel returns the sidebar to terminals", () => {
    const paneId = s().panes[0].paneId;
    s().setPanel("scm");
    s().openDiff("a.txt", false);
    s().selectPane(paneId);
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].panel).toBe("terminals");
  });

  it("adjusts a split ratio", () => {
    s().splitActive("row", SHELL);
    const ws = s().workspaces[0];
    const tab = ws.tabs.find((t) => t.id === ws.activeTab)!;
    const splitNode = tab.layout as Extract<typeof tab.layout, { type: "split" }>;
    s().setRatio(splitNode.id, 0.7);
    const after = s().workspaces[0].tabs.find((t) => t.id === tab.id)!;
    expect((after.layout as typeof splitNode).ratio).toBeCloseTo(0.7);
  });

  it("closes the active pane via closeActivePane", () => {
    const before = s().panes.length;
    s().closeActivePane();
    expect(s().panes.length).toBe(before - 1);
  });

  it("swallows a PR list failure", async () => {
    m.prList.mockRejectedValue(new Error("gh missing"));
    await s().loadPrs(s().workspaces[0].id);
    expect(s().workspaces[0].prs).toEqual([]);
  });

  it("exposes the active workspace through the selector", () => {
    expect(useActiveWorkspace.length).toBe(0); // it is a hook factory (no args)
    const active = useStore.getState().workspaces.find((w) => w.id === s().activeWorkspaceId);
    expect(active).toBeDefined();
  });

  it("no-ops refreshStatus when the workspace id is unknown", async () => {
    m.changes.mockClear();
    await s().refreshStatus("does-not-exist");
    expect(m.changes).not.toHaveBeenCalled();
  });

  it("clears pane attention when switching to a workspace's active tab", () => {
    const ws = s().workspaces[0];
    const pane = s().panes[0];
    s().bindPty(pane.paneId, "p1");
    s().openDiff("x", false);
    s().onAttention("p1");
    expect(s().panes[0].attention).toBe(true);
    s().setActiveWorkspace(ws.id);
    expect(s().panes[0].attention).toBe(false);
  });
});

describe("guards on empty state", () => {
  it("cycleWorkspace is a no-op with no workspaces", () => {
    s().cycleWorkspace(1);
    expect(s().activeWorkspaceId).toBeNull();
  });

  it("addPane is a no-op with no active workspace", () => {
    s().addPane(SHELL);
    expect(s().panes).toHaveLength(0);
  });

  it("splitActive is a no-op with no active tab", () => {
    s().splitActive("row", SHELL);
    expect(s().panes).toHaveLength(0);
  });
});

describe("persist + hydrate", () => {
  it("does not persist before hydration completes", () => {
    s().persist();
    expect(m.saveSession).not.toHaveBeenCalled();
  });

  it("serializes workspaces + panes once hydrated", async () => {
    await s().addWorkspace("/repo");
    useStore.setState({ hydrated: true });
    s().persist();
    expect(m.saveSession).toHaveBeenCalledTimes(1);
    const snap = JSON.parse(m.saveSession.mock.calls[0][0]);
    expect(snap.v).toBe(1);
    expect(snap.workspaces).toHaveLength(1);
    expect(snap.workspaces[0].repoPath).toBe("/repo");
    expect(snap.workspaces[0].panes).toHaveLength(1);
  });

  it("rebuilds workspaces from a stored snapshot on hydrate", async () => {
    m.loadSession.mockResolvedValue(
      JSON.stringify({
        v: 1,
        activeWorkspaceId: "ws-1",
        workspaces: [
          {
            id: "ws-1",
            repoPath: "/repo",
            panel: "scm",
            activeTab: "tab-1",
            tabs: [{ id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" }],
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
      }),
    );
    await s().hydrate();
    expect(s().hydrated).toBe(true);
    expect(s().workspaces).toHaveLength(1);
    expect(s().activeWorkspaceId).toBe("ws-1");
    const pane = s().panes[0];
    // Claude restores via --resume <sessionId>
    expect(pane.args).toContain("--resume");
    expect(pane.args).toContain("uuid-1");
  });

  it("restores an unpersisted Claude session via --session-id, not --resume", async () => {
    // A session opened but never used has no transcript on disk, so `--resume`
    // would fail with "No conversation found". Restore must start it fresh,
    // reusing the same id via --session-id.
    m.claudeSessionExists.mockResolvedValue(false);
    m.loadSession.mockResolvedValue(
      JSON.stringify({
        v: 1,
        activeWorkspaceId: "ws-1",
        workspaces: [
          {
            id: "ws-1",
            repoPath: "/repo",
            panel: "scm",
            activeTab: "tab-1",
            tabs: [{ id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" }],
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
      }),
    );
    await s().hydrate();
    expect(m.claudeSessionExists).toHaveBeenCalledWith("uuid-1");
    const pane = s().panes[0];
    expect(pane.args).toContain("--session-id");
    expect(pane.args).toContain("uuid-1");
    expect(pane.args).not.toContain("--resume");
  });

  it("loads gh login + PRs for each restored workspace when gh is available", async () => {
    m.ghAvailable.mockResolvedValue(true);
    m.prList.mockResolvedValue([
      {
        number: 1,
        title: "P",
        url: "u",
        state: "OPEN",
        isDraft: false,
        author: "a",
        headRef: "h",
        reviewDecision: null,
        checks: null,
      },
    ]);
    m.loadSession.mockResolvedValue(
      JSON.stringify({
        v: 1,
        activeWorkspaceId: "ws-1",
        workspaces: [
          { id: "ws-1", repoPath: "/repo", panel: "terminals", activeTab: null, tabs: [], panes: [] },
        ],
      }),
    );
    await s().hydrate();
    await vi.waitFor(() => expect(s().workspaces[0].prs).toHaveLength(1));
    expect(s().workspaces[0].ghLogin).toBe("octocat");
  });

  it("drops a workspace whose repo no longer opens", async () => {
    m.loadSession.mockResolvedValue(
      JSON.stringify({
        v: 1,
        activeWorkspaceId: "ws-gone",
        workspaces: [
          { id: "ws-gone", repoPath: "/deleted", panel: "terminals", activeTab: null, tabs: [], panes: [] },
        ],
      }),
    );
    m.repoInfo.mockRejectedValue(new Error("gone"));
    await s().hydrate();
    expect(s().workspaces).toHaveLength(0);
    expect(s().hydrated).toBe(true);
  });
});

describe("self-update", () => {
  it("stays idle when the endpoint reports no update", async () => {
    upd.check.mockResolvedValue(null);
    await s().checkForUpdate();
    expect(s().update).toEqual({ status: "idle", progress: 0 });
  });

  it("goes to 'available' with version + notes when an update exists", async () => {
    upd.check.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Bug fixes",
    });
    await s().checkForUpdate();
    expect(s().update).toEqual({
      status: "available",
      version: "0.2.0",
      notes: "Bug fixes",
      progress: 0,
    });
  });

  it("clears a stale 'available' back to idle when the update vanishes", async () => {
    useStore.setState({ update: { status: "available", version: "0.2.0", progress: 0 } });
    upd.check.mockResolvedValue(null);
    await s().checkForUpdate();
    expect(s().update.status).toBe("idle");
  });

  it("never disturbs an in-flight download or a ready update", async () => {
    useStore.setState({ update: { status: "downloading", progress: 0.4 } });
    await s().checkForUpdate();
    expect(s().update).toEqual({ status: "downloading", progress: 0.4 });
    expect(upd.check).not.toHaveBeenCalled();

    useStore.setState({ update: { status: "ready", version: "0.2.0", progress: 1 } });
    await s().checkForUpdate();
    expect(s().update.status).toBe("ready");
    expect(upd.check).not.toHaveBeenCalled();
  });

  it("swallows check errors silently (offline / no updater in build)", async () => {
    upd.check.mockRejectedValue(new Error("network down"));
    await s().checkForUpdate();
    expect(s().update.status).toBe("idle");
  });

  it("installUpdate streams progress and ends at 'ready' without relaunching", async () => {
    useStore.setState({ update: { status: "available", version: "0.2.0", progress: 0 } });
    upd.downloadAndInstall.mockImplementation(async (onProgress: any) => {
      onProgress(0, 100);
      onProgress(50, 100);
      onProgress(100, 100);
    });
    await s().installUpdate();
    expect(s().update.status).toBe("ready");
    expect(s().update.progress).toBe(1);
    expect(upd.relaunch).not.toHaveBeenCalled();
  });

  it("installUpdate reports 0 progress when content length is unknown", async () => {
    useStore.setState({ update: { status: "available", version: "0.2.0", progress: 0 } });
    upd.downloadAndInstall.mockImplementation(async (onProgress: any) => {
      onProgress(42, null);
    });
    await s().installUpdate();
    expect(s().update.status).toBe("ready");
  });

  it("installUpdate goes to 'error' when the download fails", async () => {
    useStore.setState({ update: { status: "available", version: "0.2.0", progress: 0 } });
    upd.downloadAndInstall.mockRejectedValue(new Error("boom"));
    await s().installUpdate();
    expect(s().update.status).toBe("error");
  });

  it("installUpdate is a no-op unless an update is available", async () => {
    useStore.setState({ update: { status: "idle", progress: 0 } });
    await s().installUpdate();
    expect(upd.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("restartForUpdate relaunches only when ready", async () => {
    useStore.setState({ update: { status: "available", version: "0.2.0", progress: 0 } });
    await s().restartForUpdate();
    expect(upd.relaunch).not.toHaveBeenCalled();

    useStore.setState({ update: { status: "ready", version: "0.2.0", progress: 1 } });
    await s().restartForUpdate();
    expect(upd.relaunch).toHaveBeenCalledOnce();
  });
});
