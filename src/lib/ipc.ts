import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AgentDef,
  BranchInfo,
  CommitDetail,
  CommitInfo,
  DiffStatsInfo,
  FileChange,
  PrInfo,
  PrSummary,
  RepoInfo,
  WireGrid,
  WorktreeInfo,
} from "./types";

export const api = {
  repoInfo: (path: string) => invoke<RepoInfo>("repo_info", { path }),
  listWorktrees: (path: string) => invoke<WorktreeInfo[]>("list_worktrees", { path }),
  createWorktree: (repoPath: string, branchName: string, baseRef?: string) =>
    invoke<WorktreeInfo>("create_worktree", { repoPath, branchName, baseRef: baseRef ?? null }),
  removeWorktree: (repoPath: string, name: string, force = false) =>
    invoke<void>("remove_worktree", { repoPath, name, force }),
  changes: (worktreePath: string) => invoke<FileChange[]>("changes", { worktreePath }),
  fileDiff: (worktreePath: string, file: string, staged: boolean) =>
    invoke<string>("file_diff", { worktreePath, file, staged }),
  diffStats: (worktreePath: string) => invoke<DiffStatsInfo>("diff_stats", { worktreePath }),
  listBranches: (repoPath: string) => invoke<BranchInfo[]>("list_branches", { repoPath }),
  gitLog: (repoPath: string, limit = 200) =>
    invoke<CommitInfo[]>("git_log", { repoPath, limit }),
  commitDetail: (repoPath: string, oid: string) =>
    invoke<CommitDetail>("commit_detail", { repoPath, oid }),
  commitFileDiff: (repoPath: string, oid: string, file: string) =>
    invoke<string>("commit_file_diff", { repoPath, oid, file }),
  commitDiff: (repoPath: string, oid: string) =>
    invoke<string>("commit_diff", { repoPath, oid }),
  saveSession: (data: string) => invoke<void>("save_session", { data }),
  loadSession: () => invoke<string | null>("load_session"),
  eventsDir: () => invoke<string>("events_dir"),
  prepareCodexHome: () => invoke<string>("prepare_codex_home"),
  commitAll: (worktreePath: string, message: string) =>
    invoke<string>("commit_all", { worktreePath, message }),
  stage: (worktreePath: string, paths: string[]) =>
    invoke<void>("stage", { worktreePath, paths }),
  unstage: (worktreePath: string, paths: string[]) =>
    invoke<void>("unstage", { worktreePath, paths }),
  stageAll: (worktreePath: string) => invoke<void>("stage_all", { worktreePath }),
  unstageAll: (worktreePath: string) => invoke<void>("unstage_all", { worktreePath }),
  commit: (worktreePath: string, message: string) =>
    invoke<string>("commit", { worktreePath, message }),
  prForBranch: (repoPath: string, branch: string) =>
    invoke<PrInfo | null>("pr_for_branch", { repoPath, branch }),
  prList: (repoPath: string) => invoke<PrSummary[]>("pr_list", { repoPath }),
  ghLogin: () => invoke<string | null>("gh_login"),
  ghAvailable: () => invoke<boolean>("gh_available"),
  listAgents: () => invoke<AgentDef[]>("list_agents"),
  claudeSessionExists: (id: string) => invoke<boolean>("claude_session_exists", { id }),

  ptySpawn: (
    opts: {
      cwd: string;
      command: string;
      args?: string[];
      env?: [string, string][];
      cols: number;
      rows: number;
    },
    onGrid: (g: WireGrid) => void,
  ) => {
    const channel = new Channel<WireGrid>();
    channel.onmessage = onGrid;
    return invoke<string>("pty_spawn", { opts, onGrid: channel });
  },
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<WireGrid | null>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyAlive: (id: string) => invoke<boolean>("pty_alive", { id }),
};
