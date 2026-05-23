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

export type Panel = "terminals" | "scm" | "prs" | "notifications" | "history";

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
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${seq++}`;

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
  eventsDir: string | null;
  codexHome: string | null;

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
  loadPrs(wsId?: string): Promise<void>;

  onAttention(ptyId: string): void;
  onNotify(ptyId: string, title: string, body: string): void;
  onPaneNotify(paneId: string, body: string): void;
  onTitle(ptyId: string, title: string): void;
  clearNotifications(): void;
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
    eventsDir: null,
    codexHome: null,

    patchWorkspace: patch,

    toggleSidebar() {
      set((s) => ({ sidebarVisible: !s.sidebarVisible }));
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
          api.ghAvailable(),
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
              repo = await api.repoInfo(sw.repoPath);
            } catch {
              continue; // repo moved/deleted — drop this workspace
            }
            workspaces.push({
              id: sw.id,
              repo,
              panel: (sw.panel as Panel) ?? "terminals",
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
              // Relaunch resuming the same session: Claude via `--resume <uuid>`
              // (exact), others via their resume command (`codex resume --last`).
              const agent = agents.find((a) => a.id === sp.agentId);
              const args = agent ? launchArgs(agent, sp.sessionId, true) : sp.args;
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
            get().refreshStatus(w.id);
            if (gh) {
              api.ghLogin().then((l) => patch(w.id, { ghLogin: l }));
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
        const [repo, gh] = await Promise.all([api.repoInfo(path), api.ghAvailable()]);
        const id = uid("ws");
        const ws: Workspace = {
          id,
          repo,
          panel: "terminals",
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
        get().addPane(undefined, id);
        await get().refreshStatus(id);
        if (gh) {
          api.ghLogin().then((l) => patch(id, { ghLogin: l }));
          get().loadPrs(id);
        }
      } catch (e: any) {
        set({ error: e?.message ?? String(e) });
      } finally {
        set({ busy: false });
      }
    },

    closeWorkspace(id) {
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
      const [changes, diffStats] = await Promise.all([
        api.changes(ws.repo.path),
        api.diffStats(ws.repo.path),
      ]);
      patch(ws.id, { changes, diffStats });
    },

    setPanel(panel) {
      const ws = active();
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
        panel: "terminals",
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
      patch(pane.workspaceId, { activeTab: pane.tabId, editor: { type: "terminal" } });
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
    },
    openPr(pr) {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "pr", pr } });
    },
    openCommit(oid) {
      const ws = active();
      if (ws) patch(ws.id, { editor: { type: "commit", oid } });
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

    async loadPrs(wsId) {
      const ws = wsId ? get().workspaces.find((w) => w.id === wsId) : active();
      if (!ws) return;
      try {
        const prs = await api.prList(ws.repo.path);
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

    clearNotifications() {
      set({ notifications: [] });
    },
  };
});

export const useActiveWorkspace = () =>
  useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null);
