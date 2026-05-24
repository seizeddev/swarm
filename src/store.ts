// SPDX-License-Identifier: GPL-3.0-or-later
import { create } from "zustand";
import { api } from "./lib/ipc";
import {
  type Dir,
  type Layout,
  leaf,
  leaves,
  removeLeaf,
  replaceLeaf,
  setRatio as setRatioIn,
  splitId,
} from "./lib/layout";
import { loadSnap, saveSnap } from "./lib/persist";
import { updater } from "./lib/updater";
import type { AgentDef, DiffStatsInfo, FileChange, PrSummary, RepoInfo } from "./lib/types";

export interface Pane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  ptyId: string | null;
  title: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  attention: boolean;
  sessionId?: string;
  env: [string, string][];
}

export interface Tab {
  id: string;
  layout: Layout;
  activeLeaf: string;
}

// The inspector views. Terminals are no longer a panel — they're the content
// (tabs in the TopBar); the inspector is independent of the editor and stays
// put while you work, instead of snapping back to a terminal list.
export type Panel = "scm" | "prs" | "notifications" | "history";

export type Editor =
  | { type: "terminal" }
  | { type: "diff"; file: string; staged: boolean }
  | { type: "pr"; pr: PrSummary }
  | { type: "commit"; oid: string };

export interface Workspace {
  id: string;
  repo: RepoInfo;
  panel: Panel;
  editor: Editor;
  tabs: Tab[];
  activeTab: string | null;
  commitMsg: string;
  changes: FileChange[];
  diffStats: DiffStatsInfo | null;
  prs: PrSummary[];
  ghLogin: string | null;
}

export interface Notif {
  id: string;
  workspaceId: string;
  paneId: string;
  title: string;
  body: string;
  ts: number;
  // Where the notification text came from: an untrusted OSC sequence emitted by
  // a program in the terminal ("terminal"), or an agent's Stop hook ("agent").
  // The UI labels terminal-sourced notifications and never acts on their body.
  source: "terminal" | "agent";
}

// Self-update lifecycle. `progress` is 0..1, meaningful only while downloading.
export interface UpdateState {
  status: "idle" | "available" | "downloading" | "ready" | "error";
  version?: string;
  notes?: string;
  progress: number;
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${seq++}`;

// `gh` availability and the logged-in user are global (one CLI, one account), so
// resolve each once and share across every workspace instead of spawning `gh`
// per workspace on hydrate/add.
let ghAvailableCache: Promise<boolean> | null = null;
const ghAvailableOnce = () => (ghAvailableCache ??= api.ghAvailable());
let ghLoginCache: Promise<string | null> | null = null;
const ghLoginOnce = () => (ghLoginCache ??= api.ghLogin());

// Short-lived PR-list cache keyed by repo path: a `gh pr list` is slow, and the
// list rarely changes between a workspace switch and a panel open.
const PR_TTL_MS = 15_000;
const prCache = new Map<string, { ts: number; prs: PrSummary[] }>();

/// Test-only: drop the process-lifetime gh/PR caches so each test sees its own
/// mocked backend responses. Not used by the app.
export function __resetNetworkCaches() {
  ghAvailableCache = null;
  ghLoginCache = null;
  prCache.clear();
}

// Redirect Claude Code's notifications into our terminal: disable its built-in
// (desktop) channel, and make the Stop hook emit an OSC 777 our parser catches.
// So notifications fire on turn-completion only — never on startup or the bell.
const claudeStopOsc =
  `printf '%s' '{"terminalSequence":"\\u001b]777;notify;Claude Code;Turn complete\\u0007"}'`;
const CLAUDE_SETTINGS = JSON.stringify({
  preferredNotifChannel: "notifications_disabled",
  hooks: {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: claudeStopOsc, timeout: 10 }] }],
  },
});

// Per-agent launch args: instrument Claude (session id + settings), and on
// restore use each agent's resume command. Other agents that emit OSC
// notifications are handled generically by the terminal parser.
function launchArgs(agent: AgentDef, sessionId: string | undefined, resume: boolean): string[] {
  if (agent.id === "claude" && sessionId) {
    const base = resume ? ["--resume", sessionId] : ["--session-id", sessionId];
    return [...base, "--settings", CLAUDE_SETTINGS];
  }
  if (resume && agent.resume.length) return agent.resume;
  return agent.args;
}

interface State {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  panes: Pane[];
  notifications: Notif[];
  agents: AgentDef[];
  ghAvailable: boolean;
  busy: boolean;
  error: string | null;
  hydrated: boolean;
  sidebarVisible: boolean;
  // True below the compact breakpoint (<768px), where the inspector panel
  // overlays the workspace as a drawer instead of pushing it. Driven by a
  // matchMedia listener in App; components read it to switch layout mode.
  compact: boolean;
  eventsDir: string | null;
  codexHome: string | null;
  update: UpdateState;

  persist(): void;
  hydrate(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  closeWorkspace(id: string): void;
  setActiveWorkspace(id: string): void;
  cycleWorkspace(dir: number): void;
  focusWorkspaceIndex(i: number): void;
  patchWorkspace(id: string, p: Partial<Workspace>): void;

  refreshStatus(wsId?: string): Promise<void>;
  setPanel(p: Panel): void;
  toggleSidebar(): void;
  setCompact(v: boolean): void;
  closeActivePane(): void;

  addPane(agent?: AgentDef, wsId?: string): void;
  splitActive(dir: Dir, agent?: AgentDef): void;
  removePane(paneId: string): void;
  selectPane(paneId: string): void;
  selectTab(tabId: string): void;
  setRatio(splitNodeId: string, ratio: number): void;
  bindPty(paneId: string, ptyId: string): void;

  openDiff(file: string, staged: boolean): void;
  openPr(pr: PrSummary): void;
  openCommit(oid: string): void;
  showTerminal(): void;
  setCommitMsg(s: string): void;

  stage(path: string): Promise<void>;
  unstage(path: string): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  commit(): Promise<void>;
  loadPrs(wsId?: string, force?: boolean): Promise<void>;

  onAttention(ptyId: string): void;
  onNotify(ptyId: string, title: string, body: string): void;
  onPaneNotify(paneId: string, body: string): void;
  onTitle(ptyId: string, title: string): void;
  dismissNotification(id: string): void;
  clearNotifications(): void;

  checkForUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  restartForUpdate(): Promise<void>;
}

export const useStore = create<State>((set, get) => {
  const active = () => get().workspaces.find((w) => w.id === get().activeWorkspaceId) ?? null;
  const patch = (id: string, p: Partial<Workspace>) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  const patchTab = (wsId: string, tabId: string, fn: (t: Tab) => Tab) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === wsId ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? fn(t) : t)) } : w,
      ),
    }));
  const clearAttn = (predicate: (p: Pane) => boolean) =>
    set((s) => ({
      panes: s.panes.map((p) => (predicate(p) ? { ...p, attention: false } : p)),
    }));
  // In compact mode the panel floats over the workspace as a drawer; once the
  // user picks something from it (a file/PR/commit), dismiss it so the chosen
  // view isn't hidden behind it. A no-op in regular mode (push layout).
  const closeDrawerIfCompact = () => {
    if (get().compact) set({ sidebarVisible: false });
  };

  const paneVisible = (pane: Pane) => {
    const ws = get().workspaces.find((w) => w.id === pane.workspaceId);
    return (
      !!ws &&
      ws.id === get().activeWorkspaceId &&
      pane.tabId === ws.activeTab &&
      ws.editor.type === "terminal"
    );
  };

  // Per-pane env: SWARM_EVENT_FILE wires the generic notification watcher;
  // CODEX_HOME redirects Codex onto our notify-enabled config.
  const paneEnv = (paneId: string, agentId: string): [string, string][] => {
    const env: [string, string][] = [];
    const ev = get().eventsDir;
    if (ev) env.push(["SWARM_EVENT_FILE", `${ev}/${paneId}`]);
    const ch = get().codexHome;
    if (agentId === "codex" && ch) env.push(["CODEX_HOME", ch]);
    return env;
  };

  const makePane = (ws: Workspace, tabId: string, agent?: AgentDef): Pane => {
    const a = agent ?? get().agents.find((x) => x.id === "shell");
    const paneId = uid("pane");
    const agentId = a?.id ?? "shell";
    const sessionId = agentId === "claude" ? crypto.randomUUID() : undefined;
    return {
      paneId,
      workspaceId: ws.id,
      tabId,
      ptyId: null,
      title: a?.name ?? "Shell",
      agentId,
      command: a?.command ?? "bash",
      args: a ? launchArgs(a, sessionId, false) : [],
      cwd: ws.repo.path,
      attention: false,
      sessionId,
      env: paneEnv(paneId, agentId),
    };
  };

  return {
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
    compact: false,
    eventsDir: null,
    codexHome: null,
    update: { status: "idle", progress: 0 },

    patchWorkspace: patch,

    toggleSidebar() {
      set((s) => ({ sidebarVisible: !s.sidebarVisible }));
    },

    setCompact(v) {
      if (get().compact !== v) set({ compact: v });
    },

    cycleWorkspace(dir) {
      const { workspaces, activeWorkspaceId } = get();
      if (!workspaces.length) return;
      const i = workspaces.findIndex((w) => w.id === activeWorkspaceId);
      const next = workspaces[(i + dir + workspaces.length) % workspaces.length];
      get().setActiveWorkspace(next.id);
    },

    focusWorkspaceIndex(i) {
      const ws = get().workspaces[i - 1];
      if (ws) get().setActiveWorkspace(ws.id);
    },

    closeActivePane() {
      const ws = active();
      const tab = ws?.tabs.find((t) => t.id === ws.activeTab);
      if (tab) get().removePane(tab.activeLeaf);
    },

    persist() {
      if (!get().hydrated) return;
      const { workspaces, panes, activeWorkspaceId } = get();
      saveSnap({
        v: 1,
        activeWorkspaceId,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          repoPath: w.repo.path,
          panel: w.panel,
          activeTab: w.activeTab,
          tabs: w.tabs.map((t) => ({ id: t.id, layout: t.layout, activeLeaf: t.activeLeaf })),
          panes: panes
            .filter((p) => p.workspaceId === w.id)
            .map((p) => ({
              paneId: p.paneId,
              tabId: p.tabId,
              agentId: p.agentId,
              command: p.command,
              args: p.args,
              cwd: p.cwd,
              title: p.title,
              sessionId: p.sessionId,
            })),
        })),
      });
    },

    async hydrate() {
      try {
        const [agents, gh, eventsDir] = await Promise.all([
          api.listAgents(),
          ghAvailableOnce(),
          api.eventsDir().catch(() => null),
        ]);
        set({ agents, ghAvailable: gh, eventsDir });
        api.prepareCodexHome().then((p) => set({ codexHome: p })).catch(() => {});
        const snap = await loadSnap();
        if (snap?.workspaces.length) {
          const workspaces: Workspace[] = [];
          const panes: Pane[] = [];
          for (const sw of snap.workspaces) {
            let repo: RepoInfo;
            try {
              // Authorize the root before any path command runs against it.
              await api.registerRoot(sw.repoPath);
              repo = await api.repoInfo(sw.repoPath);
              // repoInfo resolves to the canonical workdir (which every later
              // command uses); authorize that too in case it differs.
              if (repo.path !== sw.repoPath) await api.registerRoot(repo.path);
            } catch {
              continue; // repo moved/deleted/outside-root — drop this workspace
            }
            workspaces.push({
              id: sw.id,
              repo,
              // Migrate the retired "terminals" panel (and any unknown) to scm.
              panel: sw.panel === "scm" || sw.panel === "prs" || sw.panel === "notifications" || sw.panel === "history" ? sw.panel : "scm",
              editor: { type: "terminal" },
              tabs: sw.tabs,
              activeTab: sw.activeTab,
              commitMsg: "",
              changes: [],
              diffStats: null,
              prs: [],
              ghLogin: null,
            });
            for (const sp of sw.panes) {
              // Relaunch resuming the same session. Claude only persists a
              // transcript after the first turn, so a session that was opened but
              // never used cannot be `--resume`d ("No conversation found with
              // session ID"). Check persistence first: resume when it exists,
              // otherwise start fresh reusing the same id (`--session-id`).
              const agent = agents.find((a) => a.id === sp.agentId);
              let resume = true;
              if (agent?.id === "claude") {
                resume = sp.sessionId
                  ? await api.claudeSessionExists(sp.sessionId)
                  : false;
              }
              const args = agent ? launchArgs(agent, sp.sessionId, resume) : sp.args;
              panes.push({
                paneId: sp.paneId,
                workspaceId: sw.id,
                tabId: sp.tabId,
                ptyId: null,
                title: sp.title,
                agentId: sp.agentId,
                command: sp.command,
                args,
                cwd: sp.cwd,
                attention: false,
                sessionId: sp.sessionId,
                env: paneEnv(sp.paneId, sp.agentId),
              });
            }
          }
          const activeWorkspaceId =
            workspaces.find((w) => w.id === snap.activeWorkspaceId)?.id ?? workspaces[0]?.id ?? null;
          set({ workspaces, panes, activeWorkspaceId });
          for (const w of workspaces) {
            api.watchWorktree(w.id, w.repo.path).catch(() => {});
            get().refreshStatus(w.id);
            if (gh) {
              ghLoginOnce().then((l) => patch(w.id, { ghLogin: l }));
              get().loadPrs(w.id);
            }
          }
        }
      } catch {
        /* ignore */
      } finally {
        set({ hydrated: true });
      }
    },

    async addWorkspace(path) {
      set({ busy: true, error: null });
      try {
        if (!get().agents.length) set({ agents: await api.listAgents() });
        // Authorize the user-picked root for the path guard before any command
        // touches it; repoInfo's canonical path (used by everything after) too.
        await api.registerRoot(path);
        const [repo, gh] = await Promise.all([api.repoInfo(path), ghAvailableOnce()]);
        if (repo.path !== path) await api.registerRoot(repo.path);
        const id = uid("ws");
        const ws: Workspace = {
          id,
          repo,
          panel: "scm",
          editor: { type: "terminal" },
          tabs: [],
          activeTab: null,
          commitMsg: "",
          changes: [],
          diffStats: null,
          prs: [],
          ghLogin: null,
        };
        set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: id, ghAvailable: gh }));
        api.watchWorktree(id, repo.path).catch(() => {});
        get().addPane(undefined, id);
        await get().refreshStatus(id);
        if (gh) {
          ghLoginOnce().then((l) => patch(id, { ghLogin: l }));
          get().loadPrs(id);
        }
      } catch (e: any) {
        set({ error: e?.message ?? String(e) });
      } finally {
        set({ busy: false });
      }
    },

    closeWorkspace(id) {
      api.unwatchWorktree(id).catch(() => {});
      // Kill the workspace's PTYs explicitly — their components unmount without
      // killing, so closing the workspace is where they're reaped.
      for (const p of get().panes) {
        if (p.workspaceId === id && p.ptyId) api.ptyKill(p.ptyId).catch(() => {});
      }
      set((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id);
        return {
          workspaces,
          panes: s.panes.filter((p) => p.workspaceId !== id),
          notifications: s.notifications.filter((n) => n.workspaceId !== id),
          activeWorkspaceId:
            s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId,
        };
      });
    },

    setActiveWorkspace(id) {
      set({ activeWorkspaceId: id });
      const ws = get().workspaces.find((w) => w.id === id);
      if (ws?.activeTab) clearAttn((p) => p.tabId === ws.activeTab);
    },

    async refreshStatus(wsId) {
      const ws = wsId ? get().workspaces.find((w) => w.id === wsId) : active();
      if (!ws) return;
      const { changes, stats } = await api.statusAndStats(ws.repo.path);
      patch(ws.id, { changes, diffStats: stats });
    },

    setPanel(panel) {
      const ws = active();
      // Inspector is independent of the editor now: switching panels never
      // touches the main area (a diff/pr/commit stays open behind the panel).
      if (ws) patch(ws.id, { panel });
      set({ sidebarVisible: true });
    },

    addPane(agent, wsId) {
      const ws = get().workspaces.find((w) => w.id === (wsId ?? get().activeWorkspaceId));
      if (!ws) return;
      const tabId = uid("tab");
      const pane = makePane(ws, tabId, agent);
      const tab: Tab = { id: tabId, layout: leaf(pane.paneId), activeLeaf: pane.paneId };
      set((s) => ({ panes: [...s.panes, pane] }));
      patch(ws.id, {
        tabs: [...ws.tabs, tab],
        activeTab: tabId,
        editor: { type: "terminal" },
      });
    },

    splitActive(dir, agent) {
      const ws = active();
      const tab = ws?.tabs.find((t) => t.id === ws.activeTab);
      if (!ws || !tab) return;
      const pane = makePane(ws, tab.id, agent);
      const newLayout = replaceLeaf(tab.layout, tab.activeLeaf, {
        type: "split",
        id: splitId(),
        dir,
        a: leaf(tab.activeLeaf),
        b: leaf(pane.paneId),
        ratio: 0.5,
      });
      set((s) => ({ panes: [...s.panes, pane] }));
      patchTab(ws.id, tab.id, (t) => ({ ...t, layout: newLayout, activeLeaf: pane.paneId }));
      patch(ws.id, { editor: { type: "terminal" } });
    },

    removePane(paneId) {
      const pane = get().panes.find((p) => p.paneId === paneId);
      // The Terminal no longer kills on unmount (PTYs survive workspace switches),
      // so removal is the explicit kill point.
      if (pane?.ptyId) api.ptyKill(pane.ptyId).catch(() => {});
      set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) }));
      if (!pane) return;
      const ws = get().workspaces.find((w) => w.id === pane.workspaceId);
      const tab = ws?.tabs.find((t) => t.id === pane.tabId);
      if (!ws || !tab) return;
      const newLayout = removeLeaf(tab.layout, paneId);
      if (newLayout === null) {
        const tabs = ws.tabs.filter((t) => t.id !== tab.id);
        patch(ws.id, {
          tabs,
          activeTab: ws.activeTab === tab.id ? (tabs[tabs.length - 1]?.id ?? null) : ws.activeTab,
        });
      } else {
        patchTab(ws.id, tab.id, (t) => ({
          ...t,
          layout: newLayout,
          activeLeaf: t.activeLeaf === paneId ? leaves(newLayout)[0] : t.activeLeaf,
        }));
      }
    },

    selectPane(paneId) {
      const pane = get().panes.find((p) => p.paneId === paneId);
      if (!pane) return;
      clearAttn((p) => p.paneId === paneId);
      patchTab(pane.workspaceId, pane.tabId, (t) => ({ ...t, activeLeaf: paneId }));
      // Focusing a terminal surfaces it in the editor; the inspector stays on
      // whatever panel the user had open.
      patch(pane.workspaceId, {
        activeTab: pane.tabId,
        editor: { type: "terminal" },
      });
    },

    selectTab(tabId) {
      const ws = active();
      if (!ws) return;
      clearAttn((p) => p.tabId === tabId);
      patch(ws.id, { activeTab: tabId, editor: { type: "terminal" } });
    },

    setRatio(splitNodeId, ratio) {
      const ws = active();
      const tab = ws?.tabs.find((t) => t.id === ws.activeTab);
      if (!ws || !tab) return;
      patchTab(ws.id, tab.id, (t) => ({ ...t, layout: setRatioIn(t.layout, splitNodeId, ratio) }));
    },

    bindPty(paneId, ptyId) {
      set((s) => ({ panes: s.panes.map((p) => (p.paneId === paneId ? { ...p, ptyId } : p)) }));
    },

    openDiff(file, staged) {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "diff", file, staged } });
      closeDrawerIfCompact();
    },
    openPr(pr) {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "pr", pr } });
      closeDrawerIfCompact();
    },
    openCommit(oid) {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "commit", oid } });
      closeDrawerIfCompact();
    },
    showTerminal() {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "terminal" } });
    },
    setCommitMsg(commitMsg) {
      const ws = active();
      if (ws) patch(ws.id, { commitMsg });
    },

    async stage(path) {
      const ws = active();
      if (!ws) return;
      await api.stage(ws.repo.path, [path]);
      await get().refreshStatus(ws.id);
    },
    async unstage(path) {
      const ws = active();
      if (!ws) return;
      await api.unstage(ws.repo.path, [path]);
      await get().refreshStatus(ws.id);
    },
    async stageAll() {
      const ws = active();
      if (!ws) return;
      await api.stageAll(ws.repo.path);
      await get().refreshStatus(ws.id);
    },
    async unstageAll() {
      const ws = active();
      if (!ws) return;
      await api.unstageAll(ws.repo.path);
      await get().refreshStatus(ws.id);
    },
    async commit() {
      const ws = active();
      const msg = ws?.commitMsg.trim();
      if (!ws || !msg) return;
      set({ busy: true, error: null });
      try {
        if (!ws.changes.some((c) => c.staged)) await api.stageAll(ws.repo.path);
        await api.commit(ws.repo.path, msg);
        patch(ws.id, { commitMsg: "" });
        await get().refreshStatus(ws.id);
      } catch (e: any) {
        set({ error: e?.message ?? String(e) });
      } finally {
        set({ busy: false });
      }
    },

    async loadPrs(wsId, force = false) {
      const ws = wsId ? get().workspaces.find((w) => w.id === wsId) : active();
      if (!ws) return;
      const cached = prCache.get(ws.repo.path);
      if (!force && cached && Date.now() - cached.ts < PR_TTL_MS) {
        patch(ws.id, { prs: cached.prs });
        return;
      }
      try {
        const prs = await api.prList(ws.repo.path);
        prCache.set(ws.repo.path, { ts: Date.now(), prs });
        patch(ws.id, { prs });
      } catch {
        /* gh missing/unauthed */
      }
    },

    onAttention(ptyId) {
      const pane = get().panes.find((p) => p.ptyId === ptyId);
      if (!pane || paneVisible(pane)) return;
      set((s) => ({
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
    },

    onNotify(ptyId, title, body) {
      const pane = get().panes.find((p) => p.ptyId === ptyId);
      // Suppress entirely when you're already looking at the pane (cmux behaviour).
      if (!pane || paneVisible(pane)) return;
      const notif: Notif = {
        id: uid("n"),
        workspaceId: pane.workspaceId,
        paneId: pane.paneId,
        title: title || pane.title,
        body,
        ts: Date.now(),
        source: "terminal",
      };
      set((s) => ({
        notifications: [notif, ...s.notifications].slice(0, 100),
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
    },

    onPaneNotify(paneId, body) {
      const pane = get().panes.find((p) => p.paneId === paneId);
      if (!pane || paneVisible(pane)) return;
      const notif: Notif = {
        id: uid("n"),
        workspaceId: pane.workspaceId,
        paneId: pane.paneId,
        title: pane.title,
        body,
        ts: Date.now(),
        source: "agent",
      };
      set((s) => ({
        notifications: [notif, ...s.notifications].slice(0, 100),
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
    },

    onTitle(ptyId, title) {
      const t = title.trim();
      if (!t) return;
      set((s) => ({ panes: s.panes.map((p) => (p.ptyId === ptyId ? { ...p, title: t } : p)) }));
    },

    dismissNotification(id) {
      set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
    },

    clearNotifications() {
      set({ notifications: [] });
    },

    // Background check — fires on startup and on an interval. Stays silent on
    // failure (no network, dev build with no bundle): an update check is never
    // worth surfacing an error for. Won't disturb an in-flight download/ready.
    async checkForUpdate() {
      if (get().update.status === "downloading" || get().update.status === "ready") return;
      try {
        const meta = await updater.check();
        if (meta) {
          set({
            update: {
              status: "available",
              version: meta.version,
              notes: meta.notes,
              progress: 0,
            },
          });
        } else if (get().update.status !== "idle") {
          set({ update: { status: "idle", progress: 0 } });
        }
      } catch {
        /* offline / no updater in this build — ignore */
      }
    },

    // User clicked "Update available": download + install, streaming progress.
    // Stops at "ready" — the relaunch is a second, explicit click.
    async installUpdate() {
      if (get().update.status !== "available") return;
      set((s) => ({ update: { ...s.update, status: "downloading", progress: 0 } }));
      try {
        await updater.downloadAndInstall((downloaded, total) => {
          const progress = total ? Math.min(1, downloaded / total) : 0;
          set((s) => ({ update: { ...s.update, progress } }));
        });
        set((s) => ({ update: { ...s.update, status: "ready", progress: 1 } }));
      } catch (e: any) {
        set((s) => ({ update: { ...s.update, status: "error" } }));
      }
    },

    async restartForUpdate() {
      if (get().update.status !== "ready") return;
      await updater.relaunch();
    },
  };
});

export const useActiveWorkspace = () =>
  useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null);
