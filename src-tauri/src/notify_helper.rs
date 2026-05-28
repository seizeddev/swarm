// SPDX-License-Identifier: GPL-3.0-or-later
//! Cross-platform notification helper, invoked as `swarm --notify-helper <mode>`
//! from agent completion hooks. Pure Rust (no bash/jq), so the same hook command
//! works on macOS, Linux and Windows — the agents only ever need to run our own
//! binary. Two modes:
//!
//!   - `claude-stop`: read Claude Code's Stop-hook JSON from stdin, pull the last
//!     assistant message out of its transcript, and print a `terminalSequence`
//!     JSON (OSC 777) to stdout for Claude to emit into the PTY.
//!   - `event`: read an agent's completion payload (Codex passes it as an argv
//!     arg; others pipe it on stdin), pull the last assistant message, and append
//!     one line to `$SWARM_EVENT_FILE` — the events watcher turns it into a
//!     `pane:notify`.
//!
//! Both fall back to "Turn complete" when no message is available.

use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

// OSC 777 title for our Claude Stop-hook notification. A sentinel (not the
// display name) so the frontend can accept *only* our notification on a Claude
// pane and drop Claude Code's own — see CLAUDE_NOTIF_SENTINEL in store.ts. The
// UI shows the pane title ("Claude Code"), not this token.
const AGENT_NAME: &str = "swarm-claude";
const FALLBACK: &str = "Turn complete";
const MAX_LEN: usize = 200;

/// Refuse a `SWARM_EVENT_FILE` whose canonicalised parent is not the events
/// root (or whose basename contains traversal characters). Returns the
/// resolved path the caller may safely write to.
fn validated_event_file_in(events_root: &Path, target_str: &str) -> Option<PathBuf> {
    let target = Path::new(target_str);
    let events_root_canon = events_root.canonicalize().ok()?;
    let parent_canon = target.parent()?.canonicalize().ok()?;
    if parent_canon != events_root_canon {
        return None;
    }
    let name = target.file_name()?.to_str()?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return None;
    }
    Some(events_root_canon.join(name))
}

/// Resolve `target_str` against the user's `~/.swarm/events` events root.
fn validated_event_file(target_str: &str) -> Option<PathBuf> {
    let events_root = dirs::home_dir()?.join(".swarm").join("events");
    validated_event_file_in(&events_root, target_str)
}

/// Entry point. `args` are everything after `--notify-helper`. Never panics —
/// any failure degrades to the fallback (or silence) so a hook never errors out.
pub fn run(args: &[String]) {
    let mode = args.first().map(String::as_str).unwrap_or("");
    // `session-start <agent>`: capture the agent's session + launch flags for
    // restore. The agent id is an explicit argv arg; the payload is always stdin
    // (the agent's hook JSON, carrying session_id/cwd).
    if mode == "session-start" {
        let agent = args.get(1).map(String::as_str).unwrap_or("");
        let mut payload = String::new();
        let _ = std::io::stdin().read_to_string(&mut payload);
        crate::agent_session::record_session_start(agent, &payload);
        return;
    }
    // Payload: an explicit argv arg (Codex) wins; otherwise read stdin.
    let payload = if args.len() > 1 {
        args[1..].join(" ")
    } else {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    };
    match mode {
        "claude-stop" => {
            let msg = claude_stop_message(&payload);
            let seq = format!("\u{1b}]777;notify;{AGENT_NAME};{msg}\u{7}");
            // serde_json escapes the ESC/BEL control bytes as  / .
            let out = serde_json::json!({ "terminalSequence": seq });
            if let Ok(s) = serde_json::to_string(&out) {
                print!("{s}");
            }
        }
        "event" => {
            let msg = field_message(&payload).unwrap_or_else(|| FALLBACK.to_string());
            write_event_line(&msg);
        }
        // Claude Code's `Notification` hook fires mid-turn when Claude is
        // waiting for the user: tool-permission prompts ("Claude needs your
        // permission to use Bash"), the 60s idle reminder, and plan mode's
        // `ExitPlanMode` approval. `Stop` doesn't fire for these (Claude is
        // paused, not done), so without this hook a paused Claude looks
        // silent. The payload's `message` field carries the user-visible
        // reason; we forward it through the same events-file path generic
        // agents use, which lands in `pane:notify` → `onPaneNotify` and
        // bypasses the Claude OSC sentinel filter (that's Stop's path).
        "claude-notification" => {
            let msg = claude_notification_message(&payload);
            write_event_line(&msg);
        }
        _ => {}
    }
}

/// Append a notification body to the per-pane `SWARM_EVENT_FILE` if one is set
/// and points inside the events root. The fs watcher picks up the modify and
/// emits `pane:notify`. Best-effort everywhere — the helper never errors a hook.
fn write_event_line(msg: &str) {
    let Ok(path_str) = std::env::var("SWARM_EVENT_FILE") else {
        return;
    };
    // Containment check: the renderer set `SWARM_EVENT_FILE` from swarm's
    // events_dir, but a compromised renderer could swap it for `/etc/passwd`
    // (or any other writable file) before spawn. Refuse anything that doesn't
    // sit DIRECTLY under `~/.swarm/events/` — the same containment posture
    // as discard_paths.
    let Some(path) = validated_event_file(&path_str) else {
        return;
    };
    use std::io::Write;
    if let Ok(mut f) = crate::fsperm::open_options_owner_only().open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

/// Extract the user-visible reason from Claude's Notification hook payload.
/// Falls back to `FALLBACK` ("Turn complete") when the message field is
/// missing/blank so the user still sees *something* in the banner.
fn claude_notification_message(payload: &str) -> String {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
        .map(|s| clean(&s))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| FALLBACK.to_string())
}

/// For Claude's Stop hook. Like cmux (`summarizeClaudeHookStop`): prefer the
/// assistant message Claude hands us in the payload — that's the correct final
/// message and sidesteps transcript races (picking the first text) and Claude's
/// internal "Continue from where you left off." → "No response requested."
/// continuation turn. Only fall back to scanning the transcript.
fn claude_stop_message(payload: &str) -> String {
    // Documented Stop-hook field `last_assistant_message` (Claude Code v2.1.145+)
    // — the final response text, no transcript parsing needed. field_message
    // covers it (+ camel/preamble variants for other agents reusing this path).
    if let Some(m) = field_message(payload) {
        return m;
    }
    // Fallback only if the field is somehow absent (older Claude): scan the
    // transcript, skipping internal meta-continuation turns.
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|v| {
            v.get("transcript_path")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .and_then(|p| last_assistant_from_transcript(&p))
        .unwrap_or_else(|| FALLBACK.to_string())
}

/// Last *real* assistant turn's text from a Claude transcript JSONL: keep the
/// last `assistant` entry's joined `text` blocks, but skip entries that answer a
/// `user` message flagged `isMeta: true` (Claude's internal "Continue from where
/// you left off." → "No response requested." continuation), which are not the
/// user-visible reply.
fn last_assistant_from_transcript(path: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut last: Option<String> = None;
    let mut prev_user_meta = false;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                prev_user_meta = v.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
                continue;
            }
            Some("assistant") => {}
            _ => continue,
        }
        if prev_user_meta {
            continue; // internal continuation turn — not the visible reply
        }
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            continue;
        };
        let text = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        if !text.trim().is_empty() {
            last = Some(text);
        }
    }
    last.map(|t| clean(&t)).filter(|t| !t.is_empty())
}

/// For other agents: pull the assistant message from the payload's well-known
/// fields (covering Codex's hyphenated key and the camel/snake variants others
/// use). Returns None when absent/blank so the caller can fall back.
fn field_message(payload: &str) -> Option<String> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let obj = v.as_object()?;
    [
        "last-assistant-message",
        "last_assistant_message",
        "lastAssistantMessage",
        "assistantPreamble",
        "assistant_preamble",
    ]
    .into_iter()
    .find_map(|k| obj.get(k).and_then(Value::as_str))
    .map(clean)
    .filter(|t| !t.is_empty())
}

/// Turn an agent's (often Markdown) reply into one tidy notification line: strip
/// Markdown syntax, collapse all whitespace/control characters to single spaces,
/// trim, and cap at MAX_LEN characters. Without the strip, a body like
/// `**Done** — all tests pass` reaches the OS banner verbatim (the native
/// notification API and our in-app list render plain text, not Markdown).
fn clean(s: &str) -> String {
    let stripped = strip_markdown(s);
    let collapsed: String = stripped
        .chars()
        .map(|c| {
            if c.is_control() || c.is_whitespace() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let trimmed = collapsed.split_whitespace().collect::<Vec<_>>().join(" ");
    trimmed.chars().take(MAX_LEN).collect()
}

/// Best-effort plain-text reduction of Markdown — not a full parser, just enough
/// so notification bodies don't show raw syntax. Per line we drop block-level
/// markers (headings, blockquotes, list bullets, code-fence lines, horizontal
/// rules); inline we unwrap links/images to their text and remove emphasis,
/// strikethrough, and code-span delimiters.
fn strip_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        match strip_md_line_prefix(line) {
            // A code-fence (``` / ~~~) or horizontal-rule line carries no text.
            None => continue,
            Some(rest) => {
                out.push_str(&strip_md_inline(rest));
                out.push('\n');
            }
        }
    }
    out
}

/// Strip a line's leading block markers. Returns None for lines that are pure
/// structure (code fences, horizontal rules) and so contribute no text.
fn strip_md_line_prefix(line: &str) -> Option<&str> {
    let mut t = line.trim_start();
    let trimmed = t.trim_end();
    // Code fence (``` or ~~~, optionally with an info string) — drop the line.
    if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
        return None;
    }
    // Horizontal rule: a line of only -, * or _ (3+), possibly space-separated.
    if trimmed.chars().filter(|c| !c.is_whitespace()).count() >= 3
        && trimmed
            .chars()
            .all(|c| c == '-' || c == '*' || c == '_' || c.is_whitespace())
    {
        return None;
    }
    // Blockquote markers (possibly nested: `> > `).
    loop {
        let after = t.strip_prefix('>').map(str::trim_start);
        match after {
            Some(a) => t = a,
            None => break,
        }
    }
    // ATX heading: 1–6 leading '#' followed by a space (or end of line).
    let hashes = t.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) {
        let after = &t[hashes..];
        if after.is_empty() || after.starts_with(' ') {
            t = after.trim_start();
        }
    }
    // List bullet: -, * or + then a space.
    if let Some(rest) = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))
    {
        t = rest.trim_start();
    } else {
        // Ordered list: digits then '.' or ')' then a space.
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            let after = &t[digits..];
            if let Some(rest) = after
                .strip_prefix(". ")
                .or_else(|| after.strip_prefix(") "))
            {
                t = rest.trim_start();
            }
        }
    }
    Some(t)
}

/// Strip inline Markdown from a single line: `[text](url)`/`![alt](url)` → text,
/// `**x**`/`*x*`/`__x__`/`_x_` → x, `~~x~~` → x, `` `x` `` → x. Underscores and
/// lone asterisks that aren't acting as emphasis delimiters (e.g. `snake_case`,
/// `2 * 3`) are preserved.
fn strip_md_inline(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            // Image marker: drop the '!', let the next iteration handle '['.
            '!' if chars.get(i + 1) == Some(&'[') => {
                i += 1;
            }
            '[' => {
                if let Some(close) = find_char(&chars, i + 1, ']') {
                    // `[text](url)` → text; also accept a bare `[text]`.
                    let end = if chars.get(close + 1) == Some(&'(') {
                        find_char(&chars, close + 2, ')').map(|p| p + 1)
                    } else {
                        Some(close + 1)
                    };
                    if let Some(end) = end {
                        let text: String = chars[i + 1..close].iter().collect();
                        out.push_str(&strip_md_inline(&text));
                        i = end;
                        continue;
                    }
                }
                out.push(c);
                i += 1;
            }
            '`' => {
                while i < chars.len() && chars[i] == '`' {
                    i += 1;
                }
            }
            '*' => {
                let start = i;
                while i < chars.len() && chars[i] == '*' {
                    i += 1;
                }
                // A run flanked by whitespace on both sides isn't emphasis (`2 * 3`).
                let prev_ws = start == 0 || chars[start - 1].is_whitespace();
                let next_ws = i >= chars.len() || chars[i].is_whitespace();
                if prev_ws && next_ws {
                    out.extend(&chars[start..i]);
                }
            }
            '~' if chars.get(i + 1) == Some(&'~') => {
                while i < chars.len() && chars[i] == '~' {
                    i += 1;
                }
            }
            '_' => {
                let start = i;
                while i < chars.len() && chars[i] == '_' {
                    i += 1;
                }
                // Keep intra-word underscores (snake_case); drop emphasis delimiters.
                let prev_word = start > 0 && is_word(chars[start - 1]);
                let next_word = i < chars.len() && is_word(chars[i]);
                if prev_word && next_word {
                    out.extend(&chars[start..i]);
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Index of the next `needle` at or after `from`, if any.
fn find_char(chars: &[char], from: usize, needle: char) -> Option<usize> {
    chars[from..]
        .iter()
        .position(|&c| c == needle)
        .map(|p| from + p)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("swarm-m3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(&p).unwrap()
    }

    #[test]
    fn m3_validated_event_file_in_accepts_legitimate_target() {
        // The legitimate case: target sits directly under the events root.
        let root = scratch_root();
        let target = root.join("pane-x");
        // The file doesn't need to exist yet — only its parent must
        // canonicalise to the events root.
        let resolved = validated_event_file_in(&root, target.to_str().unwrap()).unwrap();
        assert_eq!(resolved, root.join("pane-x"));
    }

    #[test]
    fn m3_validated_event_file_in_rejects_sibling_dir() {
        // Target lives outside the events root: refused even though the path
        // looks innocuous.
        let base = std::env::temp_dir().join(format!("swarm-m3-base-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("events");
        let outside = base.join("evil");
        std::fs::create_dir_all(&root).unwrap();
        let target = outside.join("pane-x");
        assert!(validated_event_file_in(&root, target.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn m3_validated_event_file_in_rejects_traversal() {
        // `events_root/../etc/passwd` resolves outside the events root — must
        // be rejected even though the surface path "starts inside".
        let base = std::env::temp_dir().join(format!("swarm-m3-trav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let root = base.join("events");
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("..").join("escape");
        assert!(validated_event_file_in(&root, target.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn m3_validated_event_file_in_rejects_absolute_path_outside() {
        // A canonical absolute path outside the events root: refused. This is
        // the most direct vector — the renderer setting `SWARM_EVENT_FILE` to
        // `/etc/passwd` (or `/dev/log`, …).
        let root = scratch_root();
        assert!(validated_event_file_in(&root, "/etc/passwd").is_none());
    }

    #[test]
    fn clean_collapses_and_truncates() {
        assert_eq!(clean("  a\n\tb   c  "), "a b c");
        assert_eq!(clean("x\u{1b}\u{7}y"), "x y");
        assert_eq!(clean(&"a".repeat(300)).len(), MAX_LEN);
    }

    #[test]
    fn clean_strips_markdown() {
        // The reported bug: bold markers reached the banner verbatim.
        assert_eq!(clean("**Done** — all tests pass"), "Done — all tests pass");
        assert_eq!(clean("*italic* and _emphasis_"), "italic and emphasis");
        assert_eq!(clean("use `cargo test` to run"), "use cargo test to run");
        assert_eq!(clean("~~nope~~ yes"), "nope yes");
        // Links/images unwrap to their text.
        assert_eq!(clean("see [the docs](https://x.y)"), "see the docs");
        assert_eq!(clean("![alt text](img.png) shown"), "alt text shown");
        // Block markers across lines collapse into one line.
        assert_eq!(clean("# Heading\n\nbody text"), "Heading body text");
        assert_eq!(clean("> quoted reply"), "quoted reply");
        assert_eq!(clean("- one\n- two\n- three"), "one two three");
        assert_eq!(clean("1. first\n2. second"), "first second");
        // Code fences drop, their content stays.
        assert_eq!(clean("```rust\nlet x = 1;\n```"), "let x = 1;");
        assert_eq!(clean("text\n---\nmore"), "text more");
        // Non-emphasis underscores/asterisks survive.
        assert_eq!(clean("run snake_case_fn now"), "run snake_case_fn now");
        assert_eq!(clean("compute 2 * 3 = 6"), "compute 2 * 3 = 6");
    }

    #[test]
    fn claude_notification_message_extracts_message_field() {
        // The documented Notification-hook field — what Claude shows in its
        // own (now-disabled) banner. We surface it verbatim, sanitised.
        assert_eq!(
            claude_notification_message(
                r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#
            ),
            "Claude needs your permission to use Bash"
        );
    }

    #[test]
    fn claude_notification_message_strips_markdown_and_truncates() {
        // `clean` runs over the message so a TUI-friendly payload (newlines,
        // bold markers) doesn't reach the banner verbatim.
        assert_eq!(
            claude_notification_message(r#"{"message":"**Waiting**\nfor your input"}"#),
            "Waiting for your input"
        );
    }

    #[test]
    fn claude_notification_message_falls_back_when_missing_or_blank() {
        // Older Claude / unexpected schema: no `message` field → user still
        // sees a generic banner instead of nothing at all.
        assert_eq!(claude_notification_message(r#"{}"#), FALLBACK);
        assert_eq!(claude_notification_message(r#"{"message":""}"#), FALLBACK);
        assert_eq!(claude_notification_message("not json"), FALLBACK);
    }

    #[test]
    fn field_message_reads_codex_and_camel() {
        assert_eq!(
            field_message(r#"{"last-assistant-message":"Refactored\nthe parser."}"#).as_deref(),
            Some("Refactored the parser.")
        );
        assert_eq!(
            field_message(r#"{"lastAssistantMessage":"done"}"#).as_deref(),
            Some("done")
        );
        assert_eq!(field_message(r#"{"type":"x"}"#), None);
        assert_eq!(field_message("not json"), None);
    }

    #[test]
    fn transcript_extracts_last_assistant_text() {
        let dir = std::env::temp_dir().join(format!("swarm-notif-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(
            &p,
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"First.\"}]}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Done; all\\ntests pass.\"}]}}\n\
             {\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Continue from where you left off.\"}]}}\n\
             {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"No response requested.\"}]}}\n",
        )
        .unwrap();
        // The internal "No response requested." (answer to an isMeta user turn)
        // is skipped; the real last reply is returned.
        assert_eq!(
            last_assistant_from_transcript(p.to_str().unwrap()).as_deref(),
            Some("Done; all tests pass.")
        );
        // Tool-only last turn → None (so the caller falls back).
        std::fs::write(
            &p,
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}\n",
        )
        .unwrap();
        assert_eq!(last_assistant_from_transcript(p.to_str().unwrap()), None);
        // Missing file → None.
        assert_eq!(last_assistant_from_transcript("/no/such/file.jsonl"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
