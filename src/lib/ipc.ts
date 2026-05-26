// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke, Channel } from "@tauri-apps/api/core";
import { decodeUpdate } from "./term/grid";
import type {
  AgentDef,
  CommitDetail,
  CommitInfo,
  DiffHunk,
  PrDetail,
  PrSummary,
  RepoInfo,
  ResumeCommand,
  StatusAndStats,
  WireUpdate,
} from "./types";

export const api = {
  // Authorize a repository root for the path-allowlist guard (src-tauri/guard.rs).
  // Must be called before any git/PTY command touches that root.
  registerRoot: (path: string) => invoke<void>("register_root", { path }),
  repoInfo: (path: string) => invoke<RepoInfo>("repo_info", { path }),
  fileDiffHunks: (worktreePath: string, file: string, staged: boolean) =>
    invoke<DiffHunk[]>("file_diff_hunks", { worktreePath, file, staged }),
  statusAndStats: (worktreePath: string) =>
    invoke<StatusAndStats>("status_and_stats", { worktreePath }),
  gitLog: (repoPath: string, limit = 200) => invoke<CommitInfo[]>("git_log", { repoPath, limit }),
  commitDetail: (repoPath: string, oid: string) =>
    invoke<CommitDetail>("commit_detail", { repoPath, oid }),
  commitDiff: (repoPath: string, oid: string) => invoke<string>("commit_diff", { repoPath, oid }),
  saveSession: (data: string) => invoke<void>("save_session", { data }),
  loadSession: () => invoke<string | null>("load_session"),
  eventsDir: () => invoke<string>("events_dir"),
  prepareCodexHome: () => invoke<string>("prepare_codex_home"),
  stage: (worktreePath: string, paths: string[]) => invoke<void>("stage", { worktreePath, paths }),
  unstage: (worktreePath: string, paths: string[]) =>
    invoke<void>("unstage", { worktreePath, paths }),
  stageAll: (worktreePath: string) => invoke<void>("stage_all", { worktreePath }),
  unstageAll: (worktreePath: string) => invoke<void>("unstage_all", { worktreePath }),
  commit: (worktreePath: string, message: string) =>
    invoke<string>("commit", { worktreePath, message }),
  discard: (worktreePath: string, paths: string[]) =>
    invoke<void>("discard", { worktreePath, paths }),
  checkoutRef: (repoPath: string, name: string) =>
    invoke<void>("checkout_ref", { repoPath, name }),
  createBranch: (repoPath: string, name: string, start: string) =>
    invoke<void>("create_branch", { repoPath, name, start }),
  resetTo: (repoPath: string, oid: string, mode: "soft" | "mixed" | "hard") =>
    invoke<void>("reset_to", { repoPath, oid, mode }),
  revertCommit: (repoPath: string, oid: string) =>
    invoke<string>("revert_commit", { repoPath, oid }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  prCheckout: (repoPath: string, number: number) =>
    invoke<void>("pr_checkout", { repoPath, number }),
  prList: (repoPath: string) => invoke<PrSummary[]>("pr_list", { repoPath }),
  prDetail: (repoPath: string, number: number) =>
    invoke<PrDetail | null>("pr_detail", { repoPath, number }),
  ghLogin: () => invoke<string | null>("gh_login"),
  ghAvailable: () => invoke<boolean>("gh_available"),
  watchWorktree: (workspaceId: string, path: string) =>
    invoke<void>("watch_worktree", { workspaceId, path }),
  unwatchWorktree: (workspaceId: string) => invoke<void>("unwatch_worktree", { workspaceId }),
  listAgents: () => invoke<AgentDef[]>("list_agents"),
  claudeSessionExists: (id: string) => invoke<boolean>("claude_session_exists", { id }),
  swarmBin: () => invoke<string>("swarm_bin"),
  installAgentHooks: () => invoke<void>("install_agent_hooks"),
  notifyOs: (
    title: string,
    body: string,
    sound: string | undefined,
    paneId: string,
    workspaceId: string,
  ) => invoke<void>("notify_os", { title, body, sound, paneId, workspaceId }),

  ptySpawn: (
    opts: {
      cwd: string;
      command: string;
      args?: string[];
      env?: [string, string][];
      cols: number;
      rows: number;
    },
    onUpdate: (u: WireUpdate) => void,
  ) => {
    // Frames arrive as raw bytes (ArrayBuffer); decode straight into a WireUpdate.
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (raw) => onUpdate(decodeUpdate(raw));
    return invoke<string>("pty_spawn", { opts, onUpdate: channel });
  },
  // Re-bind a still-running PTY to a fresh channel after the pane's component
  // remounts (e.g. switching back to a workspace). The core pushes a full frame.
  ptyAttach: (id: string, onUpdate: (u: WireUpdate) => void) => {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (raw) => onUpdate(decodeUpdate(raw));
    return invoke<void>("pty_attach", { id, onUpdate: channel });
  },
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  // Persist a clipboard image (base64-encoded bytes from the WebKit paste event)
  // to a temp file in the core and return its absolute path, which the caller
  // then pastes into the PTY so a CLI agent can read the image off disk.
  saveClipboardImage: (data: string, ext: string) =>
    invoke<string>("save_clipboard_image", { data, ext }),
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  // Scroll the viewport through scrollback by `delta` lines (>0 = back into
  // history). The core replies with a fresh full frame at the new offset.
  ptyScroll: (id: string, delta: number) => invoke<void>("pty_scroll", { id, delta }),
  // Extract the text between two 0-based viewport cells (resolved through the
  // current scroll offset by the core). Endpoints may be in any drag order.
  ptySelectionText: (id: string, start: [number, number], end: [number, number]) =>
    invoke<string>("pty_selection_text", { id, start, end }),
  agentSessionResume: (paneId: string) =>
    invoke<ResumeCommand | null>("agent_session_resume", { paneId }),
  agentSessionForget: (paneId: string) =>
    invoke<void>("agent_session_forget", { paneId }).catch(() => {}),
  ptySetVisible: (id: string, visible: boolean) => invoke<void>("pty_set_visible", { id, visible }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyAlive: (id: string) => invoke<boolean>("pty_alive", { id }),
};
