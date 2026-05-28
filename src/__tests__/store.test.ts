// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDef, RepoInfo } from "../lib/types";

// Mock the Tauri IPC boundary. Every backend call is a vi.fn() we configure
// per-test; the store logic itself runs for real.
vi.mock("../lib/ipc", () => ({
  api: {
    pickWorkspace: vi.fn(),
    repoInfo: vi.fn(),
    initRepo: vi.fn(),
    statusAndStats: vi.fn(),
    gitLog: vi.fn(),
    commitDetail: vi.fn(),
    commitDiff: vi.fn(),
    saveSession: vi.fn(),
    loadSession: vi.fn(),
    eventsDir: vi.fn(),
    prepareCodexHome: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    commit: vi.fn(),
    discard: vi.fn(),
    checkoutRef: vi.fn(),
    createBranch: vi.fn(),
    resetTo: vi.fn(),
    revertCommit: vi.fn(),
    revealPath: vi.fn(),
    prCheckout: vi.fn(),
    prList: vi.fn(),
    ghLogin: vi.fn(),
    ghAvailable: vi.fn(),
    watchWorktree: vi.fn(),
    unwatchWorktree: vi.fn(),
    listAgents: vi.fn(),
    claudeSessionExists: vi.fn(),
    swarmBin: vi.fn(),
    installAgentHooks: vi.fn(),
    notifyOs: vi.fn(),
    ptySpawn: vi.fn(),
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    ptyKill: vi.fn(),
    ptyAlive: vi.fn(),
    ptyLive: vi.fn(),
    ptyReap: vi.fn(),
    agentSessionResume: vi.fn().mockResolvedValue(null),
    agentSessionForget: vi.fn(),
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

// Mock the OS-notification boundary: notifyOS becomes a spy we assert on, so
// tests verify *when* a background notification escalates to an OS banner
// without touching the real tauri-plugin-notification.
vi.mock("../lib/notify", () => ({
  notifyOS: vi.fn(),
}));

// Mock the dialog boundary: closeWorkspaceWithConfirm awaits confirmDialog, so
// the spy lets a test decide the user's answer without rendering DialogHost.
vi.mock("../lib/dialog", () => ({
  confirmDialog: vi.fn(),
}));

import { api } from "../lib/ipc";
import { updater } from "../lib/updater";
import { notifyOS } from "../lib/notify";
import { confirmDialog } from "../lib/dialog";
import {
  __resetNetworkCaches,
  CLAUDE_NOTIF_SENTINEL,
  useActiveWorkspace,
  useStore,
} from "../store";

const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const upd = updater as unknown as Record<string, ReturnType<typeof vi.fn>>;
const notifyOSMock = notifyOS as unknown as ReturnType<typeof vi.fn>;
const confirmDialogMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

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
const AIDER: AgentDef = {
  id: "aider",
  name: "Aider",
  command: "aider",
  args: [],
  installed: true,
  resume: [],
};

const repo = (path = "/repo"): RepoInfo => ({
  path,
  name: path.split("/").pop()!,
  headBranch: "main",
  isRepo: true,
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
  gitNonce: 0,
  hydrated: false,
  sidebarVisible: true,
  windowFocused: true,
  swarmBin: null,
  eventsDir: null,
  codexHome: null,
  update: { status: "idle" as const, progress: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetNetworkCaches();
  useStore.setState({ ...INITIAL });
  // Sensible resolved defaults; tests override as needed.
  m.repoInfo.mockResolvedValue(repo());
  m.ghAvailable.mockResolvedValue(false);
  m.listAgents.mockResolvedValue([SHELL, CLAUDE]);
  m.claudeSessionExists.mockResolvedValue(true);
  m.swarmBin.mockResolvedValue("/path/to/swarm");
  m.installAgentHooks.mockResolvedValue(undefined);
  m.statusAndStats.mockResolvedValue({
    changes: [],
    stats: { filesChanged: 0, insertions: 0, deletions: 0 },
  });
  m.eventsDir.mockResolvedValue("/events");
  m.prepareCodexHome.mockResolvedValue("/codex-home");
  m.ghLogin.mockResolvedValue("octocat");
  m.prList.mockResolvedValue([]);
  m.loadSession.mockResolvedValue(null);
  // Default: no PTY survived a reload — every pane spawns fresh (tests that
  // exercise reattach-on-reload override ptyLive).
  m.ptyLive.mockResolvedValue([]);
  m.ptyReap.mockResolvedValue(undefined);
  // Default: no captured agent session (tests that exercise restore override this).
  m.agentSessionResume.mockResolvedValue(null);
  for (const fn of [
    "stage",
    "unstage",
    "stageAll",
    "unstageAll",
    "saveSession",
    "watchWorktree",
    "unwatchWorktree",
  ]) {
    m[fn].mockResolvedValue(undefined);
  }
  m.commit.mockResolvedValue("deadbee");
  for (const fn of [
    "discard",
    "checkoutRef",
    "createBranch",
    "resetTo",
    "revealPath",
    "prCheckout",
  ]) {
    m[fn].mockResolvedValue(undefined);
  }
  m.revertCommit.mockResolvedValue("revbee0");
  upd.check.mockResolvedValue(null);
  upd.downloadAndInstall.mockResolvedValue(undefined);
  upd.relaunch.mockResolvedValue(undefined);
});

const s = () => useStore.getState();

// `store.addWorkspace()` is no-arg in production (it calls the native picker via
// `api.pickWorkspace`). Tests want to drive the picker outcome explicitly — this
// helper mocks the next `pickWorkspace` call to return the requested root and
// then invokes `addWorkspace`, so each test reads naturally as "pick X, then …".
async function addWorkspace(
  path: string,
  opts: { name?: string; isRepo?: boolean } = {},
): Promise<void> {
  m.pickWorkspace.mockResolvedValueOnce({
    path,
    name: opts.name ?? path.split("/").filter(Boolean).pop() ?? path,
    headBranch: opts.isRepo === false ? null : "main",
    isRepo: opts.isRepo ?? true,
  });
  await s().addWorkspace();
}

describe("addWorkspace", () => {
  it("creates a workspace, makes it active, and spawns one shell pane", async () => {
    await addWorkspace("/repo");
    const st = s();
    expect(st.workspaces).toHaveLength(1);
    expect(st.activeWorkspaceId).toBe(st.workspaces[0].id);
    expect(st.panes).toHaveLength(1);
    expect(st.panes[0].agentId).toBe("shell");
    expect(st.panes[0].cwd).toBe("/repo");
    expect(st.busy).toBe(false);
  });

  it("refreshes git status for the new workspace", async () => {
    m.statusAndStats.mockResolvedValue({
      changes: [
        { path: "a.txt", oldPath: null, status: "modified", staged: false, unstaged: true },
      ],
      stats: { filesChanged: 1, insertions: 2, deletions: 1 },
    });
    await addWorkspace("/repo");
    const ws = s().workspaces[0];
    expect(ws.changes).toHaveLength(1);
    expect(ws.diffStats).toEqual({ filesChanged: 1, insertions: 2, deletions: 1 });
  });

  it("starts a worktree watcher for the new workspace", async () => {
    await addWorkspace("/repo");
    const ws = s().workspaces[0];
    expect(m.watchWorktree).toHaveBeenCalledWith(ws.id, ws.repo.path);
  });

  it("records an error and clears busy when the repo cannot be opened", async () => {
    // pick_workspace bundles the repo info; a rejection here mirrors a path
    // that fails the workspace registry or doesn't canonicalise.
    m.pickWorkspace.mockRejectedValueOnce(new Error("not a git repository"));
    await s().addWorkspace();
    expect(s().error).toBe("not a git repository");
    expect(s().busy).toBe(false);
    expect(s().workspaces).toHaveLength(0);
  });

  it("is a no-op when the user cancels the native picker", async () => {
    // pickWorkspace returns null on cancel — no error, no workspace.
    m.pickWorkspace.mockResolvedValueOnce(null);
    await s().addWorkspace();
    expect(s().error).toBeNull();
    expect(s().workspaces).toHaveLength(0);
    expect(s().busy).toBe(false);
  });

  it("opens a plain (non-git) folder without erroring, and skips git status/PR loads", async () => {
    m.ghAvailable.mockResolvedValue(true);
    await addWorkspace("/new-project", { isRepo: false });
    const st = s();
    expect(st.error).toBeNull();
    expect(st.workspaces).toHaveLength(1);
    expect(st.workspaces[0].repo.isRepo).toBe(false);
    expect(st.panes).toHaveLength(1); // terminal still spawns
    // No git/PR commands run for a folder that isn't a repo yet.
    expect(m.statusAndStats).not.toHaveBeenCalled();
    expect(m.prList).not.toHaveBeenCalled();
  });

  it("initRepo turns an opened plain folder into a git repo and wires it up", async () => {
    await addWorkspace("/new-project", { isRepo: false });
    m.initRepo.mockResolvedValue({
      path: "/new-project",
      name: "new-project",
      headBranch: "main",
      isRepo: true,
    });
    await s().initRepo();
    const ws = s().workspaces[0];
    expect(m.initRepo).toHaveBeenCalledWith("/new-project");
    expect(ws.repo.isRepo).toBe(true);
    expect(ws.repo.headBranch).toBe("main");
    // Now that it's a repo, status is read.
    expect(m.statusAndStats).toHaveBeenCalledWith("/new-project");
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
    await addWorkspace("/repo");
    await vi.waitFor(() => expect(s().workspaces[0].prs).toHaveLength(1));
    expect(s().workspaces[0].ghLogin).toBe("octocat");
  });
});

describe("pane creation", () => {
  beforeEach(async () => {
    useStore.setState({ agents: [SHELL, CLAUDE], eventsDir: "/events" });
    await addWorkspace("/repo");
  });

  it("gives a Claude pane a session id and instrumented launch args", () => {
    s().addPane(CLAUDE);
    const pane = s().panes.find((p) => p.agentId === "claude")!;
    expect(pane.sessionId).toBeTruthy();
    expect(pane.args).toContain("--session-id");
    expect(pane.args).toContain(pane.sessionId);
    expect(pane.args).toContain("--settings");
  });

  it("wires Claude's Notification hook so permission prompts and idle pauses notify", () => {
    // `preferredNotifChannel: notifications_disabled` kills Claude's built-in
    // desktop notifications. Without an explicit Notification hook, the events
    // routed through Claude's own notification flow — subagent permission
    // prompts, the 60s idle reminder, MCP elicitation — never reach swarm.
    // The hook re-invokes our notify-helper, which forwards the `message` to the
    // events file → watcher → `pane:notify`.
    useStore.setState({ ...INITIAL, swarmBin: "/path/to/swarm", agents: [SHELL, CLAUDE] });
    return addWorkspace("/repo").then(() => {
      s().addPane(CLAUDE);
      const pane = s().panes.find((p) => p.agentId === "claude")!;
      const idx = pane.args.indexOf("--settings");
      expect(idx).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(pane.args[idx + 1]);
      expect(settings.hooks.Notification).toBeTruthy();
      const cmds = JSON.stringify(settings.hooks.Notification);
      expect(cmds).toContain("--notify-helper claude-notification");
      // Stop is still wired (turn-complete notification path).
      expect(settings.hooks.Stop).toBeTruthy();
    });
  });

  it("wires PreToolUse for AskUserQuestion + ExitPlanMode so interactive prompts notify instantly", () => {
    // AskUserQuestion (multiple-choice prompt) and ExitPlanMode (plan-approval
    // prompt) are `requiresUserInteraction` tools with their own UI flow — the
    // Notification hook only fires for them indirectly via the idle reminder
    // after `messageIdleNotifThresholdMs` (~60s). PreToolUse with a matcher
    // on these tool names fires the instant Claude calls the tool, so the user
    // sees the OS banner immediately rather than minutes later.
    useStore.setState({ ...INITIAL, swarmBin: "/path/to/swarm", agents: [SHELL, CLAUDE] });
    return addWorkspace("/repo").then(() => {
      s().addPane(CLAUDE);
      const pane = s().panes.find((p) => p.agentId === "claude")!;
      const idx = pane.args.indexOf("--settings");
      const settings = JSON.parse(pane.args[idx + 1]);
      expect(settings.hooks.PreToolUse).toBeTruthy();
      const arr = settings.hooks.PreToolUse;
      // The matcher is a regex Claude evaluates against the tool name; either
      // alternation or two separate entries is fine, but BOTH tools must be
      // covered by the registered command(s).
      const serialized = JSON.stringify(arr);
      expect(serialized).toContain("AskUserQuestion");
      expect(serialized).toContain("ExitPlanMode");
      expect(serialized).toContain("--notify-helper claude-pretool");
    });
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
    await addWorkspace("/repo");
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
    await addWorkspace("/repo");
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

  it("keeps the editor when switching panels; showTerminal returns to the terminal", () => {
    s().openCommit("abc123");
    s().setPanel("scm");
    // Inspector and editor are decoupled: switching panels never touches the
    // main area.
    expect(s().workspaces[0].editor).toEqual({ type: "commit", oid: "abc123" });
    expect(s().workspaces[0].panel).toBe("scm");
    s().showTerminal();
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
  });

  it("toggles the sidebar", () => {
    const before = s().sidebarVisible;
    s().toggleSidebar();
    expect(s().sidebarVisible).toBe(!before);
  });

  it("setCompact flips the compact flag", () => {
    expect(s().compact).toBe(false);
    s().setCompact(true);
    expect(s().compact).toBe(true);
    s().setCompact(false);
    expect(s().compact).toBe(false);
  });

  it("compact mode closes the drawer when a diff/pr/commit is opened", () => {
    s().setCompact(true);
    useStore.setState({ sidebarVisible: true });
    s().openDiff("a.txt", false);
    expect(s().sidebarVisible).toBe(false);

    useStore.setState({ sidebarVisible: true });
    s().openCommit("abc123");
    expect(s().sidebarVisible).toBe(false);
  });

  it("regular mode leaves the panel open when opening a view", () => {
    s().setCompact(false);
    useStore.setState({ sidebarVisible: true });
    s().openDiff("a.txt", false);
    expect(s().sidebarVisible).toBe(true);
  });
});

describe("notifications + attention", () => {
  let ptyId: string;
  let paneId: string;
  beforeEach(async () => {
    await addWorkspace("/repo");
    paneId = s().panes[0].paneId;
    ptyId = "pty-1";
    // bindPty takes a PtyHandle: an id and the sealed token Rust mints on spawn.
    s().bindPty(paneId, { id: ptyId, token: "tok-1" });
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

  it("raises an OS banner when the pane is hidden behind a non-terminal editor view", () => {
    // The user is on swarm and the source workspace is active, but a diff/PR view
    // has replaced the terminal — the agent's pane is no longer on screen. The
    // small in-app bell badge is too easy to miss, so an OS banner fires.
    s().openDiff("a.txt", false); // editor != terminal → pane not visible
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications).toHaveLength(1);
    expect(notifyOSMock).toHaveBeenCalledWith("Build", "Done", paneId, s().panes[0].workspaceId);
  });

  it("raises an OS banner when the agent's workspace is not the active one (window still focused)", async () => {
    // The user-reported bug: agent runs in workspace A, user switches to B with
    // swarm still in front. Previously the OS banner was gated on
    // `!windowFocused`, so this scenario emitted only the in-app bell. Now the
    // gate matches `!lookingAtPane`: a banner fires for any pane the user
    // isn't currently looking at.
    const wsA = s().panes[0].workspaceId;
    await addWorkspace("/repo-b");
    expect(s().activeWorkspaceId).not.toBe(wsA); // ws-B is now active
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications).toHaveLength(1);
    expect(notifyOSMock).toHaveBeenCalledWith("Build", "Done", paneId, wsA);
  });

  it("escalates onPaneNotify to an OS banner across workspaces (window still focused)", async () => {
    // Same gate change as above, this time on the events-file path that
    // generic-agent hooks (and now Claude's Notification hook) take.
    const wsA = s().panes[0].workspaceId;
    await addWorkspace("/repo-b");
    s().onPaneNotify(paneId, "permission requested");
    expect(notifyOSMock).toHaveBeenCalledWith(
      s().panes.find((p) => p.paneId === paneId)!.title,
      "permission requested",
      paneId,
      wsA,
    );
  });

  it("raises an OS banner when the window is backgrounded, even for the visible pane", () => {
    s().setWindowFocused(false); // pane is the visible one, but window is in the background
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications).toHaveLength(1);
    expect(s().panes[0].attention).toBe(true);
    expect(notifyOSMock).toHaveBeenCalledWith("Build", "Done", paneId, s().panes[0].workspaceId);
  });

  it("escalates onPaneNotify to an OS banner when backgrounded", () => {
    s().setWindowFocused(false);
    s().onPaneNotify(paneId, "agent done");
    expect(notifyOSMock).toHaveBeenCalledWith(
      s().panes[0].title,
      "agent done",
      paneId,
      s().panes[0].workspaceId,
    );
  });

  it("still suppresses entirely while looking at the pane (focused + visible)", () => {
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications).toHaveLength(0);
    expect(notifyOSMock).not.toHaveBeenCalled();
  });

  it("flags attention for the visible pane when the window is backgrounded", () => {
    s().setWindowFocused(false);
    s().onAttention(ptyId);
    expect(s().panes[0].attention).toBe(true);
  });

  it("wires Aider's completion notification via its launch flag", async () => {
    useStore.setState({ ...INITIAL, swarmBin: "/path/to/swarm" });
    await addWorkspace("/repo");
    s().addPane(AIDER);
    const aiderPane = s().panes.find((p) => p.agentId === "aider")!;
    expect(aiderPane.args).toContain("--notifications-command");
    expect(aiderPane.args).toContain('"/path/to/swarm" --notify-helper event');
  });

  it("clears the visible pane's attention + marks read when the window regains focus", () => {
    s().setWindowFocused(false);
    s().onNotify(ptyId, "Build", "Done"); // visible pane, but window backgrounded
    expect(s().panes[0].attention).toBe(true);
    expect(s().notifications[0].read).toBe(false);
    s().setWindowFocused(true); // alt-tab back into swarm, no pane click
    expect(s().panes[0].attention).toBe(false);
    expect(s().notifications[0].read).toBe(true);
  });

  it("drops Claude's own terminal notifications, keeping only the sentinel-tagged one", () => {
    s().addPane(CLAUDE);
    const claudePane = s().panes.find((p) => p.agentId === "claude")!;
    s().bindPty(claudePane.paneId, { id: "pty-claude", token: "tok-claude" });
    s().openDiff("a.txt", false); // panes not visible
    s().onNotify("pty-claude", "No response requested.", "noise"); // Claude's own → dropped
    s().onNotify("pty-claude", CLAUDE_NOTIF_SENTINEL, "Hi 👋"); // ours → kept
    const mine = s().notifications.filter((n) => n.paneId === claudePane.paneId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: claudePane.title, body: "Hi 👋" });
  });

  it("marks a notification read but keeps it in history when its pane is focused", () => {
    s().openDiff("a.txt", false); // pane not visible → notification recorded unread
    s().onNotify(ptyId, "Build", "Done");
    expect(s().notifications[0].read).toBe(false);
    s().selectPane(paneId); // re-focus the source terminal
    expect(s().notifications).toHaveLength(1); // still in history
    expect(s().notifications[0].read).toBe(true); // but read
    expect(s().panes[0].attention).toBe(false);
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
    await addWorkspace("/a");
    m.repoInfo.mockResolvedValue(repo("/b"));
    await addWorkspace("/b");
    m.repoInfo.mockResolvedValue(repo("/c"));
    await addWorkspace("/c");
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
    // The worktree watcher for the closed workspace is torn down.
    expect(m.unwatchWorktree).toHaveBeenCalledWith(ids[1]);
  });

  it("closeWorkspaceWithConfirm closes a shell-only workspace without prompting", async () => {
    const ids = s().workspaces.map((w) => w.id);
    confirmDialogMock.mockResolvedValue(false);
    await s().closeWorkspaceWithConfirm(ids[1]);
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(s().workspaces.map((w) => w.id)).toEqual([ids[0], ids[2]]);
    confirmDialogMock.mockReset();
  });

  it("closeWorkspaceWithConfirm prompts when a running agent would be killed", async () => {
    const ids = s().workspaces.map((w) => w.id);
    m.ptyKill.mockResolvedValue(undefined);
    // Promote ids[1]'s pane to a live Claude agent (non-shell + a PTY).
    const handle = { id: "pty-1", token: "tok-1" };
    useStore.setState((st) => ({
      panes: st.panes.map((p) =>
        p.workspaceId === ids[1] ? { ...p, agentId: "claude", pty: handle } : p,
      ),
    }));
    confirmDialogMock.mockResolvedValue(false);
    await s().closeWorkspaceWithConfirm(ids[1]);
    // Declined → nothing closes.
    expect(confirmDialogMock).toHaveBeenCalledOnce();
    expect(s().workspaces.map((w) => w.id)).toEqual(ids);

    confirmDialogMock.mockResolvedValue(true);
    await s().closeWorkspaceWithConfirm(ids[1]);
    // Accepted → closed, and its live PTY reaped.
    expect(s().workspaces.map((w) => w.id)).toEqual([ids[0], ids[2]]);
    expect(m.ptyKill).toHaveBeenCalledWith(handle);
    confirmDialogMock.mockReset();
  });

  it("closeWorkspace persists immediately so the close survives a quit", () => {
    const ids = s().workspaces.map((w) => w.id);
    useStore.setState({ hydrated: true });
    m.saveSession.mockClear();
    s().closeWorkspace(ids[0]);
    // Written eagerly (not via the debounced autosave), without the closed one.
    expect(m.saveSession).toHaveBeenCalled();
    const snap = JSON.parse(m.saveSession.mock.lastCall![0] as string);
    expect(snap.workspaces.map((w: { id: string }) => w.id)).toEqual([ids[1], ids[2]]);
  });

  it("closeWorkspaceWithConfirm is a no-op for an unknown id", async () => {
    confirmDialogMock.mockResolvedValue(true);
    await s().closeWorkspaceWithConfirm("nope");
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(s().workspaces).toHaveLength(3);
    confirmDialogMock.mockReset();
  });
});

describe("staging + commit", () => {
  beforeEach(async () => {
    await addWorkspace("/repo");
  });

  it("stages a path then refreshes status", async () => {
    await s().stage("a.txt");
    expect(m.stage).toHaveBeenCalledWith("/repo", ["a.txt"]);
    expect(m.statusAndStats).toHaveBeenCalledTimes(2); // once on add, once after stage
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

describe("git write-ops", () => {
  beforeEach(async () => {
    await addWorkspace("/repo");
  });

  it("discards files then refreshes status", async () => {
    await s().discardFiles(["a.txt"]);
    expect(m.discard).toHaveBeenCalledWith("/repo", ["a.txt"]);
    expect(m.statusAndStats).toHaveBeenCalledTimes(2); // add + after discard
  });

  it("ignores an empty discard list", async () => {
    await s().discardFiles([]);
    expect(m.discard).not.toHaveBeenCalled();
  });

  it("checks out a ref, re-fetches repo info, and bumps gitNonce", async () => {
    const before = s().gitNonce;
    await s().checkoutRef("feature");
    expect(m.checkoutRef).toHaveBeenCalledWith("/repo", "feature");
    expect(m.repoInfo).toHaveBeenCalled();
    expect(s().gitNonce).toBe(before + 1);
  });

  it("creates a branch only with a non-empty (trimmed) name", async () => {
    await s().createBranchAt("   ", "abc");
    expect(m.createBranch).not.toHaveBeenCalled();
    await s().createBranchAt("  feat  ", "abc");
    expect(m.createBranch).toHaveBeenCalledWith("/repo", "feat", "abc");
  });

  it("resets to a commit in the requested mode", async () => {
    await s().resetTo("abc123", "hard");
    expect(m.resetTo).toHaveBeenCalledWith("/repo", "abc123", "hard");
    expect(s().gitNonce).toBe(1);
  });

  it("reverts a commit and bumps gitNonce", async () => {
    await s().revertCommit("abc123");
    expect(m.revertCommit).toHaveBeenCalledWith("/repo", "abc123");
    expect(s().gitNonce).toBe(1);
  });

  it("checks out a PR branch by number", async () => {
    await s().prCheckout({
      number: 7,
      title: "x",
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: false,
      author: "octocat",
      headRef: "feat",
      reviewDecision: null,
      checks: null,
    });
    expect(m.prCheckout).toHaveBeenCalledWith("/repo", 7);
  });

  it("surfaces a git write failure as an error and clears busy", async () => {
    m.checkoutRef.mockRejectedValue(new Error("would be overwritten"));
    await s().checkoutRef("feature");
    expect(s().error).toBe("would be overwritten");
    expect(s().busy).toBe(false);
  });

  it("reveals a path via the OS", async () => {
    await s().revealPath("/repo/a.txt");
    expect(m.revealPath).toHaveBeenCalledWith("/repo/a.txt");
  });

  it("surfaces a reveal failure as an error", async () => {
    m.revealPath.mockRejectedValue(new Error("no such path"));
    await s().revealPath("/repo/a.txt");
    expect(s().error).toBe("no such path");
  });
});

describe("tab close actions", () => {
  beforeEach(async () => {
    useStore.setState({ agents: [SHELL] });
    await addWorkspace("/repo");
  });

  it("closeOtherTabs keeps only the named tab and selects it", () => {
    s().addPane(SHELL);
    s().addPane(SHELL);
    const tabs = s().workspaces[0].tabs;
    const keep = tabs[1].id;
    s().closeOtherTabs(keep);
    const after = s().workspaces[0];
    expect(after.tabs.map((t) => t.id)).toEqual([keep]);
    expect(after.activeTab).toBe(keep);
  });

  it("closeTabsToRight closes only the tabs after the named one", () => {
    s().addPane(SHELL);
    s().addPane(SHELL);
    const tabs = s().workspaces[0].tabs;
    const pivot = tabs[1].id;
    s().closeTabsToRight(pivot);
    expect(s().workspaces[0].tabs.map((t) => t.id)).toEqual([tabs[0].id, pivot]);
  });

  it("closeTabsToRight is a no-op for an unknown tab id", () => {
    const before = s().workspaces[0].tabs.length;
    s().closeTabsToRight("nope");
    expect(s().workspaces[0].tabs).toHaveLength(before);
  });
});

describe("setNotificationRead", () => {
  it("toggles the read flag on one notification", () => {
    useStore.setState({
      notifications: [
        {
          id: "n1",
          workspaceId: "w",
          paneId: "p",
          title: "t",
          body: "b",
          ts: 0,
          source: "agent",
          read: false,
        },
      ],
    });
    s().setNotificationRead("n1", true);
    expect(s().notifications[0].read).toBe(true);
    s().setNotificationRead("n1", false);
    expect(s().notifications[0].read).toBe(false);
  });

  it("lifts a notification to the front when marking it unread", () => {
    const mk = (id: string, read: boolean) => ({
      id,
      workspaceId: "w",
      paneId: "p",
      title: id,
      body: "b",
      ts: 0,
      source: "agent" as const,
      read,
    });
    // Newest-first: n3, n2, n1. Mark the oldest (n1) unread → it jumps to front.
    useStore.setState({ notifications: [mk("n3", true), mk("n2", true), mk("n1", true)] });
    s().setNotificationRead("n1", false);
    expect(s().notifications.map((n) => n.id)).toEqual(["n1", "n3", "n2"]);
    expect(s().notifications[0].read).toBe(false);
  });

  it("does not reorder when marking a notification read", () => {
    const mk = (id: string) => ({
      id,
      workspaceId: "w",
      paneId: "p",
      title: id,
      body: "b",
      ts: 0,
      source: "agent" as const,
      read: false,
    });
    useStore.setState({ notifications: [mk("n2"), mk("n1")] });
    s().setNotificationRead("n1", true);
    expect(s().notifications.map((n) => n.id)).toEqual(["n2", "n1"]);
  });
});

describe("renameWorkspace", () => {
  beforeEach(async () => {
    await addWorkspace("/repo");
  });

  it("sets a display-name override without touching repo.name", () => {
    const id = s().workspaces[0].id;
    s().renameWorkspace(id, "  My App  ");
    expect(s().workspaces[0].name).toBe("My App"); // trimmed
    expect(s().workspaces[0].repo.name).toBe("repo"); // canonical name preserved
  });

  it("clears the override when renamed to blank or the repo name", () => {
    const id = s().workspaces[0].id;
    s().renameWorkspace(id, "Custom");
    expect(s().workspaces[0].name).toBe("Custom");
    s().renameWorkspace(id, "   ");
    expect(s().workspaces[0].name).toBeUndefined();
    s().renameWorkspace(id, "Custom");
    s().renameWorkspace(id, "repo"); // equals repo.name → also clears
    expect(s().workspaces[0].name).toBeUndefined();
  });

  it("persists and restores the name override across hydrate", async () => {
    const id = s().workspaces[0].id;
    s().renameWorkspace(id, "Renamed");
    useStore.setState({ hydrated: true });
    s().persist();
    const calls = m.saveSession.mock.calls;
    const saved = JSON.parse(calls[calls.length - 1][0]);
    expect(saved.workspaces[0].name).toBe("Renamed");
  });
});

describe("misc workspace actions", () => {
  beforeEach(async () => {
    await addWorkspace("/repo");
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

  it("selecting a tab surfaces the terminal but leaves the inspector panel sticky", () => {
    const tabId = s().workspaces[0].activeTab!;
    s().setPanel("notifications");
    s().openCommit("abc123");
    expect(s().workspaces[0].panel).toBe("notifications");
    s().selectTab(tabId);
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].panel).toBe("notifications");
  });

  it("selecting a pane surfaces the terminal but leaves the inspector panel sticky", () => {
    const paneId = s().panes[0].paneId;
    s().setPanel("scm");
    s().openDiff("a.txt", false);
    s().selectPane(paneId);
    expect(s().workspaces[0].editor).toEqual({ type: "terminal" });
    expect(s().workspaces[0].panel).toBe("scm");
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
    m.statusAndStats.mockClear();
    await s().refreshStatus("does-not-exist");
    expect(m.statusAndStats).not.toHaveBeenCalled();
  });

  it("clears pane attention when switching to a workspace's active tab", () => {
    const ws = s().workspaces[0];
    const pane = s().panes[0];
    s().bindPty(pane.paneId, { id: "p1", token: "tok-p1" });
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
    await addWorkspace("/repo");
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
            tabs: [
              { id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" },
            ],
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

  // Regression: a WebContent reload (OOM → Tauri auto-reload) wipes the frontend
  // but the Rust process — and its PTYs — survive. Re-resuming the agent then
  // spawns a *second* process and orphans the live PTY, whose render thread leaks
  // frames into the webview and re-OOMs it (the reload spiral the user hit). When
  // the backend reports a live PTY for the pane, hydrate must REATTACH, not resume.
  it("reattaches to a live PTY after a reload instead of re-resuming the agent", async () => {
    m.ptyLive.mockResolvedValue([["pane-1", "pty-live-1"]]);
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
            tabs: [
              { id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" },
            ],
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
    const pane = s().panes[0];
    // The pane carries the live PTY id, so Terminal.tsx attaches to the running
    // agent rather than spawning a new one…
    // Hydrate stores the surviving PTY id with an empty token; Terminal.tsx
    // calls ptyReattach on mount to bind the live PTY and rotate the token.
    expect(pane.pty?.id).toBe("pty-live-1");
    // …and the resume machinery is never consulted (no `claude --resume` rebuilt).
    expect(m.agentSessionResume).not.toHaveBeenCalled();
    expect(pane.args).not.toContain("--resume");
    // The live PTY is kept, never reaped.
    expect(m.ptyReap).toHaveBeenCalledWith(["pty-live-1"]);
  });

  // Regression: any live PTY the reloaded frontend does NOT reattach to — a closed
  // pane, a dropped workspace, or a duplicate — is an orphan that keeps leaking, so
  // hydrate reaps it (passing only the ids it kept).
  it("reaps a PTY orphaned by a reload (a pane no longer in the session)", async () => {
    m.ptyLive.mockResolvedValue([
      ["pane-1", "pty-live-1"],
      ["pane-gone", "pty-orphan"],
    ]);
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
            tabs: [
              { id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" },
            ],
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
    // Only the reattached PTY is kept; the orphan (`pty-orphan`) is absent from the
    // keep-list, so the backend kills it.
    expect(m.ptyReap).toHaveBeenCalledWith(["pty-live-1"]);
  });

  it("restores a captured agent session over the persisted pane kind (cmux-style)", async () => {
    // A shell pane in which the user ran `claude --dangerously-skip-permissions`:
    // the backend captured it, so on hydrate the pane comes back AS Claude with the
    // flag preserved (not a bare shell). Claude also re-gets swarm's --settings.
    m.agentSessionResume.mockResolvedValue({
      agent: "claude",
      command: "claude",
      args: ["--resume", "sess-x", "--dangerously-skip-permissions"],
      cwd: "/repo",
      sessionId: "sess-x",
    });
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
            tabs: [
              { id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" },
            ],
            panes: [
              {
                paneId: "pane-1",
                tabId: "tab-1",
                agentId: "shell",
                command: "bash",
                args: [],
                cwd: "/repo",
                title: "Shell",
                sessionId: undefined,
              },
            ],
          },
        ],
      }),
    );
    await s().hydrate();
    const pane = s().panes[0];
    expect(pane.agentId).toBe("claude");
    expect(pane.command).toBe("claude");
    expect(pane.args).toEqual([
      "--resume",
      "sess-x",
      "--dangerously-skip-permissions",
      "--settings",
      expect.any(String),
    ]);
    expect(pane.sessionId).toBe("sess-x");
    expect(pane.env).toContainEqual(["SWARM_PANE_ID", "pane-1"]);
  });

  it("restores an empty workspace shell, and closing it removes it for good", async () => {
    // Repro of the resurrecting-workspace bug: closing every terminal leaves a
    // workspace with no tabs/panes (a valid state — you can still view diffs/PRs),
    // and hydrate faithfully restores it. Before the close-workspace action there
    // was no way to drop the shell, so it came back on every launch. Closing must
    // persist the removal immediately so it stays gone after a quit / reload.
    m.repoInfo.mockImplementation(async (p: string) => repo(p));
    m.loadSession.mockResolvedValue(
      JSON.stringify({
        v: 1,
        activeWorkspaceId: "ws-empty",
        workspaces: [
          {
            id: "ws-empty",
            repoPath: "/kairo",
            panel: "prs",
            activeTab: null,
            tabs: [],
            panes: [],
          },
          { id: "ws-2", repoPath: "/auther", panel: "scm", activeTab: null, tabs: [], panes: [] },
        ],
      }),
    );
    await s().hydrate();
    // The empty shell is restored — exactly the resurrection users saw.
    expect(s().workspaces.map((w) => w.id)).toEqual(["ws-empty", "ws-2"]);

    m.saveSession.mockClear();
    s().closeWorkspace("ws-empty");
    // Removal is written eagerly (not via the lossy debounce), without the shell.
    const snap = JSON.parse(m.saveSession.mock.lastCall![0] as string);
    expect(snap.workspaces.map((w: { id: string }) => w.id)).toEqual(["ws-2"]);
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
            tabs: [
              { id: "tab-1", layout: { type: "leaf", paneId: "pane-1" }, activeLeaf: "pane-1" },
            ],
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
          {
            id: "ws-1",
            repoPath: "/repo",
            panel: "terminals",
            activeTab: null,
            tabs: [],
            panes: [],
          },
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
          {
            id: "ws-gone",
            repoPath: "/deleted",
            panel: "terminals",
            activeTab: null,
            tabs: [],
            panes: [],
          },
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

// Defensive guards: with no active workspace, view + SCM actions must no-op
// (never touch the IPC boundary or throw) instead of dereferencing a null ws.
describe("actions with no active workspace", () => {
  it("view actions no-op", () => {
    s().openDiff("a.txt", false);
    s().openPr({
      number: 1,
      title: "t",
      url: "u",
      state: "OPEN",
      isDraft: false,
      author: "me",
      headRef: "f",
      reviewDecision: null,
      checks: "passing",
    });
    s().openCommit("abc");
    s().showTerminal();
    s().setCommitMsg("hello");
    s().selectTab("nope");
    s().setRatio("split", 0.5);
    expect(s().workspaces).toHaveLength(0);
  });

  it("SCM actions never reach the backend", async () => {
    await s().stage("a.txt");
    await s().unstage("a.txt");
    await s().stageAll();
    await s().unstageAll();
    await s().commit();
    expect(m.stage).not.toHaveBeenCalled();
    expect(m.unstage).not.toHaveBeenCalled();
    expect(m.stageAll).not.toHaveBeenCalled();
    expect(m.unstageAll).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it("loadPrs with no workspace is a no-op", async () => {
    await s().loadPrs();
    expect(m.prList).not.toHaveBeenCalled();
  });

  it("git write-ops never reach the backend without a workspace", async () => {
    await s().discardFiles(["a.txt"]);
    await s().checkoutRef("feature");
    await s().createBranchAt("feat", "abc");
    await s().resetTo("abc", "hard");
    await s().revertCommit("abc");
    expect(m.discard).not.toHaveBeenCalled();
    expect(m.checkoutRef).not.toHaveBeenCalled();
    expect(m.createBranch).not.toHaveBeenCalled();
    expect(m.resetTo).not.toHaveBeenCalled();
    expect(m.revertCommit).not.toHaveBeenCalled();
    expect(s().gitNonce).toBe(0);
  });

  it("closeOtherTabs / closeTabsToRight no-op without a workspace", () => {
    s().closeOtherTabs("x");
    s().closeTabsToRight("x");
    expect(s().workspaces).toHaveLength(0);
  });

  it("selectPane / removePane ignore unknown pane ids", () => {
    s().selectPane("ghost");
    s().removePane("ghost");
    expect(m.ptyKill).not.toHaveBeenCalled();
  });
});

describe("action edge cases with an active workspace", () => {
  beforeEach(async () => {
    useStore.setState({ agents: [SHELL, CLAUDE], eventsDir: "/events" });
    await addWorkspace("/repo");
  });

  it("removePane kills the bound PTY and collapses the empty tab", () => {
    m.ptyKill.mockResolvedValue(undefined);
    const pane = s().panes[0];
    const handle = { id: "pty-0", token: "tok-0" };
    s().bindPty(pane.paneId, handle);
    s().removePane(pane.paneId);
    expect(m.ptyKill).toHaveBeenCalledWith(handle);
    expect(s().panes).toHaveLength(0);
  });

  it("commit records a stringified non-Error rejection", async () => {
    s().setCommitMsg("wip");
    m.commit.mockRejectedValue("kaboom");
    await s().commit();
    expect(s().error).toBe("kaboom");
    expect(s().busy).toBe(false);
  });

  it("loadPrs serves a fresh cache without re-hitting gh", async () => {
    const pr = {
      number: 9,
      title: "t",
      url: "u",
      state: "OPEN" as const,
      isDraft: false,
      author: "me",
      headRef: "f",
      reviewDecision: null,
      checks: "passing" as const,
    };
    m.prList.mockResolvedValue([pr]);
    const wsId = s().activeWorkspaceId!;
    await s().loadPrs(wsId);
    await s().loadPrs(wsId);
    expect(m.prList).toHaveBeenCalledTimes(1);
    expect(s().workspaces[0].prs).toHaveLength(1);
  });

  it("attention + notifications only fire for non-visible panes", () => {
    const first = s().panes[0];
    s().bindPty(first.paneId, { id: "pty-0", token: "tok-0" });
    // addPane opens a new active tab, leaving the first pane non-visible.
    s().addPane(SHELL);
    expect(s().panes).toHaveLength(2);

    s().onAttention("ghost-pty"); // unknown pty: suppressed
    s().onAttention("pty-0");
    expect(s().panes.find((p) => p.paneId === first.paneId)?.attention).toBe(true);

    s().onNotify("pty-0", "Title", "body");
    s().onPaneNotify("ghost", "ignored"); // unknown pane: suppressed
    s().onPaneNotify(first.paneId, "agent says hi");
    expect(s().notifications.length).toBeGreaterThanOrEqual(2);

    s().onTitle("pty-0", "Renamed");
    s().onTitle("pty-0", "   "); // blank title: ignored
    expect(s().panes.find((p) => p.paneId === first.paneId)?.title).toBe("Renamed");
  });
});

describe("git write-ops (context-menu actions)", () => {
  it("discardFiles calls the backend and refreshes status without moving HEAD", async () => {
    await addWorkspace("/repo");
    m.statusAndStats.mockClear();
    await s().discardFiles(["a.txt", "b.txt"]);
    expect(m.discard).toHaveBeenCalledWith("/repo", ["a.txt", "b.txt"]);
    expect(m.statusAndStats).toHaveBeenCalled();
    expect(s().gitNonce).toBe(0); // discard doesn't move HEAD
    expect(s().busy).toBe(false);
  });

  it("discardFiles with no paths is a no-op", async () => {
    await addWorkspace("/repo");
    await s().discardFiles([]);
    expect(m.discard).not.toHaveBeenCalled();
  });

  it("checkoutRef moves HEAD: re-fetches repo info and bumps gitNonce", async () => {
    await addWorkspace("/repo");
    m.repoInfo.mockResolvedValue({
      path: "/repo",
      name: "repo",
      headBranch: "feature",
      isRepo: true,
    });
    await s().checkoutRef("feature");
    expect(m.checkoutRef).toHaveBeenCalledWith("/repo", "feature");
    expect(s().gitNonce).toBe(1);
    expect(s().workspaces[0].repo.headBranch).toBe("feature");
  });

  it("createBranchAt trims the name and skips an empty one", async () => {
    await addWorkspace("/repo");
    await s().createBranchAt("   ", "abc123");
    expect(m.createBranch).not.toHaveBeenCalled();
    await s().createBranchAt("  feat  ", "abc123");
    expect(m.createBranch).toHaveBeenCalledWith("/repo", "feat", "abc123");
  });

  it("resetTo and revertCommit forward to the backend and bump gitNonce", async () => {
    await addWorkspace("/repo");
    await s().resetTo("abc123", "hard");
    expect(m.resetTo).toHaveBeenCalledWith("/repo", "abc123", "hard");
    await s().revertCommit("abc123");
    expect(m.revertCommit).toHaveBeenCalledWith("/repo", "abc123");
    expect(s().gitNonce).toBe(2);
  });

  it("prCheckout passes the PR number and surfaces a failure as an error", async () => {
    await addWorkspace("/repo");
    const pr = {
      number: 7,
      title: "t",
      url: "u",
      state: "OPEN",
      isDraft: false,
      author: "me",
      headRef: "feat",
      reviewDecision: null,
      checks: null,
    };
    await s().prCheckout(pr);
    expect(m.prCheckout).toHaveBeenCalledWith("/repo", 7);

    m.prCheckout.mockRejectedValueOnce(new Error("dirty worktree"));
    await s().prCheckout(pr);
    expect(s().error).toBe("dirty worktree");
    expect(s().busy).toBe(false);
  });

  it("a failed git op records the error message and clears busy", async () => {
    await addWorkspace("/repo");
    m.checkoutRef.mockRejectedValueOnce(new Error("conflicting changes"));
    await s().checkoutRef("feature");
    expect(s().error).toBe("conflicting changes");
    expect(s().busy).toBe(false);
  });

  it("git ops are a no-op with no active workspace", async () => {
    await s().discardFiles(["a.txt"]);
    await s().checkoutRef("x");
    expect(m.discard).not.toHaveBeenCalled();
    expect(m.checkoutRef).not.toHaveBeenCalled();
  });

  it("revealPath forwards the path and reports failures", async () => {
    await addWorkspace("/repo");
    await s().revealPath("/repo/a.txt");
    expect(m.revealPath).toHaveBeenCalledWith("/repo/a.txt");

    m.revealPath.mockRejectedValueOnce(new Error("no such file"));
    await s().revealPath("/repo/missing");
    expect(s().error).toBe("no such file");
  });
});

describe("tab close actions", () => {
  it("closeOtherTabs keeps only the named tab", async () => {
    await addWorkspace("/repo"); // 1 tab
    s().addPane(SHELL); // 2
    s().addPane(SHELL); // 3
    const tabs = s().workspaces[0].tabs;
    expect(tabs).toHaveLength(3);
    const keep = tabs[1].id;
    s().closeOtherTabs(keep);
    const after = s().workspaces[0].tabs;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(keep);
    expect(s().workspaces[0].activeTab).toBe(keep);
  });

  it("closeTabsToRight removes every tab after the named one", async () => {
    await addWorkspace("/repo");
    s().addPane(SHELL);
    s().addPane(SHELL);
    const tabs = s().workspaces[0].tabs;
    s().closeTabsToRight(tabs[0].id);
    const after = s().workspaces[0].tabs;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(tabs[0].id);
  });

  it("close actions are a no-op with no active workspace / unknown tab", async () => {
    s().closeOtherTabs("nope"); // no active ws
    await addWorkspace("/repo");
    s().closeTabsToRight("unknown-tab"); // tab not found
    expect(s().workspaces[0].tabs).toHaveLength(1);
  });
});

describe("setNotificationRead", () => {
  it("toggles a single notification's read flag", async () => {
    useStore.setState({
      notifications: [
        {
          id: "n1",
          workspaceId: "w",
          paneId: "p",
          title: "T",
          body: "b",
          ts: 0,
          source: "agent",
          read: false,
        },
      ],
    });
    s().setNotificationRead("n1", true);
    expect(s().notifications[0].read).toBe(true);
    s().setNotificationRead("n1", false);
    expect(s().notifications[0].read).toBe(false);
    s().setNotificationRead("missing", true); // unknown id: no throw, no change
    expect(s().notifications[0].read).toBe(false);
  });
});
