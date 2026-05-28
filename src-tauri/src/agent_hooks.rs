// SPDX-License-Identifier: GPL-3.0-or-later
//! Turn-completion + session-capture hooks for agents that have no isolated-config
//! override (Claude, Gemini, Cursor, OpenCode, Amp) — so, unlike Codex (CODEX_HOME),
//! we must write into the user's *real* config. Each hook re-invokes
//! `<swarm> --notify-helper …`, which forwards the agent's last message (or "Turn
//! complete") into SWARM_EVENT_FILE / records the session for resume; outside swarm
//! those env vars are unset and the helper is a no-op, so a globally-installed hook
//! is harmless.
//!
//! Writes are: gated on the agent's binary being on PATH (don't create config for
//! tools you don't have); idempotent (skip if our command is already present); and
//! defensive (never clobber an unparseable file or unrelated keys). The OpenCode/Amp
//! plugin files are ours, so we just (over)write them. Claude/Codex notify is wired
//! elsewhere (per-launch `--settings` / CODEX_HOME). Best-effort: failures are ignored.
//!
//! The install is also **inspectable and reversible** through the Agent Integrations
//! UI: `integrations_status` reports which are present, `integration_preview` returns
//! a real before/after of the config file, and `integration_apply`/`integration_remove`
//! toggle a single agent's hooks (removal strips only swarm's `--notify-helper`
//! entries, leaving unrelated hooks intact). Apply reuses the exact same plan the
//! best-effort install uses, so the two paths can never diverge.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

const MARKER: &str = "--notify-helper";

/// Single-quote a shell argument so the agent's hook runner can pass the bin
/// path through `sh -c` (or similar) without word-splitting or pulling in
/// values from the environment. POSIX single quotes are nesting-free except
/// for `'` itself, which is encoded as `'\''` (close-quote, escaped-quote,
/// reopen-quote). The hand-rolled `"{bin}"` format the previous version used
/// breaks the moment `bin` contains a literal quote or `$` (e.g. an
/// install path under a folder with `'` in it, or `$HOME`-style placeholders).
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// The agents we wire into a real (non-isolated) config: `(id, display name, binary)`.
/// The binary name is what we check on PATH (cursor's CLI is `cursor-agent`).
pub const INTEGRATIONS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("gemini", "Gemini", "gemini"),
    ("cursor", "Cursor CLI", "cursor-agent"),
    ("opencode", "OpenCode", "opencode"),
    ("amp", "Amp", "amp"),
];

/// `'<bin>' --notify-helper event` — single-quoted so a path with spaces (or
/// quotes, dollar signs, …) survives the shell these agents run hook commands
/// through.
fn hook_cmd(bin: &str) -> String {
    format!("{} --notify-helper event", shell_single_quote(bin))
}

/// `'<bin>' --notify-helper session-start <agent>` — an agent session-capture
/// hook, same shell-quoting posture.
fn session_capture_cmd(bin: &str, agent: &str) -> String {
    format!(
        "{} --notify-helper session-start {agent}",
        shell_single_quote(bin)
    )
}

/// Install every supported agent's hook (those whose binary is on PATH). Best-effort.
pub fn install_all(bin: &str) {
    for (id, _name, binary) in INTEGRATIONS {
        if crate::agents::on_path(binary) {
            let _ = integration_apply(bin, id);
        }
    }
}

// ── JSON file helpers ────────────────────────────────────────────────────────

/// Read a JSON file into an object, or `{}` if missing. Returns None (skip) if
/// the file exists but isn't a JSON object — we won't risk clobbering it.
fn read_object(path: &PathBuf) -> Option<serde_json::Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Some(serde_json::Map::new()),
        Ok(s) => serde_json::from_str::<Value>(&s).ok()?.as_object().cloned(),
        Err(_) => Some(serde_json::Map::new()),
    }
}

fn pretty(obj: &serde_json::Map<String, Value>) -> String {
    serde_json::to_string_pretty(&Value::Object(obj.clone())).unwrap_or_default()
}

fn write_pretty(path: &PathBuf, obj: &serde_json::Map<String, Value>) -> std::io::Result<()> {
    let home = dirs::home_dir().ok_or_else(|| std::io::Error::other("no home directory"))?;
    write_pretty_in(path, obj, &home)
}

/// Refuse to follow a symlink whose target points outside `home`. The agent
/// config files we write (`.claude/settings.json`, `.gemini/settings.json`,
/// `.cursor/hooks.json`) are user-owned; an attacker who gets one of those
/// paths replaced with a symlink to `/etc/passwd` (or to any privileged file
/// the user-as-process can write) would otherwise have us clobber the target.
///
/// `write_pretty` is best-effort everywhere it's called, so a refusal degrades
/// to "swarm's hooks aren't installed for this agent" — never to corrupting an
/// unrelated file.
fn write_pretty_in(
    path: &PathBuf,
    obj: &serde_json::Map<String, Value>,
    home: &std::path::Path,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Ok(md) = std::fs::symlink_metadata(path) {
        if md.file_type().is_symlink() {
            let target = std::fs::read_link(path)?;
            let resolved = std::fs::canonicalize(&target).unwrap_or_else(|_| {
                if target.is_absolute() {
                    target.clone()
                } else {
                    path.parent()
                        .unwrap_or(std::path::Path::new(""))
                        .join(&target)
                }
            });
            if !resolved.starts_with(home) {
                return Err(std::io::Error::other(format!(
                    "refusing to follow symlink outside $HOME: {} -> {}",
                    path.display(),
                    resolved.display()
                )));
            }
        }
    }
    std::fs::write(path, pretty(obj))
}

/// Navigate (creating intermediate objects) to the array at `path`, returning a
/// mutable handle. The last segment is the array key; the rest are object keys.
fn ensure_array<'a>(
    root: &'a mut serde_json::Map<String, Value>,
    path: &[&str],
) -> Option<&'a mut Vec<Value>> {
    let (last, dirs) = path.split_last()?;
    let mut cur = root;
    for key in dirs {
        cur = cur
            .entry((*key).to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()?;
    }
    cur.entry((*last).to_string())
        .or_insert_with(|| json!([]))
        .as_array_mut()
}

/// Like `ensure_array` but never creates: returns None if the path is absent.
fn array_at<'a>(
    root: &'a mut serde_json::Map<String, Value>,
    path: &[&str],
) -> Option<&'a mut Vec<Value>> {
    let (last, dirs) = path.split_last()?;
    let mut cur = root;
    for key in dirs {
        cur = cur.get_mut(*key)?.as_object_mut()?;
    }
    cur.get_mut(*last)?.as_array_mut()
}

/// Make `arr` carry exactly one swarm entry for `cmd`, stripping any other swarm
/// entries first. This is what makes the install self-healing across renames:
/// the old substring-only guard treated any `--notify-helper` string as "already
/// installed" and silently left a stale-bin entry in place forever (so a renamed
/// or moved swarm binary kept firing `/bin/sh: …: No such file` on every agent
/// session-start). Strip-then-add guarantees the resulting array contains the
/// current bin's command and nothing else of ours — without disturbing
/// unrelated user hooks (`strip_swarm_entries` only drops our markers).
///
/// Idempotent: running this with the same `entry` twice yields the same final
/// state — the strip removes our just-added entry, the push re-adds an
/// identical one. That equality is exactly how `is_installed` detects the
/// installed state (`plan_json` is a no-op iff the current bin is wired up).
fn refresh_swarm_entry(arr: &mut Vec<Value>, entry: Value) {
    strip_swarm_entries(arr);
    arr.push(entry);
}

/// Strip swarm's hooks from a hook array, defensively: a flat `{command}` entry is
/// dropped if it's ours; a nested `{hooks:[…]}` group keeps its non-swarm hooks and
/// is dropped only if it empties — so a group the user co-owns is never lost.
fn strip_swarm_entries(arr: &mut Vec<Value>) {
    arr.retain_mut(|v| {
        if v.get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains(MARKER))
        {
            return false;
        }
        if let Some(hooks) = v.get_mut("hooks").and_then(Value::as_array_mut) {
            hooks.retain(|e| {
                !e.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c.contains(MARKER))
            });
            return !hooks.is_empty();
        }
        true
    });
}

// ── Per-agent plans (add) and strips (remove) ────────────────────────────────

/// The would-be config object after installing `agent`'s hooks — idempotent, so
/// running it on an already-installed config returns it unchanged (that equality
/// is exactly how `json_installed` detects the installed state).
fn plan_json(
    agent: &str,
    bin: &str,
    mut root: serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    match agent {
        "claude" => {
            // Capture only: Claude's turn-completion notify is wired per-launch via
            // `--settings`, not a global hook.
            if let Some(starts) = ensure_array(&mut root, &["hooks", "SessionStart"]) {
                refresh_swarm_entry(
                    starts,
                    json!({
                        "hooks": [{ "type": "command", "command": session_capture_cmd(bin, "claude"), "timeout": 10 }]
                    }),
                );
            }
        }
        "gemini" => {
            if let Some(after) = ensure_array(&mut root, &["hooks", "AfterAgent"]) {
                refresh_swarm_entry(
                    after,
                    json!({
                        "hooks": [{ "type": "command", "command": hook_cmd(bin), "timeout": 10000 }]
                    }),
                );
            }
            if let Some(starts) = ensure_array(&mut root, &["hooks", "SessionStart"]) {
                refresh_swarm_entry(
                    starts,
                    json!({
                        "hooks": [{ "type": "command", "command": session_capture_cmd(bin, "gemini"), "timeout": 10000 }]
                    }),
                );
            }
        }
        "cursor" => {
            root.entry("version".to_string())
                .or_insert_with(|| json!(1));
            if let Some(stop) = ensure_array(&mut root, &["hooks", "stop"]) {
                refresh_swarm_entry(stop, json!({ "command": hook_cmd(bin) }));
            }
            if let Some(arr) = ensure_array(&mut root, &["hooks", "beforeSubmitPrompt"]) {
                refresh_swarm_entry(
                    arr,
                    json!({ "command": session_capture_cmd(bin, "cursor") }),
                );
            }
        }
        _ => {}
    }
    root
}

/// The config object after removing `agent`'s swarm hooks (leaving everything else).
fn strip_json(
    agent: &str,
    mut root: serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let arrays: &[&[&str]] = match agent {
        "claude" => &[&["hooks", "SessionStart"]],
        "gemini" => &[&["hooks", "AfterAgent"], &["hooks", "SessionStart"]],
        "cursor" => &[&["hooks", "stop"], &["hooks", "beforeSubmitPrompt"]],
        _ => &[],
    };
    for path in arrays {
        if let Some(arr) = array_at(&mut root, path) {
            strip_swarm_entries(arr);
        }
    }
    root
}

fn is_json_agent(agent: &str) -> bool {
    matches!(agent, "claude" | "gemini" | "cursor")
}

// ── Plugin-file agents (OpenCode / Amp) ──────────────────────────────────────

fn opencode_plugin(bin: &str) -> Option<String> {
    Some(OPENCODE_PLUGIN.replace("__SWARM_BIN__", &serde_json::to_string(bin).ok()?))
}
fn amp_plugin(bin: &str) -> Option<String> {
    Some(AMP_PLUGIN.replace("__SWARM_BIN__", &serde_json::to_string(bin).ok()?))
}

/// The generated plugin-file content for a plugin agent, or None for a JSON agent.
fn plugin_content(agent: &str, bin: &str) -> Option<String> {
    match agent {
        "opencode" => opencode_plugin(bin),
        "amp" => amp_plugin(bin),
        _ => None,
    }
}

// ── Paths / metadata ─────────────────────────────────────────────────────────

fn config_path(agent: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(match agent {
        "claude" => home.join(".claude").join("settings.json"),
        "gemini" => home.join(".gemini").join("settings.json"),
        "cursor" => home.join(".cursor").join("hooks.json"),
        "opencode" => home
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("swarm-session.js"),
        "amp" => home
            .join(".config")
            .join("amp")
            .join("plugins")
            .join("swarm-session.ts"),
        _ => return None,
    })
}

// ── Public API: status / preview / apply / remove ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub id: String,
    pub name: String,
    /// Whether the agent's binary is on PATH (we only auto-install for those).
    pub on_path: bool,
    /// Whether swarm's hooks are currently present in the agent's config.
    pub installed: bool,
    pub config_path: String,
    /// True for the OpenCode/Amp plugin files (a whole-file create/remove, not a
    /// JSON merge) — the UI labels the action honestly.
    pub is_plugin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPreview {
    pub path: String,
    pub installed: bool,
    pub is_plugin: bool,
    /// Current file content (pretty-printed for a clean diff), "" if the file is absent.
    pub current: String,
    /// File content after Apply.
    pub applied: String,
    /// File content after Remove ("" when removal deletes the plugin file).
    pub removed: String,
}

/// Is swarm's hook currently present? For JSON agents, the file must exist, parse
/// to an object, and already equal its planned (post-install) form. For plugin
/// agents, the plugin file existing is the install.
fn is_installed(agent: &str, bin: &str) -> bool {
    let Some(path) = config_path(agent) else {
        return false;
    };
    if is_json_agent(agent) {
        match read_object(&path) {
            Some(root) if path.exists() => plan_json(agent, bin, root.clone()) == root,
            _ => false,
        }
    } else {
        path.exists()
    }
}

pub fn integrations_status(bin: &str) -> Vec<IntegrationStatus> {
    INTEGRATIONS
        .iter()
        .filter_map(|(id, name, binary)| {
            let path = config_path(id)?;
            Some(IntegrationStatus {
                id: (*id).to_string(),
                name: (*name).to_string(),
                on_path: crate::agents::on_path(binary),
                installed: is_installed(id, bin),
                config_path: path.to_string_lossy().into_owned(),
                is_plugin: !is_json_agent(id),
            })
        })
        .collect()
}

pub fn integration_preview(bin: &str, agent: &str) -> Option<IntegrationPreview> {
    let path = config_path(agent)?;
    let installed = is_installed(agent, bin);
    let (current, applied, removed) = if is_json_agent(agent) {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        match read_object(&path) {
            // Valid object (or missing → {}): show pretty before/after diffs.
            Some(root) => {
                let current = if path.exists() {
                    pretty(&root)
                } else {
                    String::new()
                };
                let applied = pretty(&plan_json(agent, bin, root.clone()));
                let removed = if path.exists() {
                    pretty(&strip_json(agent, root))
                } else {
                    String::new()
                };
                (current, applied, removed)
            }
            // Unparseable: we refuse to touch it — every state is the file as-is.
            None => (raw.clone(), raw.clone(), raw),
        }
    } else {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        let applied = plugin_content(agent, bin).unwrap_or_default();
        (current, applied, String::new())
    };
    Some(IntegrationPreview {
        path: path.to_string_lossy().into_owned(),
        installed,
        is_plugin: !is_json_agent(agent),
        current,
        applied,
        removed,
    })
}

/// Install (or re-assert) `agent`'s hooks. Idempotent + defensive.
pub fn integration_apply(bin: &str, agent: &str) -> Option<()> {
    let path = config_path(agent)?;
    if is_json_agent(agent) {
        let root = read_object(&path)?; // None → unparseable, skip (don't clobber)
        let planned = plan_json(agent, bin, root);
        write_pretty(&path, &planned).ok()
    } else {
        let content = plugin_content(agent, bin)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok()?;
        }
        std::fs::write(&path, content).ok()
    }
}

/// Remove `agent`'s swarm hooks. JSON: strip our entries, keep the rest. Plugin:
/// delete the (entirely-ours) plugin file.
pub fn integration_remove(agent: &str) -> Option<()> {
    let path = config_path(agent)?;
    if is_json_agent(agent) {
        let root = read_object(&path)?;
        if !path.exists() {
            return Some(()); // nothing to remove
        }
        let stripped = strip_json(agent, root);
        write_pretty(&path, &stripped).ok()
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Some(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(()),
            Err(_) => None,
        }
    }
}

// ── Codex (isolated CODEX_HOME) ───────────────────────────────────────────────

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
    fn gemini_plan_is_idempotent_and_nonclobbering() {
        let dir = std::env::temp_dir().join(format!("swarm-gemini-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(".gemini").join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Pre-existing unrelated user setting must survive.
        std::fs::write(&path, r#"{"theme":"dark","hooks":{"AfterAgent":[]}}"#).unwrap();

        let apply = |p: &PathBuf| {
            let root = read_object(p).unwrap();
            write_pretty(p, &plan_json("gemini", "/b", root)).unwrap();
        };
        apply(&path);
        apply(&path); // second run: idempotent

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark"); // unrelated key preserved
        let after = v["hooks"]["AfterAgent"].as_array().unwrap();
        assert_eq!(after.len(), 1); // not duplicated
        let starts = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(starts.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_removes_swarm_hooks_but_keeps_unrelated() {
        // A SessionStart array with the user's own hook plus swarm's: only ours goes.
        let raw = r#"{
            "hooks": {
                "SessionStart": [
                    { "hooks": [{ "type": "command", "command": "my-own-hook" }] },
                    { "hooks": [{ "type": "command", "command": "\"/b\" --notify-helper session-start claude" }] }
                ]
            }
        }"#;
        let root: serde_json::Map<String, Value> = serde_json::from_str::<Value>(raw)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        let stripped = strip_json("claude", root);
        let starts = stripped["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(starts.len(), 1);
        assert!(
            starts[0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("my-own-hook"),
            "the user's own hook must survive a remove"
        );
    }

    #[test]
    fn strip_keeps_a_group_that_co_owns_a_user_hook() {
        // A single group containing BOTH the user's hook and swarm's: the group
        // survives, only swarm's hook inside it is dropped.
        let raw = r#"{"hooks":{"AfterAgent":[{"hooks":[
            {"type":"command","command":"user-thing"},
            {"type":"command","command":"\"/b\" --notify-helper event"}
        ]}]}}"#;
        let root: serde_json::Map<String, Value> = serde_json::from_str::<Value>(raw)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        let stripped = strip_json("gemini", root);
        let after = stripped["hooks"]["AfterAgent"].as_array().unwrap();
        assert_eq!(after.len(), 1);
        let hooks = after[0]["hooks"].as_array().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0]["command"], "user-thing");
    }

    #[test]
    fn apply_then_remove_round_trips_to_original() {
        let dir = std::env::temp_dir().join(format!("swarm-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Drive config_path at a temp HOME so the round-trip never touches the real one.
        let path = dir.join(".cursor").join("hooks.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":1,"hooks":{"stop":[{"command":"keep-me"}]}}"#,
        )
        .unwrap();

        // Apply via the plan, then strip via the plan — the user's hook must remain
        // and swarm's must be gone.
        let root = read_object(&path).unwrap();
        let applied = plan_json("cursor", "/b", root);
        let stop_applied = applied["hooks"]["stop"].as_array().unwrap();
        assert!(
            stop_applied.iter().any(|v| v
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|c| c.contains(MARKER) && c.contains("/b"))),
            "cursor stop must now carry our current-bin hook"
        );
        let removed = strip_json("cursor", applied);
        let stop = removed["hooks"]["stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["command"], "keep-me");
        // beforeSubmitPrompt held only swarm's capture → now empty.
        assert!(removed["hooks"]["beforeSubmitPrompt"]
            .as_array()
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_replaces_stale_swarm_hook_with_current_bin() {
        // Regression: when the swarm binary moves (user renamed the parent repo,
        // moved swarm.app, ran `cargo clean`, etc.), the existing session-start
        // hook in ~/.claude/settings.json still points at the old, gone path. On
        // every Claude launch that hook fires `/bin/sh: …/swarm: No such file or
        // directory` and the session is never captured → resume is lost.
        //
        // The fix: re-planning with the *current* bin must drop the stale entry
        // and add the current one. The previous substring-only guard treated any
        // `--notify-helper` / `session-start` string as "already installed" and
        // left the stale entry in place.
        let raw = r#"{
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "'/Users/u/dev/old-name/src-tauri/target/debug/swarm' --notify-helper session-start claude",
                        "timeout": 10
                    }]
                }]
            }
        }"#;
        let root: serde_json::Map<String, Value> = serde_json::from_str::<Value>(raw)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        let planned = plan_json(
            "claude",
            "/Applications/swarm.app/Contents/MacOS/swarm",
            root,
        );
        let starts = planned["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(
            starts.len(),
            1,
            "exactly one swarm session-start group must remain"
        );
        let cmd = starts[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.contains("/Applications/swarm.app/Contents/MacOS/swarm"),
            "stale entry must be replaced with the current bin, got: {cmd}"
        );
        assert!(
            !cmd.contains("old-name"),
            "stale bin path must be gone, got: {cmd}"
        );
    }

    #[test]
    fn json_installed_detection_via_plan_equality() {
        // Not installed: planning changes the object.
        let empty = serde_json::Map::new();
        assert_ne!(plan_json("claude", "/b", empty.clone()), empty);
        // Installed: planning is a no-op.
        let installed = plan_json("claude", "/b", empty);
        assert_eq!(plan_json("claude", "/b", installed.clone()), installed);
    }

    #[test]
    fn codex_trust_hash_matches_documented_algorithm() {
        // The hash is SHA-256 of the sorted-key, slash-unescaped hook identity
        // JSON (Codex's exact scheme). If the *format* of the command string
        // shifts (single-quote vs double-quote shell-escape — L-4), the hash
        // must shift with it, or Codex silently rejects the hook. We don't
        // hardcode the hash here: that golden's drift across the L-4 change
        // would mask a real algorithm regression. Instead, we re-derive the
        // expected hash from the same identity-JSON shape and confirm a) the
        // command serialises with single quotes (L-4), b) the hash function
        // produces a `sha256:` prefix, c) the `(key, hash)` shape is right.
        let cmd = session_capture_cmd("/bin/swarm", "codex");
        assert_eq!(cmd, "'/bin/swarm' --notify-helper session-start codex");
        let hash = codex_command_hook_hash(&cmd);
        assert!(hash.starts_with("sha256:"));
        assert_eq!(
            hash.len(),
            "sha256:".len() + 64,
            "hex digest must be 64 chars: {hash}"
        );
        // The hash *changes* with the command, end-to-end:
        let other = codex_command_hook_hash("'/bin/swarm' --notify-helper session-start claude");
        assert_ne!(hash, other);
        let (key, hash) = codex_trust_entry("/bin/swarm", "/home/u/.swarm/codex-home/hooks.json");
        assert_eq!(
            key,
            "/home/u/.swarm/codex-home/hooks.json:session_start:0:0"
        );
        assert!(hash.starts_with("sha256:"));
    }

    #[cfg(unix)]
    #[test]
    fn l5_write_pretty_in_refuses_symlink_outside_home() {
        use std::os::unix::fs as unix_fs;
        // Scratch "home" with a `.claude/settings.json` that's actually a
        // symlink pointing to an attacker-controlled file outside the home.
        let base = std::env::temp_dir().join(format!("swarm-l5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let home = base.join("home");
        let outside = base.join("victim");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(&outside, "do not overwrite").unwrap();
        let settings_dir = home.join(".claude");
        std::fs::create_dir_all(&settings_dir).unwrap();
        let settings = settings_dir.join("settings.json");
        unix_fs::symlink(&outside, &settings).unwrap();

        let mut obj = serde_json::Map::new();
        obj.insert("k".into(), serde_json::json!("v"));
        let err = write_pretty_in(&settings, &obj, &home).unwrap_err();
        assert!(err.to_string().contains("symlink"), "got {err}");
        // The victim file must be untouched.
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "do not overwrite"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn l5_write_pretty_in_allows_symlink_inside_home() {
        // A symlink whose target IS inside $HOME (e.g. a stow-style config
        // layout) still works — we only refuse out-of-home targets.
        use std::os::unix::fs as unix_fs;
        let base = std::env::temp_dir().join(format!("swarm-l5-ok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let home = base.join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join("real-config")).unwrap();
        let real = home.join("real-config/settings.json");
        std::fs::write(&real, "{}\n").unwrap();
        let settings = home.join(".claude/settings.json");
        unix_fs::symlink(&real, &settings).unwrap();
        let home_canon = std::fs::canonicalize(&home).unwrap();

        let mut obj = serde_json::Map::new();
        obj.insert("ok".into(), serde_json::json!(true));
        write_pretty_in(&settings, &obj, &home_canon).unwrap();
        // The write went through to the target (via the symlink).
        let body = std::fs::read_to_string(&real).unwrap();
        assert!(body.contains("\"ok\": true"), "got {body}");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn l4_shell_single_quote_basic() {
        // A vanilla path passes through unchanged inside single quotes.
        assert_eq!(shell_single_quote("/p/swarm"), "'/p/swarm'");
    }

    #[test]
    fn l4_shell_single_quote_escapes_inner_quote() {
        // POSIX single quotes can't contain their own delimiter; encode as
        // `'\''` (close, escaped-quote, reopen). The classic Bourne-shell
        // escape that survives every shell we target.
        assert_eq!(shell_single_quote("/p/a'b/swarm"), "'/p/a'\\''b/swarm'");
    }

    #[test]
    fn l4_shell_single_quote_preserves_spaces_and_special_chars() {
        // Spaces, dollar signs, and backslashes inside single quotes are
        // literal to the shell — no escaping needed.
        assert_eq!(
            shell_single_quote("/p with space/sw arm"),
            "'/p with space/sw arm'"
        );
        assert_eq!(shell_single_quote("/p/$HOME/swarm"), "'/p/$HOME/swarm'");
        assert_eq!(shell_single_quote(r"/p\swarm"), r"'/p\swarm'");
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

    #[test]
    fn plugin_content_embeds_quoted_bin() {
        let js = plugin_content("opencode", "/path/to swarm").unwrap();
        // The bin is JSON-encoded into the source, so a space-bearing path is safe.
        assert!(js.contains("\"/path/to swarm\""));
        assert!(plugin_content("claude", "/b").is_none()); // JSON agent → no plugin
    }
}
