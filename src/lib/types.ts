export interface RepoInfo {
  path: string;
  name: string;
  headBranch: string | null;
  headShort: string | null;
  isDetached: boolean;
  remoteUrl: string | null;
  dirty: boolean;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null;
  headOid: string | null;
  isMain: boolean;
  isLocked: boolean;
  lockedReason: string | null;
  isPrunable: boolean;
  ahead: number;
  behind: number;
  dirtyCount: number;
}

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "typechange"
  | "conflicted";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface DiffStatsInfo {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  upstream: string | null;
}

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  checks: "passing" | "failing" | "pending" | null;
}

export interface CommitInfo {
  oid: string;
  short: string;
  summary: string;
  author: string;
  time: number;
  parents: string[];
  refs: string[];
  isHead: boolean;
}

export interface CommitFile {
  path: string;
  status: ChangeStatus;
}

export interface CommitDetail {
  oid: string;
  short: string;
  message: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  files: CommitFile[];
}

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: string;
  headRef: string;
  reviewDecision: string | null;
  checks: "passing" | "failing" | "pending" | null;
}

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  accent: string;
  installed: boolean;
  resume: string[];
}

export interface WireRun {
  text: string;
  fg: number;
  bg: number;
  flags: number;
}

export interface WireGrid {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  lines: WireRun[][];
}

export interface AppError {
  kind: string;
  message: string;
}
