// SPDX-License-Identifier: GPL-3.0-or-later
//! Capture & restore of agent CLI sessions across app restarts — modeled on cmux.
//!
//! When an agent (e.g. Claude Code) starts in a swarm pane — whether launched from
//! the spawn menu or typed by hand into a shell — a hook installed in the agent's
//! *own* config runs `swarm --notify-helper session-start <agent>`. That records
//! the agent's real session id plus the user's launch flags, keyed by the pane
//! (via `SWARM_PANE_ID`). On the next launch swarm rebuilds the agent's native
//! resume command (e.g. `claude --resume <id> --dangerously-skip-permissions`) so
//! the session *and* the user's flags come back.
//!
//! Flags are filtered by a per-agent denylist (ported from cmux's
//! `AgentLaunchSanitizer`) so swarm's own injected/one-shot flags (`--session-id`,
//! `--settings`, `--resume`, `--print`, …) are dropped while user flags survive.
//! A captured record is only honoured if the agent's session is still restorable
//! (for Claude: its transcript `.jsonl` exists).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// One captured agent session, persisted at `~/.swarm/agent-sessions/<paneId>.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentSession {
    /// Agent id (matches the frontend registry: "claude", "codex", …).
    pub agent: String,
    /// The agent's own session id (from its hook), used to resume.
    pub session_id: String,
    /// The launch arguments as seen at runtime (pre-sanitize).
    pub args: Vec<String>,
    /// Working directory the agent ran in.
    pub cwd: String,
}

/// The resume command to re-spawn: executable + args.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCommand {
    pub agent: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub session_id: String,
}

/// A pane id must be a bare token we can use as a filename — never a path piece.
fn safe_token(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && !s.contains("..") && !s.contains('\0')
}

fn sessions_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".swarm").join("agent-sessions"))
}

fn record_path(pane_id: &str) -> Option<PathBuf> {
    if !safe_token(pane_id) {
        return None;
    }
    Some(sessions_dir()?.join(format!("{pane_id}.json")))
}

/// Record an agent's session start (called from the agent's own lifecycle hook
/// via `notify_helper`). Best-effort: any failure is silently ignored so a hook
/// never errors out. `agent` is the swarm agent id; `payload` is the hook's stdin
/// JSON (Claude provides `session_id` + `cwd`).
pub fn record_session_start(agent: &str, payload: &str) {
    let Ok(pane_id) = std::env::var("SWARM_PANE_ID") else {
        return; // not a swarm pane — nothing to key the record on
    };
    if !safe_token(&pane_id) {
        return;
    }
    let v: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let session_id = extract_session_id(&v).unwrap_or_default();
    // A session id must be a safe bare token (it ends up in `--resume <id>` and,
    // for the restorability check, as a `<id>.jsonl` filename).
    if !safe_token(&session_id) {
        return;
    }
    let cwd = v
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| std::env::var("PWD").ok())
        .unwrap_or_default();
    let args = captured_args(agent);
    let rec = AgentSession {
        agent: agent.to_string(),
        session_id,
        args,
        cwd,
    };
    let (Some(dir), Some(path)) = (sessions_dir(), record_path(&pane_id)) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string(&rec) {
        let _ = std::fs::write(path, s);
    }
}

/// Pull a session id out of a hook's stdin JSON. Ports cmux's
/// `extractClaudeHookSessionId`: accepts `session_id` / `sessionId` /
/// `conversation_id` / `conversationId` (cursor-agent emits `conversation_id`) at
/// the top level, then nested under `notification` / `data` / `context`, and under
/// `session` (where a bare `id` is also accepted).
fn extract_session_id(v: &Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
    ];
    fn first(obj: &Value, keys: &[&str]) -> Option<String> {
        let o = obj.as_object()?;
        keys.iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    if let Some(id) = first(v, KEYS) {
        return Some(id);
    }
    for nested in ["notification", "data", "context"] {
        if let Some(n) = v.get(nested) {
            if let Some(id) = first(n, KEYS) {
                return Some(id);
            }
        }
    }
    if let Some(s) = v.get("session") {
        let mut keys = vec!["id"];
        keys.extend_from_slice(KEYS);
        if let Some(id) = first(s, &keys) {
            return Some(id);
        }
    }
    None
}

/// The agent's CLI executable basename — used to find its process when scanning.
fn agent_binary(agent: &str) -> &'static str {
    match agent {
        "cursor" => "cursor-agent",
        "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        "opencode" => "opencode",
        "amp" => "amp",
        _ => "",
    }
}

/// The launch args as seen at runtime. When swarm itself launched the agent it
/// hands us the exact argv as a JSON array in `SWARM_AGENT_ARGV_JSON` (so values
/// containing spaces — e.g. the injected `--settings <json>` — survive intact).
/// For an agent typed by hand into a shell there's nothing to pass in, so we
/// best-effort read it off the agent's own process command line.
fn captured_args(agent: &str) -> Vec<String> {
    if let Ok(raw) = std::env::var("SWARM_AGENT_ARGV_JSON") {
        if let Ok(args) = serde_json::from_str::<Vec<String>>(&raw) {
            return args;
        }
    }
    process_scanned_args(agent_binary(agent)).unwrap_or_default()
}

/// Walk up the parent-process chain to find the agent's process and return the
/// args *after* its CLI token (so a `node` interpreter + runtime flags before the
/// script are excluded — those come first; the agent's own flags follow). Unix
/// only. The hook runs a few levels under the agent (`agent → sh -c → swarm`).
#[cfg(unix)]
fn process_scanned_args(binary: &str) -> Option<Vec<String>> {
    if binary.is_empty() {
        return None;
    }
    let mut pid = ps_ppid(std::process::id() as i32)?; // start at our parent, skip ourselves
    for _ in 0..8 {
        if pid <= 1 {
            break;
        }
        if let Some(argv) = ps_args(pid) {
            // Skip our own hook invocation and the shell wrapping it — their
            // command line literally contains the agent name (`… session-start
            // claude`), which would otherwise match before we reach the real agent.
            if argv.iter().any(|a| a.contains("--notify-helper")) {
                pid = ps_ppid(pid)?;
                continue;
            }
            // Find the agent's CLI token: a basename equal to or starting with the
            // binary name (covers `claude`, `/…/claude`, `…/claude.js`, the
            // `cursor-agent` binary, etc.). Its trailing args are the user's flags.
            if let Some(idx) = argv.iter().position(|a| {
                let base = a.rsplit('/').next().unwrap_or(a);
                let base = base.strip_suffix(".js").unwrap_or(base);
                base == binary || base.starts_with(binary)
            }) {
                return Some(argv.iter().skip(idx + 1).cloned().collect());
            }
        }
        pid = ps_ppid(pid)?;
    }
    None
}

#[cfg(not(unix))]
fn process_scanned_args(_binary: &str) -> Option<Vec<String>> {
    None
}

#[cfg(unix)]
fn ps_args(pid: i32) -> Option<Vec<String>> {
    let out = std::process::Command::new("ps")
        .args(["-ww", "-o", "args=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.trim();
    if line.is_empty() {
        return None;
    }
    Some(line.split_whitespace().map(str::to_owned).collect())
}

#[cfg(unix)]
fn ps_ppid(pid: i32) -> Option<i32> {
    let out = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Load the captured session for a pane, if any.
pub fn load(pane_id: &str) -> Option<AgentSession> {
    let path = record_path(pane_id)?;
    let s = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

/// Delete a pane's captured record (e.g. when the pane is closed for good).
pub fn forget(pane_id: &str) {
    if let Some(path) = record_path(pane_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// Build the native resume command for a captured session, or None when the agent
/// isn't restorable (unknown agent, no longer-valid session, or a non-restorable
/// launch — e.g. it was `claude mcp …`).
pub fn resume_command(pane_id: &str) -> Option<ResumeCommand> {
    let s = load(pane_id)?;
    let preserved = sanitize(&s.agent, &s.args)?;
    let (command, args) = build_resume(&s.agent, &s.session_id, preserved)?;
    Some(ResumeCommand {
        agent: s.agent,
        command,
        args,
        cwd: s.cwd,
        session_id: s.session_id,
    })
}

/// Per-agent native resume argv (ported from cmux `resumeArguments`). Returns
/// `(command, args)`; the command defaults to the agent's executable.
fn build_resume(
    agent: &str,
    session_id: &str,
    preserved: Vec<String>,
) -> Option<(String, Vec<String>)> {
    let id = session_id.to_string();
    match agent {
        "claude" => {
            // Resume the conversation if its transcript exists; otherwise reopen
            // fresh (just the user's flags). Claude only writes a transcript after
            // the first turn, so a session opened-but-never-used can't be
            // `--resume`d ("No conversation found"); and re-passing the same
            // `--session-id` would error ("already in use"). The user still wants
            // `claude <flags>` back, so we relaunch fresh rather than drop to a
            // shell — the SessionStart hook re-captures the new id for next time.
            let mut a = if crate::agents::claude_session_exists(session_id) {
                vec!["--resume".into(), id]
            } else {
                Vec::new()
            };
            a.extend(preserved);
            Some(("claude".into(), a))
        }
        "codex" => {
            let mut a = vec!["resume".into(), id];
            a.extend(preserved);
            Some(("codex".into(), a))
        }
        "gemini" => {
            let mut a = vec!["--resume".into(), id];
            a.extend(preserved);
            Some(("gemini".into(), a))
        }
        "cursor" => {
            let mut a = vec!["--resume".into(), id];
            a.extend(preserved);
            Some(("cursor-agent".into(), a))
        }
        "opencode" => {
            let mut a = vec!["--session".into(), id];
            a.extend(preserved);
            Some(("opencode".into(), a))
        }
        "amp" => {
            // cmux: `amp threads continue <preserved> <id>` (id last).
            let mut a = vec!["threads".into(), "continue".into()];
            a.extend(preserved);
            a.push(id);
            Some(("amp".into(), a))
        }
        _ => None, // aider et al.: cmux has no resume spec — don't guess.
    }
}

/// Sanitize launch args for a resume, dropping session/one-shot/swarm-injected
/// flags while preserving the rest. Returns None when the launch is fundamentally
/// non-restorable (a rejected flag or a non-restorable subcommand was present).
fn sanitize(agent: &str, args: &[String]) -> Option<Vec<String>> {
    let p = policy(agent)?;
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        // `--` ends option parsing; nothing after it is a flag we manage.
        if arg == "--" {
            break;
        }
        // A bare positional that names a non-restorable subcommand kills the whole
        // command (e.g. `claude mcp`, `codex exec`).
        if !arg.starts_with('-') {
            if p.non_restorable.contains(&arg.as_str()) {
                return None;
            }
            // Otherwise a stray positional — skip it (resume supplies its own).
            i += 1;
            continue;
        }
        // `--opt=val` form: classify by the `--opt=` prefix.
        let head = arg.split('=').next().unwrap_or(arg);
        if p.reject.contains(&head) {
            return None;
        }
        if p.dropped.contains(&head) || p.dropped_prefixes.iter().any(|pre| arg.starts_with(pre)) {
            // Drop the option, and its value too if it's a value option in `--opt val` form.
            if !arg.contains('=') && p.value_opts.contains(&head) {
                i += value_width(args, i, &p);
            } else {
                i += 1;
            }
            continue;
        }
        // swarm always injects `--settings <inline json>` for Claude; never restore it.
        if agent == "claude" && head == "--settings" {
            i += if arg.contains('=') { 1 } else { 2 };
            continue;
        }
        // Preserve this option (and its value(s)).
        let w = if arg.contains('=') {
            1
        } else {
            value_width(args, i, &p)
        };
        for a in &args[i..(i + w).min(args.len())] {
            out.push(a.clone());
        }
        i += w;
    }
    Some(out)
}

/// How many argv slots this option spans (the flag + its value(s)).
fn value_width(args: &[String], i: usize, p: &Policy) -> usize {
    let head = args[i].split('=').next().unwrap_or(&args[i]);
    if p.variadic.contains(&head) {
        // Consume until the next `-`-prefixed token.
        let mut n = 1;
        while i + n < args.len() && !args[i + n].starts_with('-') {
            n += 1;
        }
        return n.max(1);
    }
    if p.value_opts.contains(&head) {
        return 2;
    }
    if p.optional_value.contains(&head) {
        // Consume a value only if the next token doesn't look like a flag.
        if i + 1 < args.len() && !args[i + 1].starts_with('-') {
            return 2;
        }
    }
    1
}

struct Policy {
    value_opts: std::collections::HashSet<&'static str>,
    optional_value: std::collections::HashSet<&'static str>,
    variadic: std::collections::HashSet<&'static str>,
    non_restorable: std::collections::HashSet<&'static str>,
    dropped: std::collections::HashSet<&'static str>,
    dropped_prefixes: Vec<&'static str>,
    reject: std::collections::HashSet<&'static str>,
}

fn set(items: &[&'static str]) -> std::collections::HashSet<&'static str> {
    items.iter().copied().collect()
}

/// Per-agent sanitizer policy, ported verbatim from cmux
/// `AgentLaunchSanitizerPrimaryPolicies` / `AdditionalPolicies`.
fn policy(agent: &str) -> Option<Policy> {
    match agent {
        "claude" => Some(Policy {
            value_opts: set(&[
                "--add-dir",
                "--agent",
                "--agents",
                "--allowedTools",
                "--allowed-tools",
                "--append-system-prompt",
                "--betas",
                "--dangerously-load-development-channels",
                "--debug-file",
                "--disallowedTools",
                "--disallowed-tools",
                "--effort",
                "--fallback-model",
                "--file",
                "--from-pr",
                "--input-format",
                "--json-schema",
                "--max-budget-usd",
                "--mcp-config",
                "--model",
                "--name",
                "-n",
                "--output-format",
                "--permission-mode",
                "--plugin-dir",
                "--remote-control-session-name-prefix",
                "--resume",
                "-r",
                "--session-id",
                "--setting-sources",
                "--settings",
                "--system-prompt",
                "--teammate-mode",
                "--tmux",
                "--tools",
                "--worktree",
                "-w",
            ]),
            optional_value: set(&["--debug"]),
            variadic: set(&[
                "--add-dir",
                "--allowedTools",
                "--allowed-tools",
                "--betas",
                "--disallowedTools",
                "--disallowed-tools",
                "--file",
                "--mcp-config",
                "--tools",
            ]),
            non_restorable: set(&[
                "agents",
                "auth",
                "auto-mode",
                "api-key",
                "config",
                "doctor",
                "install",
                "mcp",
                "plugin",
                "plugins",
                "rc",
                "remote-control",
                "setup-token",
                "update",
                "upgrade",
            ]),
            dropped: set(&[
                "--continue",
                "-c",
                "--file",
                "--fork-session",
                "--from-pr",
                "--resume",
                "-r",
                "--session-id",
                "--tmux",
                "--worktree",
                "-w",
            ]),
            dropped_prefixes: vec![
                "--file=",
                "--fork-session=",
                "--from-pr=",
                "--resume=",
                "--session-id=",
                "--tmux=",
                "--worktree=",
            ],
            reject: set(&["--print", "-p", "--no-session-persistence"]),
        }),
        "codex" => Some(Policy {
            value_opts: set(&["--image", "-i", "--remote", "--remote-auth-token-env"]),
            optional_value: set(&[]),
            variadic: set(&[]),
            non_restorable: set(&[
                "exec",
                "e",
                "review",
                "login",
                "logout",
                "mcp",
                "mcp-server",
                "app-server",
                "app",
                "completion",
                "sandbox",
                "debug",
                "apply",
                "a",
                "fork",
                "cloud",
                "exec-server",
                "features",
                "help",
            ]),
            dropped: set(&[
                "--last",
                "--image",
                "-i",
                "--remote",
                "--remote-auth-token-env",
                "--all",
            ]),
            dropped_prefixes: vec!["--remote=", "--remote-auth-token-env="],
            reject: set(&[]),
        }),
        "gemini" => Some(Policy {
            value_opts: set(&["--resume", "-r", "--session-id", "--worktree", "-w"]),
            optional_value: set(&[]),
            variadic: set(&[]),
            non_restorable: set(&["mcp", "extensions", "skills", "hooks", "gemma", "help"]),
            dropped: set(&["--resume", "-r", "--session-id", "--worktree", "-w"]),
            dropped_prefixes: vec![],
            reject: set(&[
                "--prompt",
                "-p",
                "--prompt-interactive",
                "-i",
                "--list-sessions",
                "--delete-session",
                "--output-format",
                "-o",
                "--raw-output",
                "--accept-raw-output-risk",
                "--acp",
                "--experimental-acp",
                "--list-extensions",
            ]),
        }),
        "cursor" => Some(Policy {
            value_opts: set(&[
                "--api-key",
                "-H",
                "--header",
                "--resume",
                "--workspace",
                "-w",
                "--worktree",
                "--worktree-base",
            ]),
            optional_value: set(&[]),
            variadic: set(&[]),
            non_restorable: set(&[
                "about",
                "create-chat",
                "generate-rule",
                "help",
                "install-shell-integration",
                "login",
                "logout",
                "ls",
                "mcp",
                "models",
                "rule",
                "status",
                "uninstall-shell-integration",
                "update",
                "whoami",
            ]),
            dropped: set(&[
                "--api-key",
                "-H",
                "--header",
                "--continue",
                "--resume",
                "--workspace",
                "-w",
                "--worktree",
                "--worktree-base",
                "--skip-worktree-setup",
            ]),
            dropped_prefixes: vec![],
            reject: set(&[
                "--cloud",
                "--output-format",
                "--print",
                "-p",
                "--stream-partial-output",
            ]),
        }),
        "opencode" => Some(Policy {
            value_opts: set(&["--file", "-f", "--session", "-s", "--prompt"]),
            optional_value: set(&[]),
            variadic: set(&[]),
            non_restorable: set(&[
                "completion",
                "acp",
                "mcp",
                "attach",
                "run",
                "debug",
                "providers",
                "auth",
                "agent",
                "upgrade",
                "uninstall",
                "serve",
                "web",
                "models",
                "stats",
                "export",
                "import",
                "pr",
                "github",
                "session",
                "plugin",
                "plug",
                "db",
            ]),
            dropped: set(&[
                "--continue",
                "-c",
                "--file",
                "-f",
                "--fork",
                "--session",
                "-s",
                "--prompt",
            ]),
            dropped_prefixes: vec![],
            reject: set(&[]),
        }),
        "amp" => Some(Policy {
            value_opts: set(&["--label", "-l"]),
            optional_value: set(&[]),
            variadic: set(&[]),
            non_restorable: set(&[
                "login",
                "logout",
                "mcp",
                "permissions",
                "permission",
                "review",
                "skill",
                "skills",
                "tool",
                "tools",
                "update",
                "up",
                "usage",
                "version",
            ]),
            dropped: set(&[
                "--archive",
                "--label",
                "-l",
                "--stream-json",
                "--stream-json-input",
                "--stream-json-thinking",
            ]),
            dropped_prefixes: vec![],
            reject: set(&["--execute", "--print", "-V", "-x"]),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_token_rejects_path_pieces() {
        assert!(safe_token("pane-123-4"));
        assert!(!safe_token(""));
        assert!(!safe_token("a/b"));
        assert!(!safe_token("../x"));
    }

    #[test]
    fn claude_sanitizer_keeps_user_flags_drops_session_and_settings() {
        // The user's case: typed `claude --dangerously-skip-permissions`; swarm
        // also injects `--session-id <uuid> --settings <json>` for menu launches.
        let args = vec![
            "--session-id".into(),
            "abc".into(),
            "--settings".into(),
            "{json}".into(),
            "--dangerously-skip-permissions".into(),
            "--model".into(),
            "opus".into(),
        ];
        let out = sanitize("claude", &args).unwrap();
        assert_eq!(
            out,
            vec!["--dangerously-skip-permissions", "--model", "opus"]
        );
    }

    #[test]
    fn claude_sanitizer_drops_resume_with_value() {
        let args = vec!["--resume".into(), "old-id".into(), "--verbose".into()];
        assert_eq!(sanitize("claude", &args).unwrap(), vec!["--verbose"]);
    }

    #[test]
    fn claude_sanitizer_rejects_print_and_subcommands() {
        assert!(sanitize("claude", &["--print".into()]).is_none());
        assert!(sanitize("claude", &["mcp".into()]).is_none());
        // A bare normal positional is just skipped, not rejected.
        assert_eq!(
            sanitize("claude", &["hello".into()]).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn build_resume_claude_no_transcript_reopens_fresh_with_flags() {
        // No transcript for "sid" on disk → reopen fresh (no --resume/--session-id),
        // but keep the user's flag so `claude --dangerously-skip-permissions` is back.
        let (cmd, args) = build_resume(
            "claude",
            "sid",
            vec!["--dangerously-skip-permissions".into()],
        )
        .unwrap();
        assert_eq!(cmd, "claude");
        assert_eq!(args, vec!["--dangerously-skip-permissions"]);
    }

    #[test]
    fn sanitizers_preserve_user_flags_per_agent() {
        // Each agent: drop its session/one-shot flags (with values), keep the rest.
        // codex: drop --last and --image <v>; keep a user flag.
        assert_eq!(
            sanitize(
                "codex",
                &[
                    "--last".into(),
                    "--image".into(),
                    "p.png".into(),
                    "--full-auto".into()
                ]
            )
            .unwrap(),
            vec!["--full-auto"]
        );
        // gemini: drop --resume <id>; keep a user flag; reject one-shot --prompt.
        assert_eq!(
            sanitize("gemini", &["--resume".into(), "id".into(), "--yolo".into()]).unwrap(),
            vec!["--yolo"]
        );
        assert!(sanitize("gemini", &["--prompt".into(), "hi".into()]).is_none());
        // cursor: drop --resume <id>; keep a user flag.
        assert_eq!(
            sanitize(
                "cursor",
                &["--resume".into(), "c1".into(), "--force".into()]
            )
            .unwrap(),
            vec!["--force"]
        );
        // opencode: drop --session <id> and --continue; keep a user flag.
        assert_eq!(
            sanitize(
                "opencode",
                &[
                    "--session".into(),
                    "s1".into(),
                    "--continue".into(),
                    "--verbose".into()
                ]
            )
            .unwrap(),
            vec!["--verbose"]
        );
        // amp: drop --label <v>; keep a user flag.
        assert_eq!(
            sanitize("amp", &["--label".into(), "l".into(), "--keep".into()]).unwrap(),
            vec!["--keep"]
        );
    }

    #[test]
    fn build_resume_amp_puts_id_last() {
        let (cmd, args) = build_resume("amp", "sid", vec!["--foo".into()]).unwrap();
        assert_eq!(cmd, "amp");
        assert_eq!(args, vec!["threads", "continue", "--foo", "sid"]);
    }

    #[test]
    fn unknown_agent_has_no_resume() {
        assert!(build_resume("aider", "x", vec![]).is_none());
        assert!(policy("aider").is_none());
    }
}
