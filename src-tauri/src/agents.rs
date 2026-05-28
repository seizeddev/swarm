// SPDX-License-Identifier: GPL-3.0-or-later
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    /// The launch command. Static for real agents; for the "shell" pane this is the
    /// user's login shell, resolved from `$SHELL` at runtime (see `default_shell`).
    pub command: String,
    pub args: &'static [&'static str],
    pub installed: bool,
    /// Args that resume the agent's most recent session in the cwd (for restore).
    pub resume: &'static [&'static str],
}

pub(crate) struct Reg {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub resume: &'static [&'static str],
}

const fn reg(
    id: &'static str,
    name: &'static str,
    command: &'static str,
    resume: &'static [&'static str],
) -> Reg {
    Reg {
        id,
        name,
        command,
        args: &[],
        resume,
    }
}

pub(crate) const REGISTRY: &[Reg] = &[
    reg("claude", "Claude Code", "claude", &["--continue"]),
    reg("codex", "Codex", "codex", &["resume", "--last"]),
    reg("gemini", "Gemini", "gemini", &[]),
    reg("opencode", "OpenCode", "opencode", &[]),
    reg("amp", "Amp", "amp", &[]),
    reg("cursor", "Cursor CLI", "cursor-agent", &[]),
    reg("aider", "Aider", "aider", &[]),
    // Command is filled at runtime from `default_shell()` (see `list_agents`); the
    // registry literal is only a fallback if `$SHELL` is unset on a non-Unix build.
    reg("shell", "Shell", "", &[]),
];

/// The user's interactive login shell — what a "shell" pane should launch.
///
/// On Unix we honour `$SHELL` (zsh on modern macOS, whatever the user set elsewhere)
/// and fall back to `/bin/zsh`. We deliberately do NOT hardcode `bash`: macOS ships
/// the frozen GPLv2 bash 3.2 at `/bin/bash`, so launching it greeted the user with
/// "The default interactive shell is now zsh" instead of their real shell — the bug
/// this fixes. On Windows there is no `$SHELL` convention, so we use PowerShell.
pub(crate) fn default_shell() -> String {
    if cfg!(windows) {
        "powershell".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

pub(crate) fn on_path(cmd: &str) -> bool {
    if cmd.contains('/') || cmd.contains('\\') {
        return Path::new(cmd).exists();
    }
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&path).any(|dir| {
        exts.iter().any(|ext| {
            let candidate = dir.join(format!("{cmd}{ext}"));
            candidate.is_file()
        })
    })
}

pub fn list_agents() -> Vec<AgentDef> {
    REGISTRY
        .iter()
        .map(|r| {
            // The shell pane launches the user's real login shell, not the registry
            // literal (which is empty for "shell"). Every other agent is its own name.
            let command = if r.id == "shell" {
                default_shell()
            } else {
                r.command.to_string()
            };
            AgentDef {
                id: r.id,
                name: r.name,
                installed: on_path(&command),
                command,
                args: r.args,
                resume: r.resume,
            }
        })
        .collect()
}

/// True if Claude Code has a persisted transcript for `session_id`. Claude writes
/// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` only after the first turn,
/// so a session that was opened but never used has no transcript and cannot be
/// `--resume`d (it errors with "No conversation found"). Session IDs are UUIDs and
/// globally unique, so we scan every project dir for `<id>.jsonl` rather than
/// reconstructing Claude's cwd→dirname encoding (which is undocumented and brittle).
pub fn claude_session_exists(session_id: &str) -> bool {
    // Defensive: a persisted id must be a bare token, never a path component.
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return false;
    }
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let projects = home.join(".claude").join("projects");
    let file = format!("{session_id}.jsonl");
    match std::fs::read_dir(&projects) {
        Ok(entries) => entries.flatten().any(|e| e.path().join(&file).is_file()),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn claude_session_exists_rejects_non_uuid_path_tokens() {
        // Defensive guard: a stored id must never be treated as a path component,
        // so anything path-like returns false without touching the filesystem.
        assert!(!claude_session_exists(""));
        assert!(!claude_session_exists("../../etc/passwd"));
        assert!(!claude_session_exists("a/b"));
        assert!(!claude_session_exists("a\\b"));
        // A well-formed UUID that does not exist on disk is simply not found.
        assert!(!claude_session_exists(
            "00000000-0000-4000-8000-000000000000"
        ));
    }

    #[test]
    fn list_agents_exposes_the_full_registry() {
        let agents = list_agents();
        assert_eq!(agents.len(), REGISTRY.len());
        let ids: HashSet<_> = agents.iter().map(|a| a.id).collect();
        for expected in [
            "claude", "codex", "gemini", "opencode", "amp", "cursor", "aider", "shell",
        ] {
            assert!(ids.contains(expected), "missing agent {expected}");
        }
        // ids are unique.
        assert_eq!(ids.len(), agents.len());
    }

    #[test]
    fn every_agent_has_a_command() {
        for a in list_agents() {
            assert!(!a.command.is_empty(), "{} command", a.id);
        }
    }

    #[test]
    fn resume_args_match_the_known_agents() {
        let agents = list_agents();
        let claude = agents.iter().find(|a| a.id == "claude").unwrap();
        assert_eq!(claude.resume, ["--continue"]);
        let codex = agents.iter().find(|a| a.id == "codex").unwrap();
        assert_eq!(codex.resume, ["resume", "--last"]);
        let gemini = agents.iter().find(|a| a.id == "gemini").unwrap();
        assert!(gemini.resume.is_empty());
    }

    #[test]
    fn default_shell_is_platform_appropriate() {
        let sh = default_shell();
        if cfg!(windows) {
            assert_eq!(sh, "powershell");
        } else {
            // Honours $SHELL when set, else falls back to /bin/zsh — never bash 3.2.
            assert_eq!(
                sh,
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
            );
            assert_ne!(sh, "bash", "must not launch macOS' frozen /bin/bash");
        }
    }

    #[test]
    fn on_path_resolves_absolute_paths_by_existence() {
        // The running test binary is an absolute path that definitely exists.
        let exe = std::env::current_exe().unwrap();
        assert!(on_path(exe.to_str().unwrap()));

        let missing = exe.with_file_name("surely-not-here-xyz-123");
        assert!(!on_path(missing.to_str().unwrap()));
    }

    #[test]
    fn on_path_rejects_a_bare_command_that_cannot_exist() {
        assert!(!on_path("swarm-nonexistent-binary-zzz"));
    }
}
