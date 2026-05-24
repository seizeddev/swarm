// SPDX-License-Identifier: GPL-3.0-or-later
export interface RepoInfo {
  path: string;
  name: string;
  headBranch: string | null;
  headShort: string | null;
  isDetached: boolean;
  remoteUrl: string | null;
  dirty: boolean;
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

// Per-file changes + aggregate diff stats, computed in one backend pass.
export interface StatusAndStats {
  changes: FileChange[];
  stats: DiffStatsInfo;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
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

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrDetail {
  body: string;
  additions: number;
  deletions: number;
  files: PrFile[];
}

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  installed: boolean;
  resume: string[];
}

export interface WireRun {
  text: string;
  fg: number;
  bg: number;
  flags: number;
}

export interface WireLine {
  y: number;
  runs: WireRun[];
}

// A streamed terminal frame. `full` replaces every row; `delta` patches only the
// rows in `lines` (the ones the emulator reported as damaged).
export interface WireUpdate {
  kind: "full" | "delta";
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  lines: WireLine[];
}
