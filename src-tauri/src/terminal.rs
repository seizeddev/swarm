// SPDX-License-Identifier: GPL-3.0-or-later
//! Terminal core: real VT emulation via the Alacritty engine, one `Term` per
//! session. PTY bytes are parsed in Rust; the frontend only paints the cell
//! grid we stream over a Tauri `Channel` — no xterm.js, no TUI scraping.

use crate::error::{AppError, AppResult};
use crate::osc::{parse_notifications, NotifState};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid, Scroll};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{viewport_to_point, Config, Term, TermDamage};
use alacritty_terminal::vte::ansi::{Color, CursorShape, Processor, StdSyncHandler};
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

/// Grid frames travel as raw bytes (`InvokeResponseBody::Raw`), not JSON — see
/// `encode` for the layout. A `Serialize` channel would emit a number array.
pub type UpdateChannel = Channel<InvokeResponseBody>;

const FG: i32 = 256; // NamedColor::Foreground
const BG: i32 = 257; // NamedColor::Background
const RGB_FLAG: i32 = 0x0100_0000;

/// Max concurrent PTY sessions (see `spawn`). A generous ceiling, not a UX limit.
const MAX_SESSIONS: usize = 64;
/// Bounded reader→render queue depth: ~256 × 8 KiB ≈ 2 MB of backpressure.
const CHUNK_QUEUE_CAP: usize = 256;
/// Minimum wall-clock gap between two frames pushed to the webview (~60 fps).
///
/// Every `chan.send` lands as a `webview.eval` on the WKWebView **main thread**
/// (the same thread that paints the UI and handles input — see Tauri's
/// `ipc/channel.rs`). A chatty TUI (token-by-token agent streaming, spinners,
/// box redraws) otherwise emits one frame per PTY read burst — hundreds per
/// second — saturating the main thread and freezing the UI for as long as the
/// backlog takes to drain. Pacing emission to a frame budget caps that to ~60
/// evals/sec, coalesces a burst into one repaint, and — by sleeping *between*
/// frames — yields the main thread time to paint and process input instead of
/// swallowing a contiguous backlog. The first frame after idle is never delayed
/// (the elapsed gap already exceeds the budget); only sustained output is paced.
const FRAME_BUDGET: std::time::Duration = std::time::Duration::from_millis(16);

/// Scrollback ceiling per pane. Alacritty's library default is 10_000 lines
/// (verified in `alacritty_terminal::term::Config::default`); at ~80 cols ×
/// ~16 bytes/cell that's ~12 MB of grid backing per PTY even when hidden —
/// and we routinely keep many panes live across workspaces. 2_000 lines is
/// in line with xterm/iTerm defaults and is plenty for interactive sessions;
/// long-history viewing happens in commit/PR views, not the live shell.
const SCROLLBACK_HISTORY: usize = 2_000;

/// One source of truth for Alacritty `Config` across every `Term::new` site.
/// Capped scrollback (see [`SCROLLBACK_HISTORY`]) is the only knob we change.
fn term_config() -> Config {
    Config {
        scrolling_history: SCROLLBACK_HISTORY,
        ..Default::default()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Environment variables the renderer is allowed to pass through to a PTY
/// spawn. Everything else — `PATH`, `LD_PRELOAD`, `ZDOTDIR`, `BASH_ENV`,
/// locale — is silently dropped. The login-shell wrapper (`$SHELL -ilc`) we
/// route every agent through sources the user's shell profile anyway, so the
/// user's *real* PATH/LANG enter the child via the legitimate path. Letting
/// the renderer override them would let a subverted webview swap a binary out
/// from under us before the shell even starts.
pub(crate) const ENV_ALLOW: &[&str] = &[
    // The pane id stamped on every PTY, used by agent hooks to key session captures.
    "SWARM_PANE_ID",
    // Per-pane event file the cross-platform notify helper appends to.
    "SWARM_EVENT_FILE",
    // JSON-encoded argv we hand the agent, so a value with spaces survives intact.
    "SWARM_AGENT_ARGV_JSON",
    // Codex's isolated config home (set by `prepare_codex_home`).
    "CODEX_HOME",
    // Claude Code reads this from the env to enable the full-height alt screen.
    // The user already sets it in `~/.zshrc`; we re-assert from the frontend so
    // packaged `.app` launches (minimal launchd env, before the shell sources
    // anything) still get the right rendering.
    "CLAUDE_CODE_NO_FLICKER",
];

/// Filter `opts.env` to keys in [`ENV_ALLOW`]. Extracted so the gate is unit-
/// testable without spawning a real PTY: a regression here is invisible at the
/// process level (the unfiltered values just override good defaults).
pub(crate) fn filter_env(opts: &SpawnOpts) -> Vec<(String, String)> {
    opts.env
        .iter()
        .filter(|(k, _)| ENV_ALLOW.contains(&k.as_str()))
        .cloned()
        .collect()
}

/// Wire flag bit set on a run that carries an OSC 8 hyperlink target (its `link`
/// is `Some`). Bits 0..=6 mirror the cell attributes packed by `wflags`; bit 7 is
/// ours, signalling the decoder to read a trailing length-prefixed URI.
const WF_HYPERLINK: u16 = 1 << 7;

#[derive(Clone, Debug, Serialize)]
pub struct WireRun {
    pub text: String,
    pub fg: i32,
    pub bg: i32,
    pub flags: u16,
    /// OSC 8 hyperlink target for every cell in this run, or `None`. Part of the
    /// run identity, so a link boundary breaks coalescing just like a style change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// One painted grid row: its viewport index `y` and the coalesced style runs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireLine {
    pub y: usize,
    pub runs: Vec<WireRun>,
}

/// A frame streamed to the frontend. `kind` is `"full"` (replace every row) or
/// `"delta"` (patch only the listed `lines`). Deltas carry just the rows the
/// emulator reported as damaged, so a flooding stream costs one row, not a grid.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireUpdate {
    pub kind: &'static str,
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: i32,
    pub cursor_visible: bool,
    /// Filtered `TermMode` bits (the emulator's current input/scroll modes), so the
    /// frontend can encode keys/mouse and pick a wheel behaviour without a round-trip.
    pub mode: u32,
    /// Rows the viewport is scrolled back from the bottom (0 = live tail).
    pub display_offset: usize,
    /// Scrollback depth above the screen (`history_size`), for the scrollbar overlay.
    pub history: usize,
    pub lines: Vec<WireLine>,
}

#[derive(Clone)]
struct Proxy {
    tx: Sender<Vec<u8>>,
    app: AppHandle,
    id: String,
}

impl EventListener for Proxy {
    fn send_event(&self, event: Event) {
        match event {
            // Reply to device queries (cursor reports etc.) so agents render correctly.
            Event::PtyWrite(text) => {
                let _ = self.tx.send(text.into_bytes());
            }
            // NB: we deliberately do NOT treat the bell as attention — agents ring
            // it on startup/completion noise. Attention comes from agent Stop hooks
            // (see hooks watcher) and explicit OSC 9/99/777 notifications only.
            Event::Title(title) => {
                let _ = self.app.emit(
                    "term:title",
                    serde_json::json!({ "id": self.id, "title": title }),
                );
            }
            // OSC 52 copy: a program in the terminal asked to set the system
            // clipboard. Forward the payload to the frontend, which writes it via
            // the WebView clipboard API. (The `osc52` config defaults to `OnlyCopy`,
            // so the reverse — `ClipboardLoad`, a program *reading* your clipboard —
            // is intentionally never emitted: that path is clipboard exfiltration
            // and stays disabled, mirroring the deliberately-inert bell above.)
            Event::ClipboardStore(_, text) => {
                let _ = self.app.emit(
                    "term:clipboard",
                    serde_json::json!({ "id": self.id, "text": text }),
                );
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy)]
struct TermSize {
    cols: usize,
    lines: usize,
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

struct Session {
    term: Arc<Mutex<Term<Proxy>>>,
    input_tx: Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    size: Arc<Mutex<TermSize>>,
    /// Per-PTY sealed token. Every mutating PTY IPC (`write`, `resize`, …) has
    /// to present this token byte-for-byte (constant-time compared in
    /// `check_token`) or the call is rejected. Rotated on `reattach`, so a
    /// webview reload invalidates the old token in the pre-reload page. The
    /// token NEVER leaks back into `live_panes` — only `spawn`/`reattach` hand
    /// it out, so a script that gains read-only access to the live-list can
    /// still not write into someone else's PTY.
    token: String,
    /// When false, the render thread keeps parsing (state stays correct) but skips
    /// snapshotting and sending — a hidden pane costs no IPC or serialization.
    visible: Arc<AtomicBool>,
    /// The current frontend channel, shared with the render thread and swappable:
    /// when a pane's component unmounts and later remounts (e.g. switching back to
    /// a workspace) it re-`attach`es a fresh channel here while the PTY lives on.
    chan: Arc<Mutex<UpdateChannel>>,
    /// The stable frontend pane id (`SWARM_PANE_ID`) this PTY backs, if known. A
    /// webview *reload* (WebContent OOM → Tauri auto-reload) keeps this Rust process
    /// — and so every PTY — alive while it wipes the frontend. Tracking the pane id
    /// lets the reloaded frontend **reattach** to the live PTY (via `live_panes`)
    /// instead of re-spawning and orphaning it, and enforces one live PTY per pane.
    pane_id: Option<String>,
}

/// The PTY id and its freshly minted sealed token. Returned from `spawn` and
/// `reattach`; every mutating PTY op needs both halves to call back.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub id: String,
    pub token: String,
}

/// Constant-time equality check on a sealed token. A `String` `==` would let a
/// hostile webview learn the token byte-by-byte from timing differences. The
/// length pre-check is what keeps that property — `ct_eq` requires equal-length
/// slices, so without the gate the operator would short-circuit on a length
/// mismatch and leak the length.
pub(crate) fn token_matches(expected: &str, supplied: &str) -> bool {
    use subtle::ConstantTimeEq;
    let a = expected.as_bytes();
    let b = supplied.as_bytes();
    a.len() == b.len() && a.ct_eq(b).unwrap_u8() == 1
}

fn check_token(s: &Session, supplied: &str) -> AppResult<()> {
    if token_matches(&s.token, supplied) {
        Ok(())
    } else {
        Err(AppError::Invalid("invalid pty token".into()))
    }
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

fn enc(color: Color) -> i32 {
    match color {
        Color::Named(n) => n as i32,
        Color::Indexed(i) => i as i32,
        Color::Spec(rgb) => {
            RGB_FLAG | ((rgb.r as i32) << 16) | ((rgb.g as i32) << 8) | rgb.b as i32
        }
    }
}

fn wflags(f: Flags) -> u16 {
    let mut out = 0u16;
    if f.contains(Flags::BOLD) {
        out |= 1;
    }
    if f.contains(Flags::ITALIC) {
        out |= 1 << 1;
    }
    if f.intersects(Flags::ALL_UNDERLINES) {
        out |= 1 << 2;
    }
    if f.contains(Flags::INVERSE) {
        out |= 1 << 3;
    }
    if f.contains(Flags::DIM) {
        out |= 1 << 4;
    }
    if f.contains(Flags::STRIKEOUT) {
        out |= 1 << 5;
    }
    if f.contains(Flags::HIDDEN) {
        out |= 1 << 6;
    }
    out
}

/// Coalesce one viewport row (`vy`, 0 = top) into same-style runs by indexing the
/// grid directly — no full-grid matrix allocation. `off` is the display offset, so
/// the active grid line is `vy - off` (matches `viewport_to_point`).
fn line_runs(grid: &Grid<Cell>, vy: usize, cols: usize, off: i32) -> Vec<WireRun> {
    let row = &grid[Line(vy as i32 - off)];
    let mut runs: Vec<WireRun> = Vec::new();
    for col in 0..cols {
        let cell = &row[Column(col)];
        // The trailing half of a wide char carries no glyph; render it as a blank
        // so column alignment is preserved (mirrors the old full-grid behaviour).
        let (ch, fg, bg, mut fl, link) = if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            (' ', FG, BG, 0u16, None)
        } else {
            let ch = if cell.c == '\0' { ' ' } else { cell.c };
            let link = cell.hyperlink().map(|h| h.uri().to_string());
            (ch, enc(cell.fg), enc(cell.bg), wflags(cell.flags), link)
        };
        if link.is_some() {
            fl |= WF_HYPERLINK;
        }
        match runs.last_mut() {
            Some(r) if r.fg == fg && r.bg == bg && r.flags == fl && r.link == link => {
                r.text.push(ch)
            }
            _ => runs.push(WireRun {
                text: ch.to_string(),
                fg,
                bg,
                flags: fl,
                link,
            }),
        }
    }
    runs
}

/// Build a wire frame from the live grid for the given viewport rows. Dimensions
/// and cursor come straight from the emulator, so the frame is always self-
/// consistent even mid-resize. Used for both full snapshots and damage deltas.
fn build_update<T: EventListener>(
    kind: &'static str,
    term: &Term<T>,
    rows_iter: impl Iterator<Item = usize>,
) -> WireUpdate {
    let mode = term.mode().bits();
    let grid = term.grid();
    let cols = grid.columns().max(1);
    let rows = grid.screen_lines().max(1);
    let off = grid.display_offset();
    let history = grid.history_size();
    let cursor = term.renderable_content().cursor;
    let mut lines = Vec::new();
    for vy in rows_iter {
        if vy >= rows {
            continue;
        }
        lines.push(WireLine {
            y: vy,
            runs: line_runs(grid, vy, cols, off as i32),
        });
    }
    WireUpdate {
        kind,
        cols,
        rows,
        cursor_x: cursor.point.column.0,
        cursor_y: cursor.point.line.0 + off as i32,
        cursor_visible: !matches!(cursor.shape, CursorShape::Hidden),
        mode,
        display_offset: off,
        history,
        lines,
    }
}

/// A full snapshot of every viewport row (`kind: "full"`).
fn snapshot_full<T: EventListener>(term: &Term<T>) -> WireUpdate {
    let rows = term.grid().screen_lines().max(1);
    build_update("full", term, 0..rows)
}

/// Wire-format version. Bump in lock-step with `decodeUpdate` in `lib/term/grid.ts`
/// whenever the byte layout below changes; the decoder rejects a mismatched byte.
const WIRE_VERSION: u8 = 2;

/// Pack a frame into a compact little-endian byte layout (decoded into typed
/// arrays in `lib/term/grid.ts`), bypassing JSON. Header is 30 bytes:
///   u8 version · u8 kind(0=full,1=delta) · u8 cursorVisible · u8 _reserved ·
///   u16 cols · u16 rows · u16 cursorX · i32 cursorY ·
///   u32 mode · u32 displayOffset · u32 history · u32 lineCount
/// then each line: u16 y · u16 runCount, then each run:
///   i32 fg · i32 bg · u16 flags · u16 textLen · textLen UTF-8 bytes,
///   and — only when flags has bit 7 (WF_HYPERLINK) — u16 linkLen · linkLen bytes.
fn encode(u: &WireUpdate) -> Vec<u8> {
    // Pre-size the buffer for the actual payload, not just the line headers.
    // 30-byte header + per-line `u16 y + u16 runCount` (4) + per-run
    // `i32 fg + i32 bg + u16 flags + u16 textLen` (12) + textLen bytes +
    // (when the run carries a hyperlink) `u16 linkLen + link bytes` (2 +
    // link.len()). This kills the doubling realloc storm the old
    // `u.lines.len() * 8` hint left for grids with styled full rows.
    let payload: usize = u
        .lines
        .iter()
        .map(|l| {
            4 + l
                .runs
                .iter()
                .map(|r| 12 + r.text.len() + r.link.as_deref().map_or(0, |s| 2 + s.len()))
                .sum::<usize>()
        })
        .sum();
    let mut b = Vec::with_capacity(30 + payload);
    b.push(WIRE_VERSION);
    b.push(if u.kind == "delta" { 1 } else { 0 });
    b.push(u.cursor_visible as u8);
    b.push(0); // reserved (keeps the 16-bit fields 2-byte aligned)
    b.extend_from_slice(&(u.cols as u16).to_le_bytes());
    b.extend_from_slice(&(u.rows as u16).to_le_bytes());
    b.extend_from_slice(&(u.cursor_x as u16).to_le_bytes());
    b.extend_from_slice(&u.cursor_y.to_le_bytes());
    b.extend_from_slice(&u.mode.to_le_bytes());
    b.extend_from_slice(&(u.display_offset as u32).to_le_bytes());
    b.extend_from_slice(&(u.history as u32).to_le_bytes());
    b.extend_from_slice(&(u.lines.len() as u32).to_le_bytes());
    for line in &u.lines {
        b.extend_from_slice(&(line.y as u16).to_le_bytes());
        b.extend_from_slice(&(line.runs.len() as u16).to_le_bytes());
        for r in &line.runs {
            b.extend_from_slice(&r.fg.to_le_bytes());
            b.extend_from_slice(&r.bg.to_le_bytes());
            b.extend_from_slice(&r.flags.to_le_bytes());
            let text = r.text.as_bytes();
            b.extend_from_slice(&(text.len() as u16).to_le_bytes());
            b.extend_from_slice(text);
            if r.flags & WF_HYPERLINK != 0 {
                let link = r.link.as_deref().unwrap_or("").as_bytes();
                b.extend_from_slice(&(link.len() as u16).to_le_bytes());
                b.extend_from_slice(link);
            }
        }
    }
    b
}

/// Encode a frame as a raw IPC body (binary, never JSON).
fn frame(u: &WireUpdate) -> InvokeResponseBody {
    InvokeResponseBody::Raw(encode(u))
}

/// Build the `CommandBuilder` for a spawn, platform-specifically.
///
/// On Unix we route the agent through the user's interactive login shell, exactly
/// as a real terminal emulator does, so it inherits the user's full environment:
/// PATH, LANG, and personal settings such as CLAUDE_CODE_NO_FLICKER (which controls
/// whether Claude Code uses the full-height alternate screen vs an inline render).
/// A GUI / .dmg launch only carries a minimal launchd environment — without sourcing
/// the login profile the agent rendered in the degraded inline mode, so the terminal
/// looked "cut off" at the bottom in packaged builds but not from a shell/`tauri dev`
/// launch. `exec "$0" "$@"` replaces the shell in place (no extra process, same PTY)
/// and passes argv through verbatim without re-quoting.
///
/// A plain "shell" pane is the exception: there is no agent to exec, so we launch the
/// user's login shell *directly* as an interactive login shell (`-il`), exactly as
/// Terminal.app does — sourcing `.zprofile`/`.zshrc` and dropping the user at their
/// real prompt. We deliberately resolve `$SHELL` (`agents::default_shell`) instead of
/// `/bin/bash`: macOS ships the frozen GPLv2 bash 3.2, so spawning `bash` greeted the
/// user with "The default interactive shell is now zsh" instead of their actual zsh.
/// Routing a bare shell through the `exec "$0" "$@"` wrapper would also nest a second
/// shell. This branch additionally heals older persisted panes that stored `bash`.
///
/// On Windows there is no login-shell convention to source: a GUI process already
/// inherits the user's full environment, and `cmd.exe`/PowerShell have no portable
/// `-ilc exec` equivalent. So we spawn the command directly; a "shell" pane resolves
/// to PowerShell via the frontend's pane defaults.
#[cfg(unix)]
fn build_command(opts: &SpawnOpts) -> CommandBuilder {
    let shell = crate::agents::default_shell();
    // Bare shell pane (no agent sub-command): launch the user's real login shell.
    if opts.args.is_empty() && is_login_shell_command(&opts.command) {
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-il");
        return cmd;
    }
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-ilc");
    cmd.arg("exec \"$0\" \"$@\"");
    cmd.arg(&opts.command);
    for a in &opts.args {
        cmd.arg(a);
    }
    cmd
}

/// True if `command` names an interactive shell (so a pane running it with no args is
/// a "shell" pane to launch as a login shell, not an agent to wrap in `exec`). Matches
/// on the basename so both `zsh` and `/bin/zsh` qualify; no real agent is named like a
/// shell, so this never misclassifies claude/codex/etc.
#[cfg(unix)]
fn is_login_shell_command(command: &str) -> bool {
    let name = std::path::Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);
    matches!(
        name,
        "sh" | "bash" | "zsh" | "fish" | "dash" | "ksh" | "tcsh" | "csh" | "nu"
    )
}

#[cfg(windows)]
fn build_command(opts: &SpawnOpts) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&opts.command);
    for a in &opts.args {
        cmd.arg(a);
    }
    cmd
}

/// True if `command` is a launch swarm is willing to spawn through a PTY: the
/// basename matches either the user's interactive login shell (`$SHELL`) or one
/// of the CLI agents in the registry. Anything else (`/usr/bin/curl`, a path
/// dropped on the renderer) is rejected before we hand it to `CommandBuilder`.
///
/// We compare on the basename so both `claude` and `/usr/local/bin/claude` pass,
/// and an empty string never does. Combined with the strict env allowlist in
/// `spawn`, this closes the renderer → arbitrary local process gap.
pub(crate) fn is_allowed_command(cmd: &str) -> bool {
    let base = std::path::Path::new(cmd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(cmd);
    if base.is_empty() {
        return false;
    }
    let shell = crate::agents::default_shell();
    let shell_base = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&shell);
    if base == shell_base {
        return true;
    }
    crate::agents::REGISTRY
        .iter()
        .any(|r| !r.command.is_empty() && r.command == base)
}

impl TerminalManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        opts: SpawnOpts,
        on_update: UpdateChannel,
    ) -> AppResult<SpawnResult> {
        // The frontend stamps every PTY with its stable pane id; reading it back
        // lets us tie this session to a pane (see `Session::pane_id`).
        let pane_id = opts
            .env
            .iter()
            .find(|(k, _)| k == "SWARM_PANE_ID")
            .map(|(_, v)| v.clone());

        // One live PTY per pane. A webview reload re-spawns this pane while the
        // pre-reload PTY is still running in this (surviving) process; without this
        // its render thread would keep eval'ing frames into the new WebContent
        // forever — a ~MB/s leak that re-triggers the WebContent OOM that caused the
        // reload in the first place. Drop any prior session for this pane first.
        if let Some(pid) = pane_id.as_deref() {
            let stale: Vec<String> = {
                let guard = self.sessions.lock();
                guard
                    .iter()
                    .filter(|(_, s)| s.pane_id.as_deref() == Some(pid))
                    .map(|(k, _)| k.clone())
                    .collect()
            };
            for k in stale {
                if let Some(mut s) = self.sessions.lock().remove(&k) {
                    let _ = s.child.kill();
                }
            }
        }

        // Cap concurrent sessions: each PTY holds three OS threads and an emulator,
        // so an unbounded spawn loop (buggy or hostile frontend) could exhaust file
        // descriptors / memory. 64 is far beyond any real pane count.
        if self.sessions.lock().len() >= MAX_SESSIONS {
            return Err(AppError::Pty(format!(
                "terminal session limit reached ({MAX_SESSIONS})"
            )));
        }

        let cols = opts.cols.max(1);
        let rows = opts.rows.max(1);
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let mut cmd = build_command(&opts);
        cmd.cwd(&opts.cwd);
        // Strict env allowlist: anything the renderer hands us that isn't in
        // ENV_ALLOW is dropped. The login-shell wrapper sources the user's
        // shell profile, so PATH/LANG/etc still reach the child through the
        // legitimate path — but `LD_PRELOAD`/`ZDOTDIR`/`BASH_ENV` from the
        // renderer can't reach the wrapper at all.
        for (k, v) in &filter_env(&opts) {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(e.to_string()))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(e.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        let size = Arc::new(Mutex::new(TermSize {
            cols: cols as usize,
            lines: rows as usize,
        }));
        let proxy = Proxy {
            tx: input_tx.clone(),
            app: app.clone(),
            id: id.clone(),
        };
        let term = Arc::new(Mutex::new(Term::new(
            term_config(),
            &TermSize {
                cols: cols as usize,
                lines: rows as usize,
            },
            proxy,
        )));
        let visible = Arc::new(AtomicBool::new(true));
        let chan = Arc::new(Mutex::new(on_update));
        // Mint the sealed token here, while the session is still being assembled
        // — every mutating IPC will compare against this token byte-for-byte.
        let token = uuid::Uuid::new_v4().to_string();

        self.sessions.lock().insert(
            id.clone(),
            Session {
                term: term.clone(),
                input_tx,
                master: pair.master,
                child,
                size: size.clone(),
                token: token.clone(),
                visible: visible.clone(),
                chan: chan.clone(),
                pane_id,
            },
        );

        // Reader thread: pure blocking I/O. It only drains the PTY into a queue —
        // no parsing, no locking the emulator — so read latency never waits on a
        // render. On EOF it reaps the child and announces the exit.
        //
        // Bounded (sync) channel: under flooding output (`yes`, a huge build log)
        // the render thread can fall behind. A bounded queue (~2 MB of 8 KiB
        // chunks) makes the reader block instead of buffering without limit —
        // the block propagates as OS PTY backpressure, capping memory.
        let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<u8>>(CHUNK_QUEUE_CAP);
        let sessions = self.sessions.clone();
        let reader_app = app.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
            let code = sessions
                .lock()
                .get_mut(&reader_id)
                .and_then(|s| s.child.wait().ok())
                .map(|st| st.exit_code());
            sessions.lock().remove(&reader_id);
            let _ = reader_app.emit(
                "pty:exit",
                serde_json::json!({ "id": reader_id, "code": code }),
            );
        });

        // Render thread: coalesces a burst of chunks into one frame. It blocks for
        // the first chunk, then drains everything already queued, advances the
        // parser over all of them, and snapshots *once* — so a token-by-token
        // stream collapses into a single repaint per frame.
        let render_id = id.clone();
        std::thread::spawn(move || {
            let mut parser = Processor::<StdSyncHandler>::new();
            let mut notif = NotifState::default();
            let mut last_body = String::new();
            let mut last_at: Option<std::time::Instant> = None;
            // Wall-clock time of the last frame pushed to the webview, for pacing.
            let mut last_frame: Option<std::time::Instant> = None;
            // `recv` blocks for the first chunk; `Err` means the reader (and so the
            // PTY) is gone, ending the loop.
            while let Ok(first) = chunk_rx.recv() {
                let mut chunks = vec![first];
                // Frame pacing: if we pushed a frame less than a budget ago, sleep
                // out the remainder before draining. This both throttles webview
                // evals to ~60 fps and lets more chunks pile into the queue, so a
                // burst coalesces into a single repaint (see FRAME_BUDGET). We sleep
                // *before* locking `term`, so resize/scroll/copy stay responsive.
                if let Some(prev) = last_frame {
                    let since = prev.elapsed();
                    if since < FRAME_BUDGET {
                        std::thread::sleep(FRAME_BUDGET - since);
                    }
                }
                while let Ok(c) = chunk_rx.try_recv() {
                    chunks.push(c);
                }

                let mut notifs: Vec<(String, String)> = Vec::new();
                let is_visible = visible.load(Ordering::Acquire);
                let update = {
                    let mut t = term.lock();
                    for c in &chunks {
                        notifs.extend(parse_notifications(c, &mut notif));
                        parser.advance(&mut *t, c);
                    }
                    if !is_visible {
                        // Keep state correct but pay nothing: drop accumulated damage
                        // (a full frame is sent when the pane is shown again).
                        let _ = t.damage();
                        t.reset_damage();
                        None
                    } else {
                        let rows = t.grid().screen_lines().max(1);
                        let (full, idx): (bool, Vec<usize>) = match t.damage() {
                            TermDamage::Full => (true, Vec::new()),
                            TermDamage::Partial(it) => {
                                (false, it.map(|d| d.line).filter(|&y| y < rows).collect())
                            }
                        };
                        t.reset_damage();
                        Some(if full {
                            build_update("full", &t, 0..rows)
                        } else {
                            build_update("delta", &t, idx.into_iter())
                        })
                    }
                };

                for (title, body) in notifs {
                    // Dedup identical content within a 1s window.
                    let now = std::time::Instant::now();
                    if body == last_body
                        && last_at.is_some_and(|t| now.duration_since(t).as_millis() < 1000)
                    {
                        continue;
                    }
                    last_body = body.clone();
                    last_at = Some(now);
                    // `source` flags the untrusted origin: this text came from a
                    // PTY's OSC sequence (any program in the terminal can emit it),
                    // so the UI labels it and never treats the body as actionable.
                    let _ = app.emit(
                        "term:notify",
                        serde_json::json!({ "id": render_id, "title": title, "body": body, "source": "terminal" }),
                    );
                    let _ = app.emit("term:attention", serde_json::json!({ "id": render_id }));
                }

                if let Some(update) = update {
                    // Ignore send errors: a detached (unmounted) channel just means
                    // the pane is hidden; the loop ends only when the PTY closes.
                    let _ = chan.lock().send(frame(&update));
                    last_frame = Some(std::time::Instant::now());
                }
            }
        });

        Ok(SpawnResult { id, token })
    }

    pub fn write(&self, id: &str, token: &str, data: &str) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("terminal '{id}' not found")))?;
        check_token(session, token)?;
        session
            .input_tx
            .send(data.as_bytes().to_vec())
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn resize(&self, id: &str, token: &str, cols: u16, rows: u16) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = match guard.get(id) {
            Some(s) => s,
            None => return Ok(()),
        };
        check_token(session, token)?;
        let new = TermSize {
            cols: cols.max(1) as usize,
            lines: rows.max(1) as usize,
        };
        #[cfg(target_os = "macos")]
        let old_lines = session.size.lock().lines;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))?;
        *session.size.lock() = new;
        // `resize` marks the emulator fully damaged; push a fresh full frame so an
        // idle terminal repaints at the new geometry without waiting for output.
        let update = {
            let mut t = session.term.lock();
            t.resize(new);
            let upd = snapshot_full(&t);
            t.reset_damage();
            upd
        };
        if session.visible.load(Ordering::Acquire) {
            let _ = session.chan.lock().send(frame(&update));
        }

        // Grow nudge: some TUIs (notably Claude Code / Ink on macOS) intermittently
        // read a *stale* winsize on the SIGWINCH from a grow and redraw at the old,
        // smaller height — leaving dead space below until the next event (a keystroke
        // forces a fresh read). macOS only raises SIGWINCH on an actual size change,
        // so a single change the app misreads strands it. After a grow we therefore
        // re-assert the height with a brief 1-row toggle, off-thread, to deliver a
        // second SIGWINCH the app re-reads from. This is PTY-only — the emulator grid
        // stays at the real size, so our own rendering is never disturbed. macOS-only:
        // it's a workaround for that platform's SIGWINCH coalescing (Linux/Windows
        // ConPTY don't exhibit it, and an extra resize there only causes flicker).
        #[cfg(target_os = "macos")]
        if new.lines > old_lines {
            let sessions = self.sessions.clone();
            let id = id.to_string();
            let cols = cols.max(1);
            let rows = rows.max(1);
            let smaller = rows.saturating_sub(1).max(1);
            std::thread::spawn(move || {
                let win = |r: u16| PtySize {
                    rows: r,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                };
                std::thread::sleep(std::time::Duration::from_millis(60));
                if let Some(s) = sessions.lock().get(&id) {
                    let _ = s.master.resize(win(smaller));
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
                if let Some(s) = sessions.lock().get(&id) {
                    let _ = s.master.resize(win(rows));
                }
            });
        }
        Ok(())
    }

    /// Scroll the viewport through the scrollback by `delta` lines (positive = back
    /// into history, negative = toward the live tail), then push a fresh full frame
    /// so the new viewport paints immediately. A no-op for an unknown id.
    pub fn scroll(&self, id: &str, token: &str, delta: i32) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = match guard.get(id) {
            Some(s) => s,
            None => return Ok(()),
        };
        check_token(session, token)?;
        let update = {
            let mut t = session.term.lock();
            t.scroll_display(Scroll::Delta(delta));
            let upd = snapshot_full(&t);
            t.reset_damage();
            upd
        };
        if session.visible.load(Ordering::Acquire) {
            let _ = session.chan.lock().send(frame(&update));
        }
        Ok(())
    }

    /// Extract the text between two *viewport* cell coordinates (0-based `(line,
    /// col)`), resolving through the current scrollback offset so a selection over
    /// scrolled-back rows reads the real history. Endpoints are ordered here, so the
    /// frontend may pass them in either drag direction. `bounds_to_string` handles
    /// wrapped lines and trailing-blank trimming the way a terminal copy should.
    pub fn selection_text(
        &self,
        id: &str,
        token: &str,
        start: (usize, usize),
        end: (usize, usize),
    ) -> AppResult<String> {
        let guard = self.sessions.lock();
        let session = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("terminal '{id}' not found")))?;
        check_token(session, token)?;
        let t = session.term.lock();
        let off = t.grid().display_offset();
        let a = viewport_to_point(off, Point::new(start.0, Column(start.1)));
        let b = viewport_to_point(off, Point::new(end.0, Column(end.1)));
        let (s, e) = if a <= b { (a, b) } else { (b, a) };
        Ok(t.bounds_to_string(s, e))
    }

    /// Mark a pane visible or hidden. Going visible pushes one full frame (so the
    /// pane repaints immediately after a tab switch) and clears stale damage;
    /// going hidden just flips the flag — the render thread stops sending.
    pub fn set_visible(&self, id: &str, token: &str, visible: bool) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = match guard.get(id) {
            Some(s) => s,
            None => return Ok(()),
        };
        check_token(session, token)?;
        let was = session.visible.swap(visible, Ordering::AcqRel);
        if visible && !was {
            let update = {
                let mut t = session.term.lock();
                let upd = snapshot_full(&t);
                t.reset_damage();
                upd
            };
            let _ = session.chan.lock().send(frame(&update));
        }
        Ok(())
    }

    /// Re-bind a live session to a fresh frontend channel — used when a pane's
    /// component remounts in the same page (the PTY kept running while it was
    /// unmounted). Cross-page (post-reload) reattach takes the separate
    /// `reattach` path so the token can rotate.
    pub fn attach(&self, id: &str, token: &str, on_update: UpdateChannel) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("terminal '{id}' not found")))?;
        check_token(session, token)?;
        *session.chan.lock() = on_update;
        session.visible.store(true, Ordering::Release);
        let update = {
            let mut t = session.term.lock();
            let upd = snapshot_full(&t);
            t.reset_damage();
            upd
        };
        let _ = session.chan.lock().send(frame(&update));
        Ok(())
    }

    /// Cross-page reattach: a post-reload webview re-binds to the PTY whose
    /// `pane_id` matches `pane_id`, **rotates** the sealed token (so the
    /// pre-reload page's token can no longer write), and pushes a full frame.
    /// Returns the fresh `(id, token)`; `NotFound` when no live PTY backs that
    /// pane (the caller then spawns from scratch).
    pub fn reattach(&self, pane_id: &str, on_update: UpdateChannel) -> AppResult<SpawnResult> {
        let mut guard = self.sessions.lock();
        // Find the live session for this pane (there can only be one — `spawn`
        // reaps a stale pane match before inserting).
        let id = match guard
            .iter()
            .find(|(_, s)| s.pane_id.as_deref() == Some(pane_id))
            .map(|(k, _)| k.clone())
        {
            Some(id) => id,
            None => {
                return Err(AppError::NotFound(format!(
                    "no live pty for pane '{pane_id}'"
                )))
            }
        };
        let new_token = uuid::Uuid::new_v4().to_string();
        let Some(session) = guard.get_mut(&id) else {
            // The HashMap entry was just found under this same lock; this branch
            // is unreachable but encodes the invariant rather than panicking.
            return Err(AppError::NotFound(format!(
                "no live pty for pane '{pane_id}'"
            )));
        };
        session.token = new_token.clone();
        *session.chan.lock() = on_update;
        session.visible.store(true, Ordering::Release);
        let update = {
            let mut t = session.term.lock();
            let upd = snapshot_full(&t);
            t.reset_damage();
            upd
        };
        let _ = session.chan.lock().send(frame(&update));
        Ok(SpawnResult {
            id,
            token: new_token,
        })
    }

    pub fn kill(&self, id: &str, token: &str) -> AppResult<()> {
        let mut guard = self.sessions.lock();
        if let Some(s) = guard.get(id) {
            check_token(s, token)?;
        } else {
            return Ok(());
        }
        if let Some(mut session) = guard.remove(id) {
            let _ = session.child.kill();
        }
        Ok(())
    }

    pub fn alive(&self, id: &str) -> bool {
        self.sessions.lock().contains_key(id)
    }

    /// `(pane_id, pty_id)` for every live session that carries a pane id. The
    /// frontend calls this on hydrate: a pane whose id appears here has a PTY that
    /// outlived a webview reload, so it reattaches instead of re-spawning.
    pub fn live_panes(&self) -> Vec<(String, String)> {
        self.sessions
            .lock()
            .iter()
            .filter_map(|(id, s)| s.pane_id.clone().map(|p| (p, id.clone())))
            .collect()
    }

    /// Kill every live session whose PTY id is **not** in `keep`. Called by the
    /// frontend right after hydrate with the exact PTY ids it reattached to, so any
    /// session left orphaned by a reload (a closed pane, a dropped workspace, or a
    /// duplicate for the same pane) is reaped before it can leak.
    pub fn reap(&self, keep: &[String]) {
        let kill: Vec<String> = {
            let guard = self.sessions.lock();
            guard
                .iter()
                // Only pane-backed sessions are reapable: a PTY with no pane id was
                // never owned by the frontend, so an empty keep-list can't sweep it.
                .filter(|(id, s)| s.pane_id.is_some() && !keep.iter().any(|k| k == *id))
                .map(|(id, _)| id.clone())
                .collect()
        };
        for k in kill {
            if let Some(mut s) = self.sessions.lock().remove(&k) {
                let _ = s.child.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::vte::ansi::Rgb;

    #[test]
    fn enc_truecolor_packs_rgb() {
        let v = enc(Color::Spec(Rgb {
            r: 0x12,
            g: 0x34,
            b: 0x56,
        }));
        assert_eq!(v, RGB_FLAG | 0x123456);
    }

    #[test]
    fn term_config_caps_scrollback() {
        // Production panes must use the capped scrollback (not the 10_000-line
        // library default), or many idle panes would pin tens of MB each.
        assert_eq!(term_config().scrolling_history, SCROLLBACK_HISTORY);
        assert_eq!(SCROLLBACK_HISTORY, 2_000);

        let size = TermSize { cols: 8, lines: 2 };
        let mut term = Term::new(
            term_config(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        // Pump more lines than the cap so we exercise the eviction path.
        let payload: Vec<u8> = (0..(SCROLLBACK_HISTORY + 50))
            .flat_map(|i| format!("r{i}\r\n").into_bytes())
            .collect();
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, &payload);
        assert!(
            term.grid().history_size() <= SCROLLBACK_HISTORY,
            "history grew past cap: {}",
            term.grid().history_size()
        );
    }

    #[test]
    fn renders_text_and_color() {
        let size = TermSize { cols: 20, lines: 3 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, b"Hi\x1b[31mX");

        let grid = snapshot_full(&term);
        assert_eq!((grid.cols, grid.rows), (20, 3));
        assert_eq!(grid.kind, "full");
        assert_eq!(grid.lines.len(), 3, "full frame carries every row");

        let line0: String = grid.lines[0].runs.iter().map(|r| r.text.clone()).collect();
        assert!(line0.starts_with("HiX"), "got {line0:?}");

        // The 'X' should carry red foreground (NamedColor::Red == 1).
        let red_x = grid.lines[0]
            .runs
            .iter()
            .any(|r| r.text.contains('X') && r.fg == 1);
        assert!(red_x, "expected red X in {:?}", grid.lines[0].runs);
    }

    #[test]
    fn wflags_packs_each_attribute_bit() {
        assert_eq!(wflags(Flags::BOLD), 1);
        assert_eq!(wflags(Flags::ITALIC), 1 << 1);
        assert_eq!(wflags(Flags::UNDERLINE), 1 << 2);
        assert_eq!(wflags(Flags::INVERSE), 1 << 3);
        assert_eq!(wflags(Flags::DIM), 1 << 4);
        assert_eq!(wflags(Flags::STRIKEOUT), 1 << 5);
        assert_eq!(wflags(Flags::HIDDEN), 1 << 6);
        assert_eq!(wflags(Flags::empty()), 0);
        // Combined flags OR together.
        assert_eq!(wflags(Flags::BOLD | Flags::ITALIC), 0b11);
    }

    #[test]
    fn enc_named_and_indexed_colors() {
        assert_eq!(
            enc(Color::Named(alacritty_terminal::vte::ansi::NamedColor::Red)),
            1
        );
        assert_eq!(enc(Color::Indexed(42)), 42);
    }

    #[test]
    fn snapshot_coalesces_same_style_runs() {
        let size = TermSize { cols: 10, lines: 1 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, b"abc");
        let grid = snapshot_full(&term);
        // "abc" + 7 trailing spaces share one style → a single run for the text
        // plus (at most) one run for the default-styled blanks.
        let texts: Vec<String> = grid.lines[0].runs.iter().map(|r| r.text.clone()).collect();
        let joined: String = texts.concat();
        assert!(joined.starts_with("abc"));
        assert_eq!(joined.len(), 10, "row padded to column count");
        // Same-style "abc" is not split into three runs.
        assert!(
            grid.lines[0].runs.len() <= 2,
            "runs: {:?}",
            grid.lines[0].runs
        );
    }

    #[test]
    fn snapshot_clamps_to_grid_dimensions() {
        let size = TermSize { cols: 4, lines: 2 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        // Write more than fits on a line; emulator wraps, snapshot stays in bounds.
        parser.advance(&mut term, b"abcdefgh");
        let grid = snapshot_full(&term);
        assert_eq!(grid.rows, 2);
        assert_eq!(grid.cols, 4);
        assert!(grid.lines.iter().all(|l| l
            .runs
            .iter()
            .map(|r| r.text.chars().count())
            .sum::<usize>()
            == 4));
    }

    /// Mirror the render thread's damage handling: advance, read damage, build the
    /// matching update, then reset. Returns the update and whether damage was full.
    fn damage_update(term: &mut Term<alacritty_terminal::event::VoidListener>) -> WireUpdate {
        let rows = term.grid().screen_lines().max(1);
        let (full, idx): (bool, Vec<usize>) = match term.damage() {
            TermDamage::Full => (true, Vec::new()),
            TermDamage::Partial(it) => (false, it.map(|d| d.line).filter(|&y| y < rows).collect()),
        };
        term.reset_damage();
        if full {
            build_update("full", term, 0..rows)
        } else {
            build_update("delta", term, idx.into_iter())
        }
    }

    #[test]
    fn damage_delta_reports_only_changed_lines() {
        let size = TermSize { cols: 10, lines: 4 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        // Fill a few lines, then drain the (initially full) damage.
        parser.advance(&mut term, b"line0\r\nline1\r\nline2");
        let first = damage_update(&mut term);
        assert_eq!(first.kind, "full");

        // Touch only the current line (line 2) — a single character.
        parser.advance(&mut term, b"X");
        let delta = damage_update(&mut term);
        assert_eq!(delta.kind, "delta");
        // Only line 2 (and possibly the cursor's own line, which is the same) is
        // reported — never the untouched rows 0 and 1.
        assert!(
            delta.lines.iter().all(|l| l.y == 2),
            "expected only line 2, got {:?}",
            delta.lines.iter().map(|l| l.y).collect::<Vec<_>>()
        );
        let joined: String = delta.lines[0].runs.iter().map(|r| r.text.clone()).collect();
        assert!(joined.starts_with("line2X"), "got {joined:?}");
    }

    #[test]
    fn reset_damage_yields_no_phantom_lines() {
        let size = TermSize { cols: 8, lines: 3 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        // Damage all three rows, then drain that (full) damage.
        parser.advance(&mut term, b"r0\r\nr1\r\nr2");
        let _ = damage_update(&mut term);

        // No new bytes: the emulator always re-reports the cursor's own line, but
        // reset_damage must have cleared rows 0 and 1 — no phantom carry-over.
        let delta = damage_update(&mut term);
        assert_eq!(delta.kind, "delta");
        assert!(
            delta.lines.iter().all(|l| l.y == 2),
            "only the cursor line may remain, got {:?}",
            delta.lines.iter().map(|l| l.y).collect::<Vec<_>>()
        );
        assert!(delta.lines.len() <= 1, "at most the cursor line");
    }

    #[test]
    fn encode_lays_out_header_and_runs_little_endian() {
        let u = WireUpdate {
            kind: "delta",
            cols: 80,
            rows: 24,
            cursor_x: 3,
            cursor_y: 5,
            cursor_visible: true,
            mode: 0x14, // BRACKETED_PASTE | APP_CURSOR
            display_offset: 7,
            history: 99,
            lines: vec![WireLine {
                y: 2,
                runs: vec![WireRun {
                    text: "Hi".to_string(),
                    fg: 1,
                    bg: 257,
                    flags: 0,
                    link: None,
                }],
            }],
        };
        let b = encode(&u);
        // Header (30 bytes): version=2, kind=1, cursorVisible=1, _reserved=0,
        // cols=80, rows=24, cx=3, cy=5, mode, displayOffset, history, lineCount=1.
        assert_eq!(b[0], WIRE_VERSION);
        assert_eq!(b[1], 1);
        assert_eq!(b[2], 1);
        assert_eq!(b[3], 0);
        assert_eq!(u16::from_le_bytes([b[4], b[5]]), 80);
        assert_eq!(u16::from_le_bytes([b[6], b[7]]), 24);
        assert_eq!(u16::from_le_bytes([b[8], b[9]]), 3);
        assert_eq!(i32::from_le_bytes([b[10], b[11], b[12], b[13]]), 5);
        assert_eq!(u32::from_le_bytes([b[14], b[15], b[16], b[17]]), 0x14);
        assert_eq!(u32::from_le_bytes([b[18], b[19], b[20], b[21]]), 7);
        assert_eq!(u32::from_le_bytes([b[22], b[23], b[24], b[25]]), 99);
        assert_eq!(u32::from_le_bytes([b[26], b[27], b[28], b[29]]), 1);
        // Line: y=2, runCount=1
        assert_eq!(u16::from_le_bytes([b[30], b[31]]), 2);
        assert_eq!(u16::from_le_bytes([b[32], b[33]]), 1);
        // Run: fg=1, bg=257, flags=0, textLen=2, "Hi"
        assert_eq!(i32::from_le_bytes([b[34], b[35], b[36], b[37]]), 1);
        assert_eq!(i32::from_le_bytes([b[38], b[39], b[40], b[41]]), 257);
        assert_eq!(u16::from_le_bytes([b[42], b[43]]), 0);
        assert_eq!(u16::from_le_bytes([b[44], b[45]]), 2);
        assert_eq!(&b[46..48], b"Hi");
        assert_eq!(b.len(), 48);
    }

    #[test]
    fn encode_appends_hyperlink_after_text_when_flag_set() {
        let u = WireUpdate {
            kind: "delta",
            cols: 10,
            rows: 1,
            cursor_x: 0,
            cursor_y: 0,
            cursor_visible: false,
            mode: 0,
            display_offset: 0,
            history: 0,
            lines: vec![WireLine {
                y: 0,
                runs: vec![WireRun {
                    text: "x".to_string(),
                    fg: 256,
                    bg: 257,
                    flags: WF_HYPERLINK,
                    link: Some("https://e.x".to_string()),
                }],
            }],
        };
        let b = encode(&u);
        // After the 30-byte header + 4-byte line header + run (4+4+2 fixed):
        //   textLen=1, "x", then linkLen + link bytes.
        let run_at = 30 + 4;
        let text_len_at = run_at + 10;
        assert_eq!(u16::from_le_bytes([b[text_len_at], b[text_len_at + 1]]), 1);
        let link_len_at = text_len_at + 2 + 1;
        let link_len = u16::from_le_bytes([b[link_len_at], b[link_len_at + 1]]) as usize;
        assert_eq!(link_len, "https://e.x".len());
        let link = &b[link_len_at + 2..link_len_at + 2 + link_len];
        assert_eq!(link, b"https://e.x");
    }

    #[test]
    fn osc_8_hyperlinks_surface_only_on_their_own_cells() {
        // A plain row carries no `link` (cell.hyperlink() short-circuits via
        // its Option<Arc<CellExtra>> field probe). An OSC 8 sequence stamps
        // the hyperlink onto the cells between its open/close markers; only
        // those cells should round-trip with `link` + the WF_HYPERLINK flag.
        let size = TermSize { cols: 20, lines: 2 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        // Plain row.
        parser.advance(&mut term, b"plain text");
        // OSC 8 hyperlink: ESC ] 8 ; ; uri ESC \ then text then close.
        parser.advance(
            &mut term,
            b"\r\n\x1b]8;;https://e.x\x1b\\link\x1b]8;;\x1b\\",
        );

        let snap = snapshot_full(&term);
        assert!(
            snap.lines[0].runs.iter().all(|r| r.link.is_none()),
            "plain row leaked a hyperlink: {:?}",
            snap.lines[0].runs
        );
        let row1_has_link = snap.lines[1].runs.iter().any(|r| {
            r.link.as_deref() == Some("https://e.x")
                && r.text.contains('l')
                && r.flags & WF_HYPERLINK != 0
        });
        assert!(
            row1_has_link,
            "OSC 8 row missing link: {:?}",
            snap.lines[1].runs
        );
    }

    #[test]
    fn encode_pre_sizes_the_buffer_exactly() {
        // Mix plain runs, ASCII, multi-byte UTF-8 and a hyperlink run across two
        // lines: the buffer capacity must match the final length, proving the
        // capacity hint covered the payload precisely (no doubling realloc storm
        // when the render thread is emitting frames at 60 fps).
        let u = WireUpdate {
            kind: "delta",
            cols: 12,
            rows: 2,
            cursor_x: 1,
            cursor_y: 0,
            cursor_visible: true,
            mode: 0,
            display_offset: 0,
            history: 0,
            lines: vec![
                WireLine {
                    y: 0,
                    runs: vec![
                        WireRun {
                            text: "hello ".to_string(),
                            fg: 256,
                            bg: 257,
                            flags: 0,
                            link: None,
                        },
                        WireRun {
                            text: "wörld".to_string(),
                            fg: 1,
                            bg: 257,
                            flags: 1, // BOLD
                            link: None,
                        },
                    ],
                },
                WireLine {
                    y: 1,
                    runs: vec![WireRun {
                        text: "click".to_string(),
                        fg: 256,
                        bg: 257,
                        flags: WF_HYPERLINK,
                        link: Some("https://example.com".to_string()),
                    }],
                },
            ],
        };
        let b = encode(&u);
        assert_eq!(b.capacity(), b.len(), "encode reserved too much/too little");
    }

    #[test]
    fn scroll_and_selection_round_trip_through_scrollback() {
        // Build a small term with a tiny scrollback, push more rows than fit, then
        // verify display_offset moves on scroll and bounds_to_string reads history.
        let size = TermSize { cols: 8, lines: 2 };
        let cfg = Config {
            scrolling_history: 100,
            ..Default::default()
        };
        let mut term = Term::new(cfg, &size, alacritty_terminal::event::VoidListener);
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, b"row0\r\nrow1\r\nrow2\r\nrow3");
        assert_eq!(term.grid().display_offset(), 0, "starts at the live tail");
        assert!(
            term.grid().history_size() >= 2,
            "rows scrolled into history"
        );
        term.scroll_display(Scroll::Delta(1));
        assert_eq!(term.grid().display_offset(), 1, "scrolled one line back");

        let snap = snapshot_full(&term);
        assert_eq!(snap.display_offset, 1);
        assert!(snap.history >= 2);
    }

    #[test]
    fn coalesced_burst_matches_single_advance() {
        let size = TermSize { cols: 12, lines: 2 };
        // One chunk vs. the same bytes split across many chunks must snapshot
        // identically — this is what the render thread's burst-drain relies on.
        let mut whole = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut split = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut p1 = Processor::<StdSyncHandler>::new();
        let mut p2 = Processor::<StdSyncHandler>::new();
        p1.advance(&mut whole, b"\x1b[32mgreen\x1b[0m text");
        for byte in b"\x1b[32mgreen\x1b[0m text" {
            p2.advance(&mut split, &[*byte]);
        }
        let a = snapshot_full(&whole);
        let b = snapshot_full(&split);
        let ta: String = a.lines[0].runs.iter().map(|r| r.text.clone()).collect();
        let tb: String = b.lines[0].runs.iter().map(|r| r.text.clone()).collect();
        assert_eq!(ta, tb);
        assert_eq!(a.lines[0].runs.len(), b.lines[0].runs.len());
    }

    #[cfg(unix)]
    fn spawn_opts(command: &str, args: &[&str]) -> SpawnOpts {
        SpawnOpts {
            cwd: "/tmp".into(),
            command: command.into(),
            args: args.iter().map(|a| (*a).to_string()).collect(),
            env: vec![],
            cols: 80,
            rows: 24,
        }
    }

    #[cfg(unix)]
    #[test]
    fn shell_pane_launches_login_shell_directly() {
        // A bare shell pane runs the user's `$SHELL` as an interactive login shell
        // (`-il`), never the macOS-frozen `/bin/bash` 3.2 and never nested in `exec`.
        let shell = crate::agents::default_shell();
        for cmd in [shell.as_str(), "bash", "zsh", "/bin/zsh", "fish"] {
            let argv = build_command(&spawn_opts(cmd, &[]))
                .get_argv()
                .iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert_eq!(argv, vec![shell.clone(), "-il".to_string()], "cmd={cmd}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn agent_is_wrapped_in_login_shell_exec() {
        // A real agent is routed through `$SHELL -ilc 'exec "$0" "$@"' <cmd> <args>`
        // so it inherits the user's full login environment.
        let shell = crate::agents::default_shell();
        let argv = build_command(&spawn_opts("claude", &["--continue"]))
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            argv,
            vec![
                shell,
                "-ilc".to_string(),
                "exec \"$0\" \"$@\"".to_string(),
                "claude".to_string(),
                "--continue".to_string(),
            ]
        );
    }

    #[test]
    fn h1_token_matches_accepts_only_the_exact_token() {
        // Right token of the same length: accepted.
        assert!(token_matches("the-real-token", "the-real-token"));
        // Same length, one byte off: rejected. Constant-time compare doesn't
        // lie — every byte position is examined regardless.
        assert!(!token_matches("the-real-token", "the-real-toke!"));
        // Different lengths: rejected (the length pre-check is what keeps
        // constant-time from leaking the length itself).
        assert!(!token_matches("the-real-token", ""));
        assert!(!token_matches("the-real-token", "the-real-token-extra"));
        // Prefix: rejected. Without the length check the operator would
        // short-circuit and leak the length, so this case is the regression
        // the constant-time compare must catch.
        assert!(!token_matches("the-real-token", "the-real-toke"));
    }

    #[test]
    fn h1_live_panes_signature_does_not_leak_token() {
        // `live_panes` returns `(pane_id, pty_id)` — two strings — so by
        // construction no token reaches the renderer through it. A shape
        // assertion (the runtime invariant is checked by the type system).
        let mgr = TerminalManager::default();
        let v: Vec<(String, String)> = mgr.live_panes();
        assert!(v.is_empty());
    }

    #[test]
    fn c4_env_allowlist_drops_unknown_keys() {
        // The renderer sends a mix of swarm-internal keys and shell-state keys
        // a subverted webview could try to use to swap a binary
        // (`PATH`/`LD_PRELOAD`/`ZDOTDIR`/`BASH_ENV`). Only the allowlisted
        // swarm keys survive — values are preserved verbatim, order preserved.
        let opts = SpawnOpts {
            cwd: "/tmp".into(),
            command: "claude".into(),
            args: vec![],
            env: vec![
                ("PATH".into(), "/evil/bin".into()),
                ("LD_PRELOAD".into(), "/evil/libc.so".into()),
                ("SWARM_PANE_ID".into(), "pane-x".into()),
                ("ZDOTDIR".into(), "/evil".into()),
                ("BASH_ENV".into(), "/evil/rc".into()),
                ("CODEX_HOME".into(), "/swarm/codex".into()),
                ("CLAUDE_CODE_NO_FLICKER".into(), "1".into()),
                ("SWARM_EVENT_FILE".into(), "/events/pane-x".into()),
                ("SWARM_AGENT_ARGV_JSON".into(), r#"["a"]"#.into()),
                ("NODE_OPTIONS".into(), "--inspect".into()),
            ],
            cols: 80,
            rows: 24,
        };
        let filtered = filter_env(&opts);
        let keys: Vec<&str> = filtered.iter().map(|(k, _)| k.as_str()).collect();
        // Allowlisted keys survive…
        assert!(keys.contains(&"SWARM_PANE_ID"));
        assert!(keys.contains(&"SWARM_EVENT_FILE"));
        assert!(keys.contains(&"SWARM_AGENT_ARGV_JSON"));
        assert!(keys.contains(&"CODEX_HOME"));
        assert!(keys.contains(&"CLAUDE_CODE_NO_FLICKER"));
        // …with their values intact.
        let pane_id = filtered.iter().find(|(k, _)| k == "SWARM_PANE_ID").unwrap();
        assert_eq!(pane_id.1, "pane-x");
        // Hostile / not-our-business keys are dropped.
        for evil in ["PATH", "LD_PRELOAD", "ZDOTDIR", "BASH_ENV", "NODE_OPTIONS"] {
            assert!(!keys.contains(&evil), "{evil} leaked through");
        }
        // No extra keys beyond the allowlisted ones we passed in.
        assert_eq!(filtered.len(), 5);
    }

    #[test]
    fn c1_is_allowed_command_only_accepts_shell_and_registered_agents() {
        // The login shell is allowed (both bare name and absolute path).
        let shell = crate::agents::default_shell();
        let shell_base = std::path::Path::new(&shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&shell);
        assert!(is_allowed_command(shell_base));
        assert!(is_allowed_command(&shell));

        // Every registry agent is allowed by its registry command (basename).
        for r in crate::agents::REGISTRY {
            if r.command.is_empty() {
                continue; // the "shell" pane has no static command (resolved at runtime)
            }
            assert!(
                is_allowed_command(r.command),
                "registry agent {} rejected",
                r.id
            );
            // An absolute path with the same basename is also allowed.
            let abs = format!("/usr/local/bin/{}", r.command);
            assert!(is_allowed_command(&abs), "absolute {abs} rejected");
        }

        // Anything else is rejected — empty, arbitrary binaries, traversal.
        assert!(!is_allowed_command(""));
        assert!(!is_allowed_command("curl"));
        assert!(!is_allowed_command("/usr/bin/curl"));
        assert!(!is_allowed_command("../../etc/sh"));
        assert!(!is_allowed_command("python"));
    }

    #[cfg(unix)]
    #[test]
    fn shell_name_with_args_is_not_a_shell_pane() {
        // `bash -c …` (a shell *invoked as an agent* with args) keeps the exec wrapper
        // rather than collapsing to a bare login shell.
        let argv = build_command(&spawn_opts("bash", &["-c", "echo hi"]))
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(argv.contains(&"exec \"$0\" \"$@\"".to_string()));
        assert_eq!(argv.last().unwrap(), "echo hi");
    }
}
