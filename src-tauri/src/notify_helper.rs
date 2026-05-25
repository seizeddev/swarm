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

// OSC 777 title for our Claude Stop-hook notification. A sentinel (not the
// display name) so the frontend can accept *only* our notification on a Claude
// pane and drop Claude Code's own — see CLAUDE_NOTIF_SENTINEL in store.ts. The
// UI shows the pane title ("Claude Code"), not this token.
const AGENT_NAME: &str = "swarm-claude";
const FALLBACK: &str = "Turn complete";
const MAX_LEN: usize = 200;

/// Entry point. `args` are everything after `--notify-helper`. Never panics —
/// any failure degrades to the fallback (or silence) so a hook never errors out.
pub fn run(args: &[String]) {
    let mode = args.first().map(String::as_str).unwrap_or("");
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
            if let Ok(path) = std::env::var("SWARM_EVENT_FILE") {
                if !path.is_empty() {
                    use std::io::Write;
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                    {
                        let _ = writeln!(f, "{msg}");
                    }
                }
            }
        }
        _ => {}
    }
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

/// Collapse all whitespace/control characters to single spaces, trim, and cap at
/// MAX_LEN characters — so the body is one tidy notification line.
fn clean(s: &str) -> String {
    let collapsed: String = s
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_collapses_and_truncates() {
        assert_eq!(clean("  a\n\tb   c  "), "a b c");
        assert_eq!(clean("x\u{1b}\u{7}y"), "x y");
        assert_eq!(clean(&"a".repeat(300)).len(), MAX_LEN);
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
