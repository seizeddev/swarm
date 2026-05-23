// SPDX-License-Identifier: GPL-3.0-or-later
//! Terminal core: real VT emulation via the Alacritty engine, one `Term` per
//! session. PTY bytes are parsed in Rust; the frontend only paints the cell
//! grid we stream over a Tauri `Channel` — no xterm.js, no TUI scraping.

use crate::error::{AppError, AppResult};
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Color, CursorShape, Processor, StdSyncHandler};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

const FG: i32 = 256; // NamedColor::Foreground
const BG: i32 = 257; // NamedColor::Background
const RGB_FLAG: i32 = 0x0100_0000;

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

#[derive(Clone, Debug, Serialize)]
pub struct WireRun {
    pub text: String,
    pub fg: i32,
    pub bg: i32,
    pub flags: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireGrid {
    pub cols: usize,
    pub rows: usize,
    pub cursor_x: usize,
    pub cursor_y: i32,
    pub cursor_visible: bool,
    pub lines: Vec<Vec<WireRun>>,
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
            _ => {}
        }
    }
}

/// OSC 99 chunk buffers, carried across reads.
#[derive(Default)]
struct NotifState {
    id: Option<String>,
    title: String,
    body: String,
}

/// Parse OSC 9 / 99 / 777 desktop-notification sequences from a chunk and
/// return the completed `(title, body)` pairs. OSC 99 (kitty) chunks are
/// buffered across calls in `st`. Pure — no side effects, so it's unit-tested.
fn parse_notifications(bytes: &[u8], st: &mut NotifState) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let n = bytes.len();
    let mut i = 0;
    while i + 1 < n {
        if bytes[i] == 0x1b && bytes[i + 1] == b']' {
            let start = i + 2;
            let mut end = start;
            while end < n
                && bytes[end] != 0x07
                && !(bytes[end] == 0x1b && end + 1 < n && bytes[end + 1] == b'\\')
            {
                end += 1;
            }
            if let Ok(text) = std::str::from_utf8(&bytes[start..end.min(n)]) {
                if let Some(rest) = text.strip_prefix("9;") {
                    // OSC 9 is overloaded. iTerm2 uses `OSC 9 ; <message>` for a
                    // desktop notification, but ConEmu / Windows Terminal use
                    // `OSC 9 ; <digit> ; …` sub-commands — notably `9;4;<state>;<pct>`
                    // for the taskbar progress bar. Claude Code emits `9;4;0;` to
                    // reset progress on start/exit; that is NOT a notification.
                    if !is_conemu_osc9(rest) {
                        out.push((String::new(), rest.to_string()));
                    }
                } else if let Some(rest) = text.strip_prefix("777;notify;") {
                    let mut parts = rest.splitn(2, ';');
                    let title = parts.next().unwrap_or("").to_string();
                    let body = parts.next().unwrap_or("").to_string();
                    out.push((title, body));
                } else if let Some(rest) = text.strip_prefix("99;") {
                    if let Some(done) = handle_osc99(rest, st) {
                        out.push(done);
                    }
                }
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// True for ConEmu / Windows Terminal `OSC 9` sub-commands, which take the form
/// `<digit>;…` (e.g. `4;0;0` taskbar progress, `9;<cwd>` working directory).
/// iTerm2 notification messages are free-form text, so the `<digit>;` shape is a
/// reliable signal that this OSC 9 is a control sequence, not a notification.
fn is_conemu_osc9(rest: &str) -> bool {
    let mut chars = rest.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_digit()) && chars.next() == Some(';')
}

/// kitty notification protocol: `99;<meta>;<payload>` where meta is a
/// `:`-separated key=value list (i=id, p=title|body, d=done, e=encoding).
fn handle_osc99(rest: &str, st: &mut NotifState) -> Option<(String, String)> {
    let (meta, payload) = match rest.find(';') {
        Some(k) => (&rest[..k], &rest[k + 1..]),
        None => (rest, ""),
    };
    let mut p_type = "title";
    let mut done = true;
    let mut encoded = false;
    let mut nid: Option<String> = None;
    for kv in meta.split(':') {
        if let Some(v) = kv.strip_prefix("i=") {
            nid = Some(v.to_string());
        } else if let Some(v) = kv.strip_prefix("p=") {
            p_type = v;
        } else if let Some(v) = kv.strip_prefix("d=") {
            done = v != "0";
        } else if let Some(v) = kv.strip_prefix("e=") {
            encoded = v == "1";
        }
    }
    if p_type == "close" || p_type == "alive" {
        return None;
    }
    let decoded = if encoded {
        STANDARD
            .decode(payload)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    } else {
        payload.to_string()
    };
    if nid != st.id {
        st.id = nid;
        st.title.clear();
        st.body.clear();
    }
    if p_type == "body" {
        st.body.push_str(&decoded);
    } else {
        st.title.push_str(&decoded);
    }
    if done {
        let result = (std::mem::take(&mut st.title), std::mem::take(&mut st.body));
        st.id = None;
        Some(result)
    } else {
        None
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

fn snapshot<T: EventListener>(term: &Term<T>, size: TermSize) -> WireGrid {
    let cols = size.cols.max(1);
    let rows = size.lines.max(1);
    let mut cells = vec![vec![(' ', FG, BG, 0u16); cols]; rows];

    let content = term.renderable_content();
    let offset = content.display_offset as i32;
    for ind in content.display_iter {
        let cell = ind.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let line = ind.point.line.0 + offset;
        let col = ind.point.column.0;
        if line < 0 || line as usize >= rows || col >= cols {
            continue;
        }
        let ch = if cell.c == '\0' { ' ' } else { cell.c };
        cells[line as usize][col] = (ch, enc(cell.fg), enc(cell.bg), wflags(cell.flags));
    }

    // Coalesce same-style runs per line to keep the payload (and DOM) small.
    let mut lines = Vec::with_capacity(rows);
    for row in &cells {
        let mut runs: Vec<WireRun> = Vec::new();
        for &(ch, fg, bg, fl) in row {
            match runs.last_mut() {
                Some(r) if r.fg == fg && r.bg == bg && r.flags == fl => r.text.push(ch),
                _ => runs.push(WireRun {
                    text: ch.to_string(),
                    fg,
                    bg,
                    flags: fl,
                }),
            }
        }
        lines.push(runs);
    }

    let cursor = content.cursor;
    WireGrid {
        cols,
        rows,
        cursor_x: cursor.point.column.0,
        cursor_y: cursor.point.line.0 + offset,
        cursor_visible: !matches!(cursor.shape, CursorShape::Hidden),
        lines,
    }
}

impl TerminalManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        opts: SpawnOpts,
        on_grid: Channel<WireGrid>,
    ) -> AppResult<()> {
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

        let mut cmd = CommandBuilder::new(&opts.command);
        cmd.args(&opts.args);
        cmd.cwd(&opts.cwd);
        for (k, v) in &opts.env {
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
            Config::default(),
            &TermSize {
                cols: cols as usize,
                lines: rows as usize,
            },
            proxy,
        )));

        self.sessions.lock().insert(
            id.clone(),
            Session {
                term: term.clone(),
                input_tx,
                master: pair.master,
                child,
                size: size.clone(),
            },
        );

        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let mut parser = Processor::<StdSyncHandler>::new();
            let mut notif = NotifState::default();
            let mut last_body = String::new();
            let mut last_at: Option<std::time::Instant> = None;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for (title, body) in parse_notifications(&buf[..n], &mut notif) {
                            // Dedup identical content within a 1s window.
                            let now = std::time::Instant::now();
                            if body == last_body
                                && last_at.is_some_and(|t| now.duration_since(t).as_millis() < 1000)
                            {
                                continue;
                            }
                            last_body = body.clone();
                            last_at = Some(now);
                            let _ = app.emit(
                                "term:notify",
                                serde_json::json!({ "id": id, "title": title, "body": body }),
                            );
                            let _ = app.emit("term:attention", serde_json::json!({ "id": id }));
                        }
                        let grid = {
                            let mut t = term.lock();
                            parser.advance(&mut *t, &buf[..n]);
                            snapshot(&t, *size.lock())
                        };
                        if on_grid.send(grid).is_err() {
                            break;
                        }
                    }
                }
            }
            let code = sessions
                .lock()
                .get_mut(&id)
                .and_then(|s| s.child.wait().ok())
                .map(|st| st.exit_code());
            sessions.lock().remove(&id);
            let _ = app.emit("pty:exit", serde_json::json!({ "id": id, "code": code }));
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        let guard = self.sessions.lock();
        let session = guard
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("terminal '{id}' not found")))?;
        session
            .input_tx
            .send(data.as_bytes().to_vec())
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<Option<WireGrid>> {
        let guard = self.sessions.lock();
        let session = match guard.get(id) {
            Some(s) => s,
            None => return Ok(None),
        };
        let new = TermSize {
            cols: cols.max(1) as usize,
            lines: rows.max(1) as usize,
        };
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
        let mut t = session.term.lock();
        t.resize(new);
        Ok(Some(snapshot(&t, new)))
    }

    pub fn kill(&self, id: &str) -> AppResult<()> {
        if let Some(mut session) = self.sessions.lock().remove(id) {
            let _ = session.child.kill();
        }
        Ok(())
    }

    pub fn alive(&self, id: &str) -> bool {
        self.sessions.lock().contains_key(id)
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
    fn renders_text_and_color() {
        let size = TermSize { cols: 20, lines: 3 };
        let mut term = Term::new(
            Config::default(),
            &size,
            alacritty_terminal::event::VoidListener,
        );
        let mut parser = Processor::<StdSyncHandler>::new();
        parser.advance(&mut term, b"Hi\x1b[31mX");

        let grid = snapshot(&term, size);
        assert_eq!((grid.cols, grid.rows), (20, 3));

        let line0: String = grid.lines[0].iter().map(|r| r.text.clone()).collect();
        assert!(line0.starts_with("HiX"), "got {line0:?}");

        // The 'X' should carry red foreground (NamedColor::Red == 1).
        let red_x = grid.lines[0]
            .iter()
            .any(|r| r.text.contains('X') && r.fg == 1);
        assert!(red_x, "expected red X in {:?}", grid.lines[0]);
    }

    #[test]
    fn parses_osc_notifications() {
        let mut st = NotifState::default();
        assert_eq!(
            parse_notifications(b"\x1b]9;hello\x07", &mut st),
            vec![(String::new(), "hello".to_string())]
        );
        assert_eq!(
            parse_notifications(b"\x1b]777;notify;Build;Done\x07", &mut st),
            vec![("Build".to_string(), "Done".to_string())]
        );

        // OSC 99 kitty: chunked title then body, emits only when complete.
        let mut k = NotifState::default();
        assert!(parse_notifications(b"\x1b]99;i=x:d=0:p=title;Hi\x1b\\", &mut k).is_empty());
        assert_eq!(
            parse_notifications(b"\x1b]99;i=x:p=body;There\x1b\\", &mut k),
            vec![("Hi".to_string(), "There".to_string())]
        );
    }

    #[test]
    fn osc9_conemu_subcommands_are_not_notifications() {
        let mut st = NotifState::default();
        // Taskbar progress reset emitted by Claude Code on start/exit — must NOT
        // surface as a "4;0;" notification (the bug this guards against).
        assert!(parse_notifications(b"\x1b]9;4;0;\x07", &mut st).is_empty());
        // Other progress states and the cwd sub-command are likewise ignored.
        assert!(parse_notifications(b"\x1b]9;4;3;50\x07", &mut st).is_empty());
        assert!(parse_notifications(b"\x1b]9;9;/home/u\x07", &mut st).is_empty());
        // A genuine iTerm2 notification whose text merely *starts* with a digit
        // (no `<digit>;` control shape) still comes through.
        assert_eq!(
            parse_notifications(b"\x1b]9;42 builds done\x07", &mut st),
            vec![(String::new(), "42 builds done".to_string())]
        );
    }

    #[test]
    fn osc9_simple_via_bel_and_st_terminators() {
        let mut st = NotifState::default();
        // BEL terminator
        assert_eq!(
            parse_notifications(b"\x1b]9;bel\x07", &mut st),
            vec![(String::new(), "bel".to_string())]
        );
        // ESC-backslash (ST) terminator
        assert_eq!(
            parse_notifications(b"\x1b]9;st\x1b\\", &mut st),
            vec![(String::new(), "st".to_string())]
        );
    }

    #[test]
    fn osc99_base64_encoded_payload_is_decoded() {
        let mut st = NotifState::default();
        // "Done" base64 = "RG9uZQ==", single-shot (d defaults to done) title.
        let out = parse_notifications(b"\x1b]99;e=1:p=title;RG9uZQ==\x07", &mut st);
        assert_eq!(out, vec![("Done".to_string(), String::new())]);
    }

    #[test]
    fn osc99_close_and_alive_are_ignored() {
        let mut st = NotifState::default();
        assert!(parse_notifications(b"\x1b]99;p=close;\x07", &mut st).is_empty());
        assert!(parse_notifications(b"\x1b]99;p=alive;\x07", &mut st).is_empty());
    }

    #[test]
    fn osc99_new_id_resets_buffered_chunks() {
        let mut st = NotifState::default();
        // Start an incomplete notification id=1…
        assert!(parse_notifications(b"\x1b]99;i=1:d=0:p=title;Part\x1b\\", &mut st).is_empty());
        // …then a different id arrives complete: the stale "Part" must be dropped.
        let out = parse_notifications(b"\x1b]99;i=2;Fresh\x1b\\", &mut st);
        assert_eq!(out, vec![("Fresh".to_string(), String::new())]);
    }

    #[test]
    fn multiple_sequences_in_one_chunk() {
        let mut st = NotifState::default();
        let out = parse_notifications(b"\x1b]9;one\x07junk\x1b]9;two\x07", &mut st);
        assert_eq!(
            out,
            vec![
                (String::new(), "one".to_string()),
                (String::new(), "two".to_string())
            ]
        );
    }

    #[test]
    fn non_osc_bytes_yield_no_notifications() {
        let mut st = NotifState::default();
        assert!(parse_notifications(b"plain text \x1b[31m colored", &mut st).is_empty());
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
        let grid = snapshot(&term, size);
        // "abc" + 7 trailing spaces share one style → a single run for the text
        // plus (at most) one run for the default-styled blanks.
        let texts: Vec<String> = grid.lines[0].iter().map(|r| r.text.clone()).collect();
        let joined: String = texts.concat();
        assert!(joined.starts_with("abc"));
        assert_eq!(joined.len(), 10, "row padded to column count");
        // Same-style "abc" is not split into three runs.
        assert!(grid.lines[0].len() <= 2, "runs: {:?}", grid.lines[0]);
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
        let grid = snapshot(&term, size);
        assert_eq!(grid.rows, 2);
        assert_eq!(grid.cols, 4);
        assert!(grid
            .lines
            .iter()
            .all(|l| l.iter().map(|r| r.text.chars().count()).sum::<usize>() == 4));
    }
}
