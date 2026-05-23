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
