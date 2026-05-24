// SPDX-License-Identifier: GPL-3.0-or-later
//! OSC 9 / 99 / 777 desktop-notification parsing — pure byte scanning with no
//! Tauri/terminal-engine deps, so it can be fuzzed standalone (the fuzz target
//! `#[path]`-includes this file directly; see `fuzz/fuzz_targets/`).

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// OSC 99 chunk buffers, carried across reads.
#[derive(Default)]
pub struct NotifState {
    id: Option<String>,
    title: String,
    body: String,
}

/// Parse OSC 9 / 99 / 777 desktop-notification sequences from a chunk and
/// return the completed `(title, body)` pairs. OSC 99 (kitty) chunks are
/// buffered across calls in `st`. Pure — no side effects, so it's unit-tested
/// (and fuzzed: see `fuzz/fuzz_targets/parse_notifications.rs`).
pub fn parse_notifications(bytes: &[u8], st: &mut NotifState) -> Vec<(String, String)> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
