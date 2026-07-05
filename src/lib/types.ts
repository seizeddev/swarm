// SPDX-License-Identifier: GPL-3.0-or-later

/// Handle to a live PTY: the stable `id` (used by `pty:exit`/`term:title` event
/// matching) plus the sealed `token` every mutating PTY IPC must present.
/// Minted by `ptySpawn`; rotated by `ptyReattach` after a webview reload.
export interface PtyHandle {
  id: string;
  token: string;
}

export interface RepoInfo {
  path: string;
  name: string;
  headBranch: string | null;
  // false when the opened path is a plain folder with no git repo yet.
  isRepo: boolean;
  // URL of the `origin` remote when one is configured. Drives the PR panel's
  // "no GitHub remote" empty state (distinct from "no open PRs") and the live
  // re-fetch after `gh repo create` adds the remote.
  originUrl: string | null;
  // Set ONLY by the frontend on a restored workspace whose `path` no longer
  // resolves (user renamed, moved, or deleted the folder while swarm was off).
  // Backend `RepoInfo` never carries this — see `repoInfoForRestore`.
  // Drives the sidebar's dimmed "missing" state and the Workspace placeholder
  // (Locate folder… / Forget).
  missing?: boolean;
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
  // True count of changed files before the backend's per-refresh cap
  // (STATUS_FILE_CAP). When `truncated`, `changes` holds only the first N — a
  // huge unignored dir (e.g. node_modules) would otherwise freeze the UI.
  total: number;
  truncated: boolean;
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

// Returned from `file_diff_hunks`: the structured hunks plus a flag set when
// the core stopped at DIFF_LINE_CAP (5_000) content lines and the UI should
// surface a "truncated" banner instead of pretending it has the whole patch.
export interface HunkBundle {
  hunks: DiffHunk[];
  truncated: boolean;
}

// Returned from `commit_diff`: the unified patch text plus the same cap flag.
export interface CommitDiff {
  patch: string;
  truncated: boolean;
}

// One side of `commit_file_blobs`. `base64` is null when data wasn't
// requested (sizes-only call) or the blob exceeds the Rust-side preview cap.
export interface BlobSide {
  size: number;
  base64: string | null;
}

// Returned from `commit_file_blobs`: a side is null when the file doesn't
// exist there (added → no old, deleted → no new).
export interface CommitFileBlobs {
  old: BlobSide | null;
  new: BlobSide | null;
}

export type RefKind = "branch" | "remote" | "tag" | "head";

export interface RefBadge {
  name: string;
  kind: RefKind;
  /** True for the local branch HEAD currently points at — drives the "you are
   * here" emphasis in the History pills. */
  current: boolean;
}

export interface Upstream {
  name: string;
  ahead: number;
  behind: number;
}

export interface CommitInfo {
  oid: string;
  short: string;
  summary: string;
  author: string;
  time: number;
  parents: string[];
  /** Typed refs (local branch, remote-tracking branch, tag) anchored at this
   * commit, ordered: current head → local branches → remote-tracking → tags. */
  refs: RefBadge[];
  isHead: boolean;
  /** Set on the HEAD commit only — `↑a ↓b` next to the HEAD pill. */
  upstream?: Upstream | null;
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
