// SPDX-License-Identifier: GPL-3.0-or-later
//! Turn-completion notification hooks for agents that have no isolated-config
//! override (Gemini, Cursor, OpenCode, Amp) — so, unlike Codex (CODEX_HOME), we
//! must write into the user's *real* config. Each hook re-invokes
//! `<swarm> --notify-helper event`, which forwards the agent's last message (or
//! "Turn complete") into SWARM_EVENT_FILE; outside swarm that var is unset and
//! the helper is a no-op, so a globally-installed hook is harmless.
//!
//! Writes are: gated on the agent's binary being on PATH (don't create config
//! for tools you don't have); idempotent (skip if our command is already
//! present); and defensive (never clobber an unparseable file or unrelated
//! keys). The OpenCode/Amp plugin files are ours, so we just (over)write them.
//! Claude/Codex are wired elsewhere. Best-effort: every failure is ignored.

use serde_json::{json, Value};
use std::path::PathBuf;

const MARKER: &str = "--notify-helper";

/// `"<bin>" --notify-helper event` — quoted so a path with spaces survives the
/// shell these agents run hook commands through.
fn hook_cmd(bin: &str) -> String {
    format!("\"{bin}\" --notify-helper event")
}

/// Install every supported agent's hook (those whose binary is on PATH).
pub fn install_all(bin: &str) {
    if crate::agents::on_path("claude") {
        let _ = install_claude_session_capture(bin);
    }
    if crate::agents::on_path("gemini") {
        let _ = install_gemini(bin);
        let _ = install_gemini_session_capture(bin);
    }
    if crate::agents::on_path("cursor-agent") {
        let _ = install_cursor(bin);
        let _ = install_cursor_session_capture(bin);
    }
    if crate::agents::on_path("opencode") {
        let _ = install_opencode(bin);
    }
    if crate::agents::on_path("amp") {
        let _ = install_amp(bin);
    }
}

/// Read a JSON file into an object, or `{}` if missing. Returns None (skip) if
/// the file exists but isn't a JSON object — we won't risk clobbering it.
fn read_object(path: &PathBuf) -> Option<serde_json::Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Some(serde_json::Map::new()),
        Ok(s) => serde_json::from_str::<Value>(&s).ok()?.as_object().cloned(),
        Err(_) => Some(serde_json::Map::new()),
    }
}

/// True if any `command` string under `arr` already contains our marker.
fn already_present(arr: &[Value]) -> bool {
    arr.iter().any(|v| {
        // Either a flat {command} entry, or a nested {hooks:[{command}]} group.
        let direct = v.get("command").and_then(Value::as_str);
        let nested = v.get("hooks").and_then(Value::as_array).map(|h| {
            h.iter().any(|e| {
                e.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(MARKER))
            })
        });
        direct.is_some_and(|c| c.contains(MARKER)) || nested.unwrap_or(false)
    })
}

fn write_pretty(path: &PathBuf, obj: &serde_json::Map<String, Value>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(&Value::Object(obj.clone()))?,
    )
}

/// `"<bin>" --notify-helper session-start <agent>` — an agent session-capture hook.
fn session_capture_cmd(bin: &str, agent: &str) -> String {
    format!("\"{bin}\" --notify-helper session-start {agent}")
}

/// True if a session-capture command is already wired in this hook array (match on
/// `session-start`, not the generic `--notify-helper` marker the notify hooks share).
fn has_session_capture(arr: &[Value]) -> bool {
    arr.iter().any(|v| {
        let direct = v.get("command").and_then(Value::as_str);
        let nested = v.get("hooks").and_then(Value::as_array).map(|h| {
            h.iter().any(|e| {
                e.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains("session-start"))
            })
        });
        direct.is_some_and(|c| c.contains("session-start")) || nested.unwrap_or(false)
    })
}

/// Claude: install a `SessionStart` hook into the user's *global*
/// `~/.claude/settings.json`. Unlike the per-invocation `--settings` swarm passes
/// to its own Claude launches, this fires for *any* `claude` started in a swarm
/// pane — including one typed by hand into a shell — so swarm can capture its
/// session id + flags and resume it (with `--dangerously-skip-permissions` etc.)
/// after a restart, the way cmux does. The helper is a no-op when `SWARM_PANE_ID`
/// is unset (i.e. outside swarm), so a globally-installed hook is harmless.
/// Idempotent (skips if our `session-start` command is already present) and
/// defensive (never clobbers an unparseable file or unrelated hooks).
fn install_claude_session_capture(bin: &str) -> Option<()> {
    let path = dirs::home_dir()?.join(".claude").join("settings.json");
    let mut root = read_object(&path)?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let starts = hooks
        .entry("SessionStart")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    if has_session_capture(starts) {
        return Some(());
    }
    starts.push(json!({
        "hooks": [{ "type": "command", "command": session_capture_cmd(bin, "claude"), "timeout": 10 }]
    }));
    write_pretty(&path, &root).ok()
}

/// Codex session-capture `hooks.json` content (nested format, `SessionStart` →
/// session-start). Written into swarm's isolated `CODEX_HOME` by `prepare_codex_home`.
/// The command here must match the one hashed for the trust entry (see below).
pub fn codex_session_hooks_json(bin: &str) -> String {
    let cmd = session_capture_cmd(bin, "codex");
    json!({
        "SessionStart": [ { "hooks": [ { "type": "command", "command": cmd, "timeout": 5000 } ] } ]
    })
    .to_string()
}

/// Codex won't run a `hooks.json` hook unless it's *trusted* in `config.toml` via a
/// `[hooks.state."<key>"] trusted_hash`. Returns that `(key, hash)`, ported exactly
/// from cmux's `codexHookTrustEntries` + `codexCommandHookHash`: the key is
/// `<realpath(hooks.json)>:<event_label>:<groupIndex>:<handlerIndex>`, the hash is
/// `sha256:` + SHA-256 of the hook identity JSON with **sorted keys** and no slash
/// escaping. SessionStart carries no matcher (cmux's nested format omits it).
pub fn codex_trust_entry(bin: &str, hooks_realpath: &str) -> (String, String) {
    let cmd = session_capture_cmd(bin, "codex");
    let key = format!("{hooks_realpath}:session_start:0:0");
    (key, codex_command_hook_hash(&cmd))
}

fn codex_command_hook_hash(command: &str) -> String {
    use sha2::{Digest, Sha256};
    // Build the identity JSON manually so the bytes match Codex's hashing exactly:
    // keys sorted (async<command<timeout<type ; event_name<hooks), compact, and
    // `/` left unescaped (serde_json, like Foundation's withoutEscapingSlashes,
    // does not escape it). serde_json string-encoding handles the embedded quotes.
    let cmd = serde_json::to_string(command).unwrap_or_else(|_| "\"\"".into());
    let identity = format!(
        "{{\"event_name\":\"session_start\",\"hooks\":[{{\"async\":false,\"command\":{cmd},\"timeout\":5000,\"type\":\"command\"}}]}}"
    );
    let hex: String = Sha256::digest(identity.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// Gemini: a `SessionStart` capture hook in `~/.gemini/settings.json` (nested
/// format, like its existing notify hook). Gemini's hook stdin carries `session_id`.
fn install_gemini_session_capture(bin: &str) -> Option<()> {
    let path = dirs::home_dir()?.join(".gemini").join("settings.json");
    let mut root = read_object(&path)?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let starts = hooks
        .entry("SessionStart")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    if has_session_capture(starts) {
        return Some(());
    }
    starts.push(json!({
        "hooks": [{ "type": "command", "command": session_capture_cmd(bin, "gemini"), "timeout": 10000 }]
    }));
    write_pretty(&path, &root).ok()
}

/// Cursor: `~/.cursor/hooks.json`, flat format. cursor-agent has no SessionStart
/// event, so we capture on `beforeSubmitPrompt` (the earliest event); its stdin
/// carries `conversation_id`, which is what `cursor-agent --resume` takes.
fn install_cursor_session_capture(bin: &str) -> Option<()> {
    let path = dirs::home_dir()?.join(".cursor").join("hooks.json");
    let mut root = read_object(&path)?;
    root.entry("version").or_insert_with(|| json!(1));
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let arr = hooks
        .entry("beforeSubmitPrompt")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    if has_session_capture(arr) {
        return Some(());
    }
    arr.push(json!({ "command": session_capture_cmd(bin, "cursor") }));
    write_pretty(&path, &root).ok()
}

/// Gemini: `~/.gemini/settings.json`, nested format, completion = `AfterAgent`.
fn install_gemini(bin: &str) -> Option<()> {
    let path = dirs::home_dir()?.join(".gemini").join("settings.json");
    let mut root = read_object(&path)?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let after = hooks
        .entry("AfterAgent")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    if already_present(after) {
        return Some(());
    }
    after.push(json!({
        "hooks": [{ "type": "command", "command": hook_cmd(bin), "timeout": 10000 }]
    }));
    write_pretty(&path, &root).ok()
}

/// Cursor: `~/.cursor/hooks.json`, flat format (`version: 1`), completion = `stop`.
fn install_cursor(bin: &str) -> Option<()> {
    let path = dirs::home_dir()?.join(".cursor").join("hooks.json");
    let mut root = read_object(&path)?;
    root.entry("version").or_insert_with(|| json!(1));
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()?;
    let stop = hooks
        .entry("stop")
        .or_insert_with(|| json!([]))
        .as_array_mut()?;
    if already_present(stop) {
        return Some(());
    }
    stop.push(json!({ "command": hook_cmd(bin) }));
    write_pretty(&path, &root).ok()
}

/// OpenCode: a plugin we own at `~/.config/opencode/plugins/swarm-session.js`.
/// It fires our helper when a session goes idle. OpenCode's idle event carries
/// no assistant text, so the body is the "Turn complete" fallback.
fn install_opencode(bin: &str) -> Option<()> {
    let dir = dirs::home_dir()?
        .join(".config")
        .join("opencode")
        .join("plugins");
    std::fs::create_dir_all(&dir).ok()?;
    let js = OPENCODE_PLUGIN.replace("__SWARM_BIN__", &serde_json::to_string(bin).ok()?);
    std::fs::write(dir.join("swarm-session.js"), js).ok()
}

/// Amp: a plugin we own at `~/.config/amp/plugins/swarm-session.ts`. Fires on
/// `agent.end`; no assistant text available → "Turn complete" fallback.
fn install_amp(bin: &str) -> Option<()> {
    let dir = dirs::home_dir()?
        .join(".config")
        .join("amp")
        .join("plugins");
    std::fs::create_dir_all(&dir).ok()?;
    let ts = AMP_PLUGIN.replace("__SWARM_BIN__", &serde_json::to_string(bin).ok()?);
    std::fs::write(dir.join("swarm-session.ts"), ts).ok()
}

// OpenCode's idle event carries no assistant text, so — like cmux — we track it
// ourselves off the event bus: `message.updated` records each message's role,
// `message.part.updated` accumulates the latest assistant text, and on idle we
// hand that to the helper (stdin) as the notification body. One OpenCode process
// per pane, so a single module-level `latest` is the right session's text.
const OPENCODE_PLUGIN: &str = r#"// swarm notification plugin — auto-generated. Forwards turn completion to swarm.
import { spawnSync } from "node:child_process";
const SWARM_BIN = __SWARM_BIN__;
const roles = new Map(); // messageID -> role
let latest = ""; // most recent assistant text in this process (= this pane)
const norm = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().slice(0, 1000);
// Session capture for cmux-style resume: record this pane's OpenCode session id
// the first time we see it, so swarm can `opencode --session <id>` on restart.
const captured = new Set();
const sidFor = (event, props) => {
  const info = props.info || {};
  const sess = props.session || {};
  return info.id || props.sessionID || props.sessionId || props.session_id ||
    sess.id || event.sessionID || event.sessionId || event.id || null;
};
const capture = (sid) => {
  if (!sid || captured.has(sid) || !process.env.SWARM_PANE_ID) return;
  captured.add(sid);
  try {
    spawnSync(SWARM_BIN, ["--notify-helper", "session-start", "opencode"], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd() }),
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5000,
    });
  } catch (_) {}
};
const SwarmSession = async () => ({
  event: async ({ event }) => {
    const type = event && event.type;
    const props = (event && event.properties) || {};
    capture(sidFor(event, props));
    if (type === "message.updated") {
      const info = props.info || props.message || {};
      const id = info.id || props.messageID;
      const role = info.role || props.role;
      if (id && role) roles.set(id, role);
      if (roles.size > 300) roles.delete(roles.keys().next().value);
      return;
    }
    if (type === "message.part.updated") {
      const part = props.part || {};
      if (part.type !== "text" || !part.messageID) return;
      if (roles.get(part.messageID) !== "assistant") return;
      const text = norm(part.text || part.textDelta || part.content);
      if (text) latest = text;
      return;
    }
    const idle = type === "session.idle" ||
      (type === "session.status" && props?.status?.type === "idle");
    if (!idle || !process.env.SWARM_EVENT_FILE) return;
    try {
      spawnSync(SWARM_BIN, ["--notify-helper", "event"], {
        input: JSON.stringify({ lastAssistantMessage: latest }),
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
      });
    } catch (_) {}
  },
});
export { SwarmSession };
export default SwarmSession;
"#;

const AMP_PLUGIN: &str = r#"// swarm notification plugin — auto-generated. Forwards turn completion to swarm.
import { spawn } from "node:child_process";
const SWARM_BIN = __SWARM_BIN__;
const fire = (args, payload) => {
  try {
    const c = spawn(SWARM_BIN, args, { stdio: ["pipe", "ignore", "ignore"], detached: true });
    c.on("error", () => {});
    c.stdin.on("error", () => {});
    c.stdin.end(payload);
    c.unref();
  } catch (_) {}
};
// Session capture for cmux-style resume: Amp's session id is the thread id; record
// it the first time we see it so swarm can `amp threads continue <id>` on restart.
const captured = new Set();
const captureThread = (event, ctx) => {
  const sid = (event && event.thread && event.thread.id) || (ctx && ctx.thread && ctx.thread.id);
  if (!sid || captured.has(sid) || !process.env.SWARM_PANE_ID) return;
  captured.add(sid);
  fire(["--notify-helper", "session-start", "amp"], JSON.stringify({ session_id: sid, cwd: process.cwd() }));
};
export default function (amp) {
  amp.on("session.start", async (event, ctx) => captureThread(event, ctx));
  amp.on("agent.start", async (event, ctx) => captureThread(event, ctx));
  amp.on("agent.end", async () => {
    if (!process.env.SWARM_EVENT_FILE) return;
    fire(["--notify-helper", "event"], "{}");
  });
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_merge_is_idempotent_and_nonclobbering() {
        let dir = std::env::temp_dir().join(format!("swarm-gemini-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(".gemini").join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Pre-existing unrelated user setting must survive.
        std::fs::write(&path, r#"{"theme":"dark","hooks":{"AfterAgent":[]}}"#).unwrap();

        let merge = |p: &PathBuf| -> Option<()> {
            let mut root = read_object(p)?;
            let hooks = root
                .entry("hooks")
                .or_insert_with(|| json!({}))
                .as_object_mut()?;
            let after = hooks
                .entry("AfterAgent")
                .or_insert_with(|| json!([]))
                .as_array_mut()?;
            if already_present(after) {
                return Some(());
            }
            after.push(json!({ "hooks": [{ "type": "command", "command": hook_cmd("/b"), "timeout": 10000 }] }));
            write_pretty(p, &root).ok()
        };
        merge(&path).unwrap();
        merge(&path).unwrap(); // second run: idempotent

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark"); // unrelated key preserved
        let after = v["hooks"]["AfterAgent"].as_array().unwrap();
        assert_eq!(after.len(), 1); // not duplicated
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_trust_hash_matches_documented_algorithm() {
        // Golden value: SHA-256 of the sorted-key, slash-unescaped hook identity
        // JSON (cross-checked with an independent implementation). If this drifts,
        // Codex will silently reject the hook as untrusted.
        let cmd = session_capture_cmd("/bin/swarm", "codex");
        assert_eq!(cmd, "\"/bin/swarm\" --notify-helper session-start codex");
        assert_eq!(
            codex_command_hook_hash(&cmd),
            "sha256:8b1624c88248a1b823c703a18cbd0ee63b35f2e0a8fffcb4da7c156be1be9a1b"
        );
        let (key, hash) = codex_trust_entry("/bin/swarm", "/home/u/.swarm/codex-home/hooks.json");
        assert_eq!(
            key,
            "/home/u/.swarm/codex-home/hooks.json:session_start:0:0"
        );
        assert!(hash.starts_with("sha256:"));
    }

    #[test]
    fn read_object_refuses_non_object() {
        let dir = std::env::temp_dir().join(format!("swarm-nonobj-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.json");
        std::fs::write(&path, "[1,2,3]").unwrap();
        assert!(read_object(&path).is_none()); // array → skip, don't clobber
        let _ = std::fs::remove_dir_all(&dir);
    }
}
