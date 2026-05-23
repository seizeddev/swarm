use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub accent: &'static str,
    pub installed: bool,
    /// Args that resume the agent's most recent session in the cwd (for restore).
    pub resume: &'static [&'static str],
}

struct Reg {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    accent: &'static str,
    resume: &'static [&'static str],
}

const fn reg(
    id: &'static str,
    name: &'static str,
    command: &'static str,
    accent: &'static str,
    resume: &'static [&'static str],
) -> Reg {
    Reg {
        id,
        name,
        command,
        args: &[],
        accent,
        resume,
    }
}

const REGISTRY: &[Reg] = &[
    reg(
        "claude",
        "Claude Code",
        "claude",
        "#D77757",
        &["--continue"],
    ),
    reg("codex", "Codex", "codex", "#10A37F", &["resume", "--last"]),
    reg("gemini", "Gemini", "gemini", "#4285F4", &[]),
    reg("opencode", "OpenCode", "opencode", "#F2B705", &[]),
    reg("amp", "Amp", "amp", "#9B6DFF", &[]),
    reg("cursor", "Cursor CLI", "cursor-agent", "#7DD3FC", &[]),
    reg("aider", "Aider", "aider", "#22C55E", &[]),
    reg("shell", "Shell", default_shell(), "#8B8B8B", &[]),
];

const fn default_shell() -> &'static str {
    if cfg!(windows) {
        "powershell"
    } else {
        "bash"
    }
}

fn on_path(cmd: &str) -> bool {
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
        .map(|r| AgentDef {
            id: r.id,
            name: r.name,
            command: r.command,
            args: r.args,
            accent: r.accent,
            installed: on_path(r.command),
            resume: r.resume,
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
    fn every_agent_has_a_hex_accent_and_command() {
        for a in list_agents() {
            assert!(a.accent.starts_with('#'), "{} accent", a.id);
            assert_eq!(a.accent.len(), 7, "{} accent is #RRGGBB", a.id);
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
            assert_eq!(sh, "bash");
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
