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

/// A pane id (or session id) must be a bare token we can safely embed in a
/// filename, an `--resume` argv slot, or a TOML key. Restrict to ASCII
/// alphanumeric plus `.`, `_`, `-` — Windows-reserved chars (`*?<>|:"`),
/// path separators (`/\\`), control chars (`\0` and friends), shell
/// metacharacters, and whitespace are all rejected. The previous allowlist
/// only banned `/`, `\\`, `..`, `\0`, which let `pane*x` or `pane:x` through.
fn safe_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
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
    // Redact credential-bearing values (cursor `--api-key`, codex
    // `--remote-auth-token-env`, …) before they hit disk, so a stolen
    // `~/.swarm/agent-sessions/<paneId>.json` doesn't surrender keys.
    let args = redact_credentials(agent, &captured_args(agent));
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
    crate::fsperm::restrict_dir(&dir);
    let _ = write_record_atomic(&path, &rec);
}

/// Serialize `rec` and write it to `path` atomically on the local filesystem:
/// write to `path.json.tmp` first, then `rename` over `path`. A crash mid-write
/// can leave a `.tmp` sibling behind, but never a half-written `.json` — the
/// reader either sees the previous valid record or no record at all. Same-FS
/// `rename` is the POSIX atomicity guarantee we lean on; `~/.swarm/` and its
/// children are always on one filesystem, so we never cross a mount boundary.
fn write_record_atomic(path: &std::path::Path, rec: &AgentSession) -> std::io::Result<()> {
    let s = serde_json::to_string(rec)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, s.as_bytes())?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => {
            // Tighten to owner-only — the record may carry redacted-but-
            // still-recognisable launch args (paths, model names) we don't
            // want other local users to be able to read.
            crate::fsperm::restrict_file(path);
            Ok(())
        }
        Err(e) => {
            // Best-effort cleanup so a rename failure doesn't leave the .tmp around.
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
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

/// Prune session records whose paneId is not in `live` — orphans left behind
/// by panes that were closed (or workspaces that were dropped) in prior runs.
/// Called from `setup()` once per launch; `live` is the set of paneIds the
/// renderer is about to restore (read from session.json by the caller). Files
/// whose name doesn't match `<safe-token>.json` are left alone (someone else
/// might own them). Best-effort: a single unreadable entry doesn't abort the
/// sweep — the next launch will retry.
pub fn prune_orphans(live: &std::collections::HashSet<String>) {
    if let Some(dir) = sessions_dir() {
        prune_orphans_in(&dir, live);
    }
}

fn prune_orphans_in(dir: &std::path::Path, live: &std::collections::HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(pane_id) = name.strip_suffix(".json") else {
            continue;
        };
        if !safe_token(pane_id) {
            continue; // not one of ours — keep
        }
        if !live.contains(pane_id) {
            let _ = std::fs::remove_file(entry.path());
        }
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
        // swarm always injects `--settings <inline json>` for Claude. Filter it
        // BEFORE the security_value_deny check below so a swarm-launched Claude
        // (which captures the injected `--settings`) is still restorable. The
        // user's own `--settings` is also filtered here, but `store.ts` re-
        // injects swarm's settings on every restore, which is the desired
        // behaviour for both cases.
        if agent == "claude" && head == "--settings" {
            i += if arg.contains('=') { 1 } else { 2 };
            continue;
        }
        if p.reject.contains(&head) || p.security_value_deny.contains(&head) {
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
    /// Flags whose presence makes a launch fundamentally non-restorable for
    /// security reasons (e.g. claude `--mcp-config <evil.json>` would re-arm an
    /// attacker-supplied MCP server on every restart). `sanitize` returns
    /// `None` when any of these appear — same effect as a `reject` hit, but
    /// kept distinct so reviewers can tell the *why* apart.
    security_value_deny: std::collections::HashSet<&'static str>,
    /// Flags whose VALUE carries a credential (API key, header, token, remote
    /// URL). `redact_credentials` replaces the value with `[REDACTED]` at the
    /// persist boundary so a stolen `~/.swarm/agent-sessions/<paneId>.json`
    /// doesn't hand over the user's keys. Resume-time sanitize still drops
    /// the whole flag (these belong to `dropped`); this is just the
    /// on-disk leak guard.
    credential_value_opts: std::collections::HashSet<&'static str>,
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
            // M-1: a launch that touched any of these tool/permission/MCP
            // surfaces is fundamentally non-restorable — auto-rearming an
            // attacker-supplied MCP server / tool-allowlist / system-prompt on
            // restart would be a persistence vector. swarm's own injected
            // `--settings` is filtered above this check so swarm-launched
            // panes still resume cleanly.
            security_value_deny: set(&[
                "--mcp-config",
                "--add-dir",
                "--plugin-dir",
                "--allowedTools",
                "--allowed-tools",
                "--disallowedTools",
                "--disallowed-tools",
                "--permission-mode",
                "--system-prompt",
                "--append-system-prompt",
                "--settings",
                "--agents",
                "--setting-sources",
            ]),
            credential_value_opts: set(&[]),
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
            // M-1: a launch into a remote codex backend is non-restorable —
            // the remote env may have changed, and the auth token env-var
            // pointer is meaningless out of context. `--remote-auth-token-env`
            // is also `credential_value_opts` for the persist-time redact.
            security_value_deny: set(&["--remote"]),
            credential_value_opts: set(&["--remote-auth-token-env"]),
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
            // Gemini's `reject` already covers prompt/output/extensions
            // surfaces — nothing extra to add for the security gate.
            security_value_deny: set(&[]),
            credential_value_opts: set(&[]),
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
            // M-1: a cursor launch that pinned a worktree/workspace must NOT
            // auto-restore there — the target might have been moved, deleted,
            // or be a stale checkout. `--api-key`/`-H`/`--header` are also
            // `credential_value_opts` so the on-disk record redacts the value.
            security_value_deny: set(&["--workspace", "--worktree", "--worktree-base"]),
            credential_value_opts: set(&["--api-key", "-H", "--header"]),
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
            // M-1: opencode `--prompt`/`--file`/`-f` are one-shot inputs; a
            // launch carrying them was a one-off command, not an interactive
            // session worth resurrecting.
            security_value_deny: set(&["--prompt", "--file", "-f"]),
            credential_value_opts: set(&[]),
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
            // M-1: amp `--label`/`-l` names a specific thread/run; resuming
            // into a stale label would reuse the wrong thread context.
            security_value_deny: set(&["--label", "-l"]),
            credential_value_opts: set(&[]),
        }),
        _ => None,
    }
}

/// Redact credential-bearing values for the on-disk record. Walks `args`,
/// replacing the value of every flag in the agent's `credential_value_opts`
/// with `[REDACTED]`. Handles both `--api-key sk-…` and `--api-key=sk-…`
/// forms. Anything else passes through verbatim — this only protects the
/// *value*, not whether the flag was present (resume-time sanitize already
/// drops the whole flag for these via `dropped`).
pub(crate) fn redact_credentials(agent: &str, args: &[String]) -> Vec<String> {
    let Some(p) = policy(agent) else {
        return args.to_vec();
    };
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        // `--flag=value` form: replace just the value portion.
        if let Some((head, _)) = arg.split_once('=') {
            if p.credential_value_opts.contains(&head) {
                out.push(format!("{head}=[REDACTED]"));
                i += 1;
                continue;
            }
        }
        if p.credential_value_opts.contains(&arg.as_str()) {
            // `--flag value` form: keep the flag, redact the next argv slot.
            out.push(arg.clone());
            if i + 1 < args.len() {
                out.push("[REDACTED]".into());
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        out.push(arg.clone());
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_orphans_removes_only_dead_panes_and_keeps_alien_files() {
        // Setup: a scratch directory with a mix of (a) live-pane records,
        // (b) orphaned-pane records, and (c) files NOT shaped like a session
        // record (someone else might own them). After prune: only (b) goes.
        let dir = std::env::temp_dir().join(format!("swarm-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let live_id = "pane-live-1";
        let orphan_id = "pane-orphan-2";
        std::fs::write(dir.join(format!("{live_id}.json")), b"{}").unwrap();
        std::fs::write(dir.join(format!("{orphan_id}.json")), b"{}").unwrap();
        // Unrelated file: a .json with a name that fails safe_token (contains
        // a forbidden character) — someone else's file, must not be touched.
        std::fs::write(dir.join("hello world.json"), b"hi").unwrap();
        // Non-JSON file — keep it.
        std::fs::write(dir.join("note.txt"), b"hi").unwrap();
        // A safe-tokened name with .json that matches no live pane and no
        // safe rule violation — this one should be pruned (it's a real orphan).
        let other_orphan = "pane-orphan-3";
        std::fs::write(dir.join(format!("{other_orphan}.json")), b"{}").unwrap();

        let mut live = std::collections::HashSet::new();
        live.insert(live_id.to_string());
        prune_orphans_in(&dir, &live);

        assert!(
            dir.join(format!("{live_id}.json")).exists(),
            "live record kept"
        );
        assert!(
            !dir.join(format!("{orphan_id}.json")).exists(),
            "orphan record gone"
        );
        assert!(
            !dir.join(format!("{other_orphan}.json")).exists(),
            "second orphan gone"
        );
        assert!(
            dir.join("hello world.json").exists(),
            "non-safe-token .json must not be touched"
        );
        assert!(
            dir.join("note.txt").exists(),
            "non-json must not be touched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_orphans_on_empty_live_set_with_only_records_clears_all_records() {
        // Edge case: every record is orphaned (no live panes). All session
        // files go; nothing else does. This is what happens on a launch where
        // every workspace was closed in the prior session.
        let dir = std::env::temp_dir().join(format!("swarm-prune-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pane-a.json"), b"{}").unwrap();
        std::fs::write(dir.join("pane-b.json"), b"{}").unwrap();
        std::fs::write(dir.join("keep.me"), b"x").unwrap();

        prune_orphans_in(&dir, &std::collections::HashSet::new());
        assert!(!dir.join("pane-a.json").exists());
        assert!(!dir.join("pane-b.json").exists());
        assert!(dir.join("keep.me").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn safe_token_rejects_path_pieces() {
        assert!(safe_token("pane-123-4"));
        assert!(!safe_token(""));
        assert!(!safe_token("a/b"));
        assert!(!safe_token("../x"));
    }

    #[test]
    fn l7_safe_token_rejects_windows_reserved_and_shell_metacharacters() {
        // The previous allowlist only banned `/`, `\\`, `..`, `\0`, which
        // would let a hostile pane id like `pane:1`, `pane*`, `pane?`,
        // `pane|cmd` through. Now we restrict to `[A-Za-z0-9._-]`.
        for bad in [
            "pane:1", "pane*x", "pane?", "pane<a", "pane>b", "pane|c", "pane\"d", "pane'e",
            "pane f", "pane\tg", "pane;h", "pane&i", "pane$j", "pane`k", "pane(l)", "pane[m]",
            "pane{n}",
        ] {
            assert!(!safe_token(bad), "{bad:?} should be rejected");
        }
        // The whole legitimate alphabet survives — alnum + the three
        // accent-mark chars users actually need in pane ids.
        assert!(safe_token("pane-abc_123.def"));
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
        // amp: a launch carrying --label/-l is now `security_value_deny`
        // (resuming into a stale thread label is the wrong context — see M-1),
        // so the whole launch is non-restorable. A launch with only user
        // flags still preserves them.
        assert!(sanitize("amp", &["--label".into(), "l".into(), "--keep".into()]).is_none());
        assert_eq!(
            sanitize("amp", &["--keep".into(), "--verbose".into()]).unwrap(),
            vec!["--keep", "--verbose"]
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

    #[test]
    fn m1_claude_mcp_config_marks_launch_non_restorable() {
        // The user case M-1 was designed for: a Claude launched with
        // `--mcp-config <evil.json>` would auto-rearm an attacker-supplied
        // MCP server on every restart. Sanitize must refuse the whole launch.
        let out = sanitize("claude", &["--mcp-config".into(), "evil.json".into()]);
        assert!(out.is_none(), "expected None, got {out:?}");
    }

    #[test]
    fn m1_claude_security_value_deny_covers_every_listed_flag() {
        // Every flag the M-1 policy lists must make the launch non-restorable
        // when present — exercised as a loop so adding a flag to the deny set
        // automatically gets covered.
        for flag in [
            "--mcp-config",
            "--add-dir",
            "--plugin-dir",
            "--allowedTools",
            "--allowed-tools",
            "--disallowedTools",
            "--disallowed-tools",
            "--permission-mode",
            "--system-prompt",
            "--append-system-prompt",
            "--agents",
            "--setting-sources",
        ] {
            let out = sanitize("claude", &[flag.to_string(), "x".into()]);
            assert!(
                out.is_none(),
                "claude {flag} should mark launch non-restorable (got {out:?})"
            );
            // Same for the `--flag=value` form (handled by the head-split
            // branch in `sanitize`).
            let eq = format!("{flag}=x");
            let out = sanitize("claude", std::slice::from_ref(&eq));
            assert!(
                out.is_none(),
                "claude {eq} should also be denied (got {out:?})"
            );
        }
    }

    #[test]
    fn claude_permission_mode_restores_like_skip_permissions() {
        // `--permission-mode <mode>` expresses the same user intent as
        // `--dangerously-skip-permissions`, which the cmux-ported policy
        // preserves — so both must come back after a restart, value included.
        let out = sanitize(
            "claude",
            &["--permission-mode".into(), "bypassPermissions".into()],
        )
        .unwrap();
        assert_eq!(out, vec!["--permission-mode", "bypassPermissions"]);
        let out = sanitize("claude", &["--permission-mode=plan".into()]).unwrap();
        assert_eq!(out, vec!["--permission-mode=plan"]);
    }

    #[test]
    fn m1_claude_security_value_deny_respects_swarm_settings_filter() {
        // The swarm-injected `--settings <json>` is filtered BEFORE the
        // security gate — otherwise every swarm-launched Claude would be
        // non-restorable. Sanity-check: a launch carrying both swarm's
        // injection AND a user flag still preserves the user flag.
        let out = sanitize(
            "claude",
            &[
                "--settings".into(),
                "{json}".into(),
                "--dangerously-skip-permissions".into(),
            ],
        )
        .unwrap();
        assert_eq!(out, vec!["--dangerously-skip-permissions"]);
    }

    #[test]
    fn m1_codex_remote_denies_resume() {
        // A codex launched against a remote backend doesn't auto-restore —
        // the remote env may have moved/expired and the resume isn't
        // meaningful out of that original context.
        assert!(sanitize("codex", &["--remote".into(), "https://x/y".into()]).is_none());
    }

    #[test]
    fn m1_cursor_workspace_pinning_denies_resume() {
        // Pinning a worktree/workspace is M-1-denied: the target might be
        // gone, moved, or a stale checkout. Loop over the family.
        for flag in ["--workspace", "--worktree", "--worktree-base"] {
            let out = sanitize("cursor", &[flag.to_string(), "x".into()]);
            assert!(
                out.is_none(),
                "cursor {flag} should be denied (got {out:?})"
            );
        }
    }

    #[test]
    fn m1_opencode_one_shot_prompts_deny_resume() {
        // `--prompt` / `--file` (and short `-f`) signal a one-shot command,
        // not an interactive session worth resurrecting.
        for flag in ["--prompt", "--file", "-f"] {
            let out = sanitize("opencode", &[flag.to_string(), "x".into()]);
            assert!(
                out.is_none(),
                "opencode {flag} should be denied (got {out:?})"
            );
        }
    }

    #[test]
    fn m1_amp_label_denies_resume() {
        // Amp's `--label` names a specific thread — resuming into a stale
        // label is the wrong context.
        assert!(sanitize("amp", &["--label".into(), "x".into()]).is_none());
        assert!(sanitize("amp", &["-l".into(), "x".into()]).is_none());
    }

    #[test]
    fn h3_redact_credentials_cursor_api_key_value_form() {
        // `--api-key sk-x --keep` → the *value* of --api-key is redacted, the
        // surrounding flags pass through verbatim.
        let out = redact_credentials(
            "cursor",
            &["--api-key".into(), "sk-x".into(), "--keep".into()],
        );
        assert_eq!(out, vec!["--api-key", "[REDACTED]", "--keep"]);
    }

    #[test]
    fn h3_redact_credentials_cursor_api_key_equals_form() {
        // `--api-key=sk-x` → same field is redacted with the equals form too.
        let out = redact_credentials("cursor", &["--api-key=sk-x".into()]);
        assert_eq!(out, vec!["--api-key=[REDACTED]"]);
    }

    #[test]
    fn h3_redact_credentials_cursor_header_short_and_long() {
        // Both `-H` and `--header` are credential-bearing for cursor.
        let out = redact_credentials(
            "cursor",
            &["-H".into(), "X-Token: secret".into(), "--keep".into()],
        );
        assert_eq!(out, vec!["-H", "[REDACTED]", "--keep"]);
        let out = redact_credentials("cursor", &["--header".into(), "X-Auth: t".into()]);
        assert_eq!(out, vec!["--header", "[REDACTED]"]);
    }

    #[test]
    fn h3_redact_credentials_codex_auth_token_env() {
        // codex `--remote-auth-token-env <NAME>` — the env-var *name* is what's
        // redacted (it points the agent at a key in the env, so it's still
        // sensitive enough that an off-disk reader shouldn't see which one).
        let out = redact_credentials(
            "codex",
            &["--remote-auth-token-env".into(), "OPENAI_KEY".into()],
        );
        assert_eq!(out, vec!["--remote-auth-token-env", "[REDACTED]"]);
    }

    #[test]
    fn h3_redact_credentials_passes_unrelated_flags_through() {
        // No credential flag in the list → identity.
        let out = redact_credentials(
            "claude",
            &["--dangerously-skip-permissions".into(), "--verbose".into()],
        );
        assert_eq!(out, vec!["--dangerously-skip-permissions", "--verbose"]);
    }

    #[cfg(unix)]
    #[test]
    fn h3_record_file_mode_is_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("swarm-h3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pane-x.json");
        let rec = AgentSession {
            agent: "claude".into(),
            session_id: "s1".into(),
            args: vec![],
            cwd: "/cwd".into(),
        };
        write_record_atomic(&path, &rec).unwrap();
        let m = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600, "expected 0600, got {m:o}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_record_atomic_leaves_no_tmp_and_last_write_wins() {
        let dir = std::env::temp_dir().join(format!("swarm-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pane-x.json");

        let rec1 = AgentSession {
            agent: "claude".into(),
            session_id: "s1".into(),
            args: vec!["--first".into()],
            cwd: "/cwd".into(),
        };
        let rec2 = AgentSession {
            agent: "claude".into(),
            session_id: "s2".into(),
            args: vec!["--second".into()],
            cwd: "/cwd".into(),
        };
        write_record_atomic(&path, &rec1).unwrap();
        write_record_atomic(&path, &rec2).unwrap();

        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists(), "stray .tmp leaked: {tmp:?}");
        let read: AgentSession =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read.session_id, "s2");
        assert_eq!(read.args, vec!["--second".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
