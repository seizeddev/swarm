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
import { confirmDialog } from "./lib/dialog";
import { notifyOS } from "./lib/notify";
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

type Editor =
  | { type: "terminal" }
  | { type: "diff"; file: string; staged: boolean }
  | { type: "pr"; pr: PrSummary }
  | { type: "commit"; oid: string };

export interface Workspace {
  id: string;
  repo: RepoInfo;
  // User-set display name override. When unset the repo's folder name is shown
  // (`name ?? repo.name`). We don't mutate `repo.name` so the original is kept
  // for re-resolution; an empty rename clears the override back to the repo name.
  name?: string;
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
  // Unread until you focus the pane it came from (or click it in the panel).
  // Read notifications stay in the history list — only the unread *count* (the
  // Bell badge) clears, so re-focusing a terminal silences it without erasing it.
  read: boolean;
}

// Self-update lifecycle. `progress` is 0..1, meaningful only while downloading.
interface UpdateState {
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
// Our Claude Stop hook tags its OSC 777 with this sentinel title (see
// notify_helper.rs). On a Claude pane we accept only notifications carrying it,
// dropping Claude Code's *own* terminal notifications so a turn notifies once.
export const CLAUDE_NOTIF_SENTINEL = "swarm-claude";

function claudeSettings(bin: string): string {
  return JSON.stringify({
    preferredNotifChannel: "notifications_disabled",
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: `"${bin}" --notify-helper claude-stop`, timeout: 10 },
          ],
        },
      ],
    },
  });
}

// Per-agent launch args: instrument Claude (session id + settings), and on
// restore use each agent's resume command. Other agents that emit OSC
// notifications are handled generically by the terminal parser.
function launchArgs(
  agent: AgentDef,
  sessionId: string | undefined,
  resume: boolean,
  bin: string,
): string[] {
  if (agent.id === "claude" && sessionId) {
    const base = resume ? ["--resume", sessionId] : ["--session-id", sessionId];
    return [...base, "--settings", claudeSettings(bin)];
  }
  const base = resume && agent.resume.length ? agent.resume : agent.args;
  // Aider has no hook config; it takes a completion command via launch flag.
  // No assistant text is passed, so the body is the "Turn complete" fallback.
  if (agent.id === "aider") {
    return [
      ...base,
      "--notifications",
      "--notifications-command",
      `"${bin}" --notify-helper event`,
    ];
  }
  return base;
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
  // Bumped by any HEAD-mutating git op (checkout/branch/reset/revert) so views
  // that cache git state out of band — the history graph — can re-fetch.
  gitNonce: number;
  sidebarVisible: boolean;
  // True below the compact breakpoint (<768px), where the inspector panel
  // overlays the workspace as a drawer instead of pushing it. Driven by a
  // matchMedia listener in App; components read it to switch layout mode.
  compact: boolean;
  // Whether the swarm window is the focused/foreground window. Drives whether a
  // background notification escalates to an OS banner (see onNotify). Default
  // true so the app behaves as "in front" until told otherwise.
  windowFocused: boolean;
  // Whether the window is in macOS fullscreen. In fullscreen the OS hides the
  // traffic lights, so the TopBar drops its left padding that normally clears
  // them (see TopBar) — otherwise the title floats with dead space on the left.
  fullscreen: boolean;
  // Absolute path to our own binary (from the backend), used to build agent
  // hooks that re-invoke `<swarmBin> --notify-helper …`. Resolved on hydrate.
  swarmBin: string | null;
  eventsDir: string | null;
  codexHome: string | null;
  update: UpdateState;

  persist(): void;
  hydrate(): Promise<void>;
  /// Raise the native folder picker (in Rust, so the registry stays the real
  /// security boundary) and adopt whatever the user picks as a new workspace.
  /// No-op when the user cancels the dialog.
  addWorkspace(): Promise<void>;
  closeWorkspace(id: string): void;
  closeWorkspaceWithConfirm(id: string): Promise<void>;
  setActiveWorkspace(id: string): void;
  cycleWorkspace(dir: number): void;
  focusWorkspaceIndex(i: number): void;
  renameWorkspace(id: string, name: string): void;

  refreshStatus(wsId?: string): Promise<void>;
  setPanel(p: Panel): void;
  toggleSidebar(): void;
  setCompact(v: boolean): void;
  setWindowFocused(v: boolean): void;
  setFullscreen(v: boolean): void;
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

  initRepo(wsId?: string): Promise<void>;
  stage(path: string): Promise<void>;
  unstage(path: string): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  commit(): Promise<void>;
  discardFiles(paths: string[]): Promise<void>;
  checkoutRef(name: string): Promise<void>;
  createBranchAt(name: string, start: string): Promise<void>;
  resetTo(oid: string, mode: "soft" | "mixed" | "hard"): Promise<void>;
  revertCommit(oid: string): Promise<void>;
  prCheckout(pr: PrSummary): Promise<void>;
  revealPath(path: string): Promise<void>;
  loadPrs(wsId?: string, force?: boolean): Promise<void>;

  closeOtherTabs(tabId: string): void;
  closeTabsToRight(tabId: string): void;

  onAttention(ptyId: string): void;
  onNotify(ptyId: string, title: string, body: string): void;
  onPaneNotify(paneId: string, body: string): void;
  onTitle(ptyId: string, title: string): void;
  dismissNotification(id: string): void;
  clearNotifications(): void;
  setNotificationRead(id: string, read: boolean): void;

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
  // Focusing a pane both clears its attention dot and marks its notifications
  // read — they stay in the history list, but the unread Bell badge drops. So
  // "re-focus the terminal it came from" silences the notification without
  // erasing it.
  const clearAttn = (predicate: (p: Pane) => boolean) =>
    set((s) => {
      const focusedPaneIds = new Set(s.panes.filter(predicate).map((p) => p.paneId));
      return {
        panes: s.panes.map((p) => (predicate(p) ? { ...p, attention: false } : p)),
        notifications: s.notifications.map((n) =>
          focusedPaneIds.has(n.paneId) && !n.read ? { ...n, read: true } : n,
        ),
      };
    });
  // In compact mode the panel floats over the workspace as a drawer; once the
  // user picks something from it (a file/PR/commit), dismiss it so the chosen
  // view isn't hidden behind it. A no-op in regular mode (push layout).
  const closeDrawerIfCompact = () => {
    if (get().compact) set({ sidebarVisible: false });
  };

  // Run a git write-op against the active workspace with shared bookkeeping:
  // busy flag + error surfacing (mirrors `commit`), a status refresh, and — when
  // the op moved HEAD — a repo-info re-fetch (branch name) plus a `gitNonce` bump
  // so the history graph reloads. Errors are caught and shown, never thrown.
  const gitMutate = async (
    fn: (ws: Workspace) => Promise<void>,
    opts: { movedHead?: boolean } = {},
  ) => {
    const ws = active();
    if (!ws) return;
    set({ busy: true, error: null });
    try {
      await fn(ws);
      await get().refreshStatus(ws.id);
      if (opts.movedHead) {
        const info = await api.repoInfo(ws.repo.path).catch(() => null);
        if (info) patch(ws.id, { repo: info });
        set((s) => ({ gitNonce: s.gitNonce + 1 }));
      }
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
    } finally {
      set({ busy: false });
    }
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

  // "Looking at it" = the swarm window is in front AND this pane is the visible
  // one. Only then is a notification pointless. If the window is backgrounded
  // (another app, minimized, behind a window), you can't see even the visible
  // pane — so it still warrants an OS banner. Mirrors cmux's app-focus + active
  // -pane gate (our own implementation).
  const lookingAtPane = (pane: Pane) => get().windowFocused && paneVisible(pane);

  // Per-pane env: SWARM_EVENT_FILE wires the generic notification watcher;
  // CODEX_HOME redirects Codex onto our notify-enabled config.
  const paneEnv = (paneId: string, agentId: string, args?: string[]): [string, string][] => {
    const env: [string, string][] = [];
    const ev = get().eventsDir;
    if (ev) env.push(["SWARM_EVENT_FILE", `${ev}/${paneId}`]);
    // Stamp every PTY with its pane id so an agent's session-start hook can key
    // its capture record to this pane (enables cmux-style resume-on-restart, even
    // for an agent typed by hand into a shell). See src-tauri/agent_session.rs.
    env.push(["SWARM_PANE_ID", paneId]);
    // When swarm launches the agent it knows the exact argv — hand it over so the
    // capture is precise (values with spaces, e.g. the injected `--settings`,
    // survive), rather than relying on the process-scan fallback.
    if (agentId !== "shell" && args && args.length) {
      env.push(["SWARM_AGENT_ARGV_JSON", JSON.stringify(args)]);
    }
    const ch = get().codexHome;
    if (agentId === "codex" && ch) env.push(["CODEX_HOME", ch]);
    return env;
  };

  const makePane = (ws: Workspace, tabId: string, agent?: AgentDef): Pane => {
    const a = agent ?? get().agents.find((x) => x.id === "shell");
    const paneId = uid("pane");
    const agentId = a?.id ?? "shell";
    const sessionId = agentId === "claude" ? crypto.randomUUID() : undefined;
    const args = a ? launchArgs(a, sessionId, false, get().swarmBin ?? "swarm") : [];
    return {
      paneId,
      workspaceId: ws.id,
      tabId,
      ptyId: null,
      title: a?.name ?? "Shell",
      agentId,
      command: a?.command ?? "bash",
      args,
      cwd: ws.repo.path,
      attention: false,
      sessionId,
      env: paneEnv(paneId, agentId, args),
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
    gitNonce: 0,
    hydrated: false,
    sidebarVisible: true,
    compact: false,
    windowFocused: true,
    fullscreen: false,
    swarmBin: null,
    eventsDir: null,
    codexHome: null,
    update: { status: "idle", progress: 0 },

    toggleSidebar() {
      set((s) => ({ sidebarVisible: !s.sidebarVisible }));
    },

    setCompact(v) {
      if (get().compact !== v) set({ compact: v });
    },

    setFullscreen(v) {
      if (get().fullscreen !== v) set({ fullscreen: v });
    },

    setWindowFocused(v) {
      if (get().windowFocused === v) return;
      set({ windowFocused: v });
      // Regaining focus = you're now looking at the visible pane(s): clear their
      // attention + mark their notifications read, without needing a pane click.
      if (v) {
        const ws = active();
        if (ws && ws.editor.type === "terminal") {
          clearAttn((p) => p.workspaceId === ws.id && p.tabId === ws.activeTab);
        }
      }
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

    // Override the rail/tooltip display name. A blank (or repo-name-equal) value
    // clears the override so it falls back to the repo's folder name. Stored on
    // the workspace, not `repo`, so the canonical name is never lost.
    renameWorkspace(id, name) {
      const clean = name.trim();
      const ws = get().workspaces.find((w) => w.id === id);
      const next = !clean || clean === ws?.repo.name ? undefined : clean;
      patch(id, { name: next });
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
          name: w.name,
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
        const [agents, gh, eventsDir, swarmBin, live] = await Promise.all([
          api.listAgents(),
          ghAvailableOnce(),
          api.eventsDir().catch(() => null),
          api.swarmBin().catch(() => null),
          // PTYs that outlived a webview reload (the Rust process survives a
          // WebContent reload). Their panes reattach to the running agent below
          // instead of re-spawning — re-spawning would orphan the live PTY, whose
          // render thread then leaks frames into the webview and OOMs it.
          api.ptyLive().catch(() => [] as [string, string][]),
        ]);
        const livePty = new Map<string, string>(live);
        set({ agents, ghAvailable: gh, eventsDir, swarmBin });
        api
          .prepareCodexHome()
          .then((p) => set({ codexHome: p }))
          .catch(() => {});
        // Install completion-notification hooks for agents without an isolated
        // config (Gemini/Cursor/OpenCode/Amp). Best-effort, gated on PATH in Rust.
        api.installAgentHooks().catch(() => {});
        const snap = await loadSnap();
        if (snap?.workspaces.length) {
          const workspaces: Workspace[] = [];
          const panes: Pane[] = [];
          for (const sw of snap.workspaces) {
            let repo: RepoInfo;
            try {
              // Trusted roots are now loaded Rust-side from `trusted-roots.json`
              // before this command runs (see `setup` + `WorkspaceRegistry::load_trusted`),
              // so we can call repoInfo directly. A path that no longer
              // canonicalises (repo moved/deleted) was already dropped on load
              // and `ensure_within_root` raises Invalid here — we skip it.
              repo = await api.repoInfo(sw.repoPath);
            } catch {
              continue; // repo moved/deleted/outside-root — drop this workspace
            }
            workspaces.push({
              id: sw.id,
              repo,
              name: sw.name,
              // Migrate the retired "terminals" panel (and any unknown) to scm.
              panel:
                sw.panel === "scm" ||
                sw.panel === "prs" ||
                sw.panel === "notifications" ||
                sw.panel === "history"
                  ? sw.panel
                  : "scm",
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
              // A live PTY for this pane means we're recovering from a webview
              // reload (not a fresh launch): reattach to the still-running agent
              // rather than re-resuming it. Re-resuming would spawn a second agent
              // and orphan the live PTY — the leak that OOMs WebContent and causes
              // the reload. Terminal.tsx attaches once it sees this `ptyId`. The
              // persisted launch info is kept so a later in-app respawn still works.
              const livePtyId = livePty.get(sp.paneId);
              if (livePtyId) {
                panes.push({
                  paneId: sp.paneId,
                  workspaceId: sw.id,
                  tabId: sp.tabId,
                  ptyId: livePtyId,
                  title: sp.title,
                  agentId: sp.agentId,
                  command: sp.command,
                  args: sp.args,
                  cwd: sp.cwd,
                  attention: false,
                  sessionId: sp.sessionId,
                  env: paneEnv(sp.paneId, sp.agentId, sp.args),
                });
                continue;
              }
              // cmux-style restore: if an agent ran in this pane and its hook
              // captured a session (even a `claude --dangerously-skip-permissions`
              // typed into a shell), re-spawn its native resume command — the
              // session *and* the user's flags come back. Takes precedence over the
              // persisted pane kind (a shell pane that ran Claude restores as
              // Claude). Claude additionally keeps swarm's notification settings.
              const captured = await api.agentSessionResume(sp.paneId).catch(() => null);
              if (captured) {
                const a = agents.find((x) => x.id === captured.agent);
                const args =
                  captured.agent === "claude"
                    ? [...captured.args, "--settings", claudeSettings(swarmBin ?? "swarm")]
                    : captured.args;
                panes.push({
                  paneId: sp.paneId,
                  workspaceId: sw.id,
                  tabId: sp.tabId,
                  ptyId: null,
                  title: a?.name ?? sp.title,
                  agentId: captured.agent,
                  command: captured.command,
                  args,
                  cwd: captured.cwd || sp.cwd,
                  attention: false,
                  sessionId: captured.sessionId,
                  env: paneEnv(sp.paneId, captured.agent, args),
                });
                continue;
              }
              // Relaunch resuming the same session. Claude only persists a
              // transcript after the first turn, so a session that was opened but
              // never used cannot be `--resume`d ("No conversation found with
              // session ID"). Check persistence first: resume when it exists,
              // otherwise start fresh reusing the same id (`--session-id`).
              const agent = agents.find((a) => a.id === sp.agentId);
              let resume = true;
              if (agent?.id === "claude") {
                resume = sp.sessionId ? await api.claudeSessionExists(sp.sessionId) : false;
              }
              const args = agent
                ? launchArgs(agent, sp.sessionId, resume, swarmBin ?? "swarm")
                : sp.args;
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
                env: paneEnv(sp.paneId, sp.agentId, args),
              });
            }
          }
          const activeWorkspaceId =
            workspaces.find((w) => w.id === snap.activeWorkspaceId)?.id ??
            workspaces[0]?.id ??
            null;
          // Reap PTYs orphaned by a reload — every live PTY we did NOT reattach to
          // (a closed pane, a workspace dropped above, or a duplicate for one pane).
          // Must run BEFORE `set` mounts the panes: panes about to re-spawn have no
          // PTY yet, so keeping only the reattached ids can't reap a fresh spawn.
          const keepPtyIds = panes.map((p) => p.ptyId).filter((id): id is string => id != null);
          await api.ptyReap(keepPtyIds).catch(() => {});
          set({ workspaces, panes, activeWorkspaceId });
          for (const w of workspaces) {
            api.watchWorktree(w.id, w.repo.path).catch(() => {});
            get().refreshStatus(w.id);
            if (gh && w.repo.isRepo) {
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

    async addWorkspace() {
      set({ busy: true, error: null });
      try {
        if (!get().agents.length) set({ agents: await api.listAgents() });
        // pickWorkspace raises the OS folder picker IN RUST, registers the
        // chosen path as a trusted root (along with the canonical workdir from
        // repo_info), and returns the repo info — there is no longer a renderer
        // call that authorizes a path. `null` = user cancelled.
        const picked = await api.pickWorkspace();
        if (!picked) return;
        const gh = await ghAvailableOnce();
        const repo: RepoInfo = picked;
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
        if (gh && repo.isRepo) {
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
        if (p.workspaceId === id) {
          if (p.ptyId) api.ptyKill(p.ptyId).catch(() => {});
          api.agentSessionForget(p.paneId);
        }
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
      // Persist *immediately*, don't wait for the debounced autosave. Closing is
      // a deliberate, structural change, and it's commonly the last thing done
      // before quitting — the 400ms debounce (App.tsx) would lose it if the
      // window closed first, and the workspace would resurrect on next launch.
      get().persist();
    },

    // Close, but prompt first when the workspace has a *running agent* (a
    // non-shell pane with a live PTY) — the case where closing silently kills
    // work (a Claude / Codex session). A bare shell, or an empty workspace,
    // closes without a prompt. Shared by the rail's context menu and the
    // Project ▸ Close Project menu item (Cmd+Shift+W).
    async closeWorkspaceWithConfirm(id) {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws) return;
      const running = get().panes.filter(
        (p) => p.workspaceId === id && p.agentId !== "shell" && p.ptyId,
      );
      if (running.length) {
        const kinds = [...new Set(running.map((p) => p.agentId))].join(", ");
        const plural = running.length > 1 ? "s" : "";
        const ok = await confirmDialog({
          title: `Close “${ws.repo.name}”?`,
          body: `${running.length} running agent${plural} (${kinds}) will be stopped.`,
          confirmLabel: "Close",
          destructive: true,
        });
        if (!ok) return;
      }
      get().closeWorkspace(id);
    },

    setActiveWorkspace(id) {
      set({ activeWorkspaceId: id });
      const ws = get().workspaces.find((w) => w.id === id);
      if (ws?.activeTab) clearAttn((p) => p.tabId === ws.activeTab);
    },

    async refreshStatus(wsId) {
      const ws = wsId ? get().workspaces.find((w) => w.id === wsId) : active();
      if (!ws || !ws.repo.isRepo) return; // a plain folder has no git status to read
      const { changes, stats } = await api.statusAndStats(ws.repo.path);
      patch(ws.id, { changes, diffStats: stats });
    },

    // Turn an opened plain folder into a git repo (the SCM panel's Initialize
    // button). The same path everything else uses: re-read repo info, then wire
    // up the watcher/status/PRs as a freshly-opened real repo would.
    async initRepo(wsId) {
      const ws = wsId ? get().workspaces.find((w) => w.id === wsId) : active();
      if (!ws || ws.repo.isRepo) return;
      set({ busy: true, error: null });
      try {
        const repo = await api.initRepo(ws.repo.path);
        patch(ws.id, { repo });
        await get().refreshStatus(ws.id);
        if (get().ghAvailable) {
          ghLoginOnce().then((l) => patch(ws.id, { ghLogin: l }));
          get().loadPrs(ws.id);
        }
      } catch (e: any) {
        set({ error: e?.message ?? String(e) });
      } finally {
        set({ busy: false });
      }
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
      // Drop any captured agent-session record so a closed pane doesn't resurrect
      // an agent on next launch.
      api.agentSessionForget(paneId);
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

    // Close every tab except `tabId` (VS Code "Close Others"). Each tab is torn
    // down by removing all its leaf panes — reusing removePane so the PTY kill +
    // session-forget bookkeeping runs exactly once per pane.
    closeOtherTabs(tabId) {
      const ws = active();
      if (!ws) return;
      const doomed = ws.tabs.filter((t) => t.id !== tabId);
      const paneIds = doomed.flatMap((t) => leaves(t.layout));
      paneIds.forEach((id) => get().removePane(id));
      get().selectTab(tabId);
    },

    // Close every tab to the right of `tabId` (VS Code "Close to the Right").
    closeTabsToRight(tabId) {
      const ws = active();
      if (!ws) return;
      const idx = ws.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const paneIds = ws.tabs.slice(idx + 1).flatMap((t) => leaves(t.layout));
      paneIds.forEach((id) => get().removePane(id));
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

    async discardFiles(paths) {
      if (!paths.length) return;
      await gitMutate((ws) => api.discard(ws.repo.path, paths));
    },
    async checkoutRef(name) {
      await gitMutate((ws) => api.checkoutRef(ws.repo.path, name), { movedHead: true });
    },
    async createBranchAt(name, start) {
      const clean = name.trim();
      if (!clean) return;
      await gitMutate((ws) => api.createBranch(ws.repo.path, clean, start), { movedHead: true });
    },
    async resetTo(oid, mode) {
      await gitMutate((ws) => api.resetTo(ws.repo.path, oid, mode), { movedHead: true });
    },
    async revertCommit(oid) {
      await gitMutate((ws) => api.revertCommit(ws.repo.path, oid).then(() => {}), {
        movedHead: true,
      });
    },
    async prCheckout(pr) {
      await gitMutate((ws) => api.prCheckout(ws.repo.path, pr.number), { movedHead: true });
    },
    async revealPath(path) {
      await api.revealPath(path).catch((e: any) => set({ error: e?.message ?? String(e) }));
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
      if (!pane || lookingAtPane(pane)) return;
      set((s) => ({
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
    },

    onNotify(ptyId, title, body) {
      const pane = get().panes.find((p) => p.ptyId === ptyId);
      // Suppress entirely only when you're already looking at the pane (window
      // in front AND this is the visible pane). Otherwise record it in-app, and
      // if the window is backgrounded, escalate to an OS banner with sound.
      if (!pane || lookingAtPane(pane)) return;
      // On a Claude pane our Stop hook is the source of truth (sentinel title);
      // drop Claude Code's own terminal notifications so a turn fires once, with
      // our real-last-message body — not a duplicate / an intermediate preamble.
      if (pane.agentId === "claude" && title !== CLAUDE_NOTIF_SENTINEL) return;
      const shownTitle = pane.agentId === "claude" ? pane.title : title || pane.title;
      const notif: Notif = {
        id: uid("n"),
        workspaceId: pane.workspaceId,
        paneId: pane.paneId,
        title: shownTitle,
        body,
        ts: Date.now(),
        source: "terminal",
        read: false,
      };
      set((s) => ({
        notifications: [notif, ...s.notifications].slice(0, 100),
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
      if (!get().windowFocused) notifyOS(notif.title, body, pane.paneId, pane.workspaceId);
    },

    onPaneNotify(paneId, body) {
      const pane = get().panes.find((p) => p.paneId === paneId);
      if (!pane || lookingAtPane(pane)) return;
      const notif: Notif = {
        id: uid("n"),
        workspaceId: pane.workspaceId,
        paneId: pane.paneId,
        title: pane.title,
        body,
        ts: Date.now(),
        source: "agent",
        read: false,
      };
      set((s) => ({
        notifications: [notif, ...s.notifications].slice(0, 100),
        panes: s.panes.map((p) => (p.paneId === pane.paneId ? { ...p, attention: true } : p)),
      }));
      if (!get().windowFocused) notifyOS(notif.title, body, pane.paneId, pane.workspaceId);
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

    setNotificationRead(id, read) {
      set((s) => {
        const updated = s.notifications.map((n) => (n.id === id ? { ...n, read } : n));
        // Marking unread re-surfaces it: lift it to the front (the list is
        // otherwise newest-first by prepend) so it's visible again, mirroring how
        // a fresh notification arrives at the top.
        if (!read) {
          const hit = updated.find((n) => n.id === id);
          if (hit) return { notifications: [hit, ...updated.filter((n) => n.id !== id)] };
        }
        return { notifications: updated };
      });
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
