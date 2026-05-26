// SPDX-License-Identifier: GPL-3.0-or-later
export interface RepoInfo {
  path: string;
  name: string;
  headBranch: string | null;
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

interface CommitFile {
  path: string;
  status: ChangeStatus;
}

export interface CommitDetail {
  oid: string;
  short: string;
  message: string;
  author: string;
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

interface PrFile {
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

// The native resume command for a pane's captured agent session (see
// src-tauri/agent_session.rs), used on hydrate to bring an agent + its launch
// flags back after a restart.
export interface ResumeCommand {
  agent: string;
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
}

export interface WireRun {
  text: string;
  fg: number;
  bg: number;
  flags: number;
  // OSC 8 hyperlink target for every cell in this run, present only when the
  // run's flags carry the hyperlink bit. A link boundary breaks run coalescing.
  link?: string;
}

export interface WireLine {
  y: number;
  runs: WireRun[];
}

// ── Agent integrations (inspectable/removable hook install) ───────────────────
// One row per agent swarm can wire into a real config (Claude/Gemini/Cursor JSON,
// OpenCode/Amp plugin file). Mirrors agent_hooks.rs::IntegrationStatus.
export interface IntegrationStatus {
  id: string;
  name: string;
  onPath: boolean;
  installed: boolean;
  configPath: string;
  // Plugin agents are a whole-file create/remove, not a JSON merge.
  isPlugin: boolean;
}

// Before/after of an agent's config for the review diff. Mirrors
// agent_hooks.rs::IntegrationPreview.
export interface IntegrationPreview {
  path: string;
  installed: boolean;
  isPlugin: boolean;
  current: string;
  applied: string;
  removed: string;
}

// A streamed terminal frame (wire v2). `full` replaces every row; `delta` patches
// only the rows in `lines` (the ones the emulator reported as damaged).
export interface WireUpdate {
  kind: "full" | "delta";
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  // Filtered TermMode bits (see lib/term/mode.ts) — drives key/mouse encoding and
  // the wheel behaviour without a round-trip to the core.
  mode: number;
  // Rows the viewport is scrolled back from the live tail (0 = bottom).
  displayOffset: number;
  // Scrollback depth above the screen, for the scrollbar overlay.
  history: number;
  lines: WireLine[];
}
