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
    if crate::agents::on_path("gemini") {
        let _ = install_gemini(bin);
    }
    if crate::agents::on_path("cursor-agent") {
        let _ = install_cursor(bin);
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
const SwarmSession = async () => ({
  event: async ({ event }) => {
    const type = event && event.type;
    const props = (event && event.properties) || {};
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
export default function (amp) {
  amp.on("agent.end", async () => {
    if (!process.env.SWARM_EVENT_FILE) return;
    try {
      const c = spawn(SWARM_BIN, ["--notify-helper", "event"], {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      });
      c.on("error", () => {});
      c.stdin.on("error", () => {});
      c.stdin.end("{}");
      c.unref();
    } catch (_) {}
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
    fn read_object_refuses_non_object() {
        let dir = std::env::temp_dir().join(format!("swarm-nonobj-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.json");
        std::fs::write(&path, "[1,2,3]").unwrap();
        assert!(read_object(&path).is_none()); // array → skip, don't clobber
        let _ = std::fs::remove_dir_all(&dir);
    }
}
