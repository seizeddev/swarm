// SPDX-License-Identifier: GPL-3.0-or-later
mod agent_hooks;
mod agent_session;
mod agents;
mod error;
mod fsperm;
mod git;
mod github;
mod guard;
#[cfg(target_os = "macos")]
mod macos_notify;
mod notify_helper;
mod osc;
mod terminal;
mod watcher;

use error::AppResult;
use guard::WorkspaceRegistry;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use terminal::{SpawnOpts, TerminalManager, UpdateChannel};
use watcher::WatcherManager;

/// Run a blocking git/github call on Tauri's blocking pool. Sync `#[tauri::command]`s
/// run on the main thread and would freeze the UI on a slow libgit2 walk or a `gh`
/// subprocess; this keeps the command `async` while the work happens off-thread.
async fn off_thread<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| error::AppError::Other(e.to_string()))?
}

/// Record a repository root the frontend has explicitly opened. Every
/// path-taking command below is gated on the registry (see `guard.rs`), so this
/// must be called — by the open-repo dialog flow and session restore — before
/// any git/PTY operation on that root.
#[tauri::command]
fn register_root(reg: State<WorkspaceRegistry>, path: String) -> AppResult<()> {
    reg.register(&path)
}

#[tauri::command]
async fn repo_info(reg: State<'_, WorkspaceRegistry>, path: String) -> AppResult<git::RepoInfo> {
    reg.ensure_within_root(&path)?;
    off_thread(move || git::repo_info(&path)).await
}

#[tauri::command]
async fn init_repo(reg: State<'_, WorkspaceRegistry>, path: String) -> AppResult<git::RepoInfo> {
    reg.ensure_within_root(&path)?;
    off_thread(move || git::init_repo(&path)).await
}

#[tauri::command]
async fn file_diff_hunks(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    file: String,
    staged: bool,
) -> AppResult<git::HunkBundle> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::file_diff_hunks(&worktree_path, &file, staged)).await
}

#[tauri::command]
async fn status_and_stats(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
) -> AppResult<git::StatusAndStats> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::status_and_stats(&worktree_path)).await
}

#[tauri::command]
async fn git_log(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    limit: usize,
) -> AppResult<Vec<git::CommitInfo>> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::git_log(&repo_path, limit)).await
}

#[tauri::command]
async fn commit_detail(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<git::CommitDetail> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::commit_detail(&repo_path, &oid)).await
}

#[tauri::command]
async fn commit_diff(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<git::CommitDiff> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::commit_diff(&repo_path, &oid)).await
}

#[tauri::command]
async fn stage(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::stage_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn unstage(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::unstage_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn stage_all(reg: State<'_, WorkspaceRegistry>, worktree_path: String) -> AppResult<()> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::stage_all(&worktree_path)).await
}

#[tauri::command]
async fn unstage_all(reg: State<'_, WorkspaceRegistry>, worktree_path: String) -> AppResult<()> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::unstage_all(&worktree_path)).await
}

#[tauri::command]
async fn commit(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    message: String,
) -> AppResult<String> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::commit(&worktree_path, &message)).await
}

#[tauri::command]
async fn discard(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::discard_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn checkout_ref(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::checkout_ref(&repo_path, &name)).await
}

#[tauri::command]
async fn create_branch(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    name: String,
    start: String,
) -> AppResult<()> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::create_branch(&repo_path, &name, &start)).await
}

#[tauri::command]
async fn reset_to(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
    mode: String,
) -> AppResult<()> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::reset_to(&repo_path, &oid, &mode)).await
}

#[tauri::command]
async fn revert_commit(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<String> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::revert_commit(&repo_path, &oid)).await
}

/// Reveal a path in the OS file manager (Finder/Explorer/`xdg-open`). The path
/// is validated against the registered roots first — same blast-radius guard as
/// every other path-taking command, so the webview can only reveal files inside
/// an opened workspace.
#[tauri::command]
async fn reveal_path(reg: State<'_, WorkspaceRegistry>, path: String) -> AppResult<()> {
    let canon = reg.ensure_within_root(&path)?;
    off_thread(move || {
        #[cfg(target_os = "macos")]
        let mut cmd = {
            let mut c = std::process::Command::new("open");
            c.arg("-R").arg(&canon);
            c
        };
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = std::process::Command::new("explorer");
            c.arg("/select,").arg(&canon);
            c
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut cmd = {
            // No portable "select the file" on Linux; open its parent directory.
            let target = canon.parent().unwrap_or(&canon).to_path_buf();
            let mut c = std::process::Command::new("xdg-open");
            c.arg(target);
            c
        };
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| error::AppError::Other(format!("could not reveal path: {e}")))
    })
    .await
}

#[tauri::command]
async fn pr_checkout(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    number: u64,
) -> AppResult<()> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || github::pr_checkout(&repo_path, number)).await
}

#[tauri::command]
async fn gh_available() -> bool {
    tauri::async_runtime::spawn_blocking(github::gh_available)
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn pr_list(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
) -> AppResult<Vec<github::PrSummary>> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || github::pr_list(&repo_path)).await
}

#[tauri::command]
async fn pr_detail(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    number: u64,
) -> AppResult<Option<github::PrDetail>> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || github::pr_detail(&repo_path, number)).await
}

#[tauri::command]
async fn gh_login() -> Option<String> {
    tauri::async_runtime::spawn_blocking(github::gh_login)
        .await
        .unwrap_or(None)
}

/// The `~/.swarm` directory, created if absent. On Unix it is locked to `0700`
/// (owner-only): it holds the session snapshot and a copy of the user's Codex
/// config, neither of which other local accounts should read.
fn swarm_dir() -> AppResult<std::path::PathBuf> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".swarm"))
        .ok_or_else(|| error::AppError::Other("no home directory".into()))?;
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

#[tauri::command]
fn save_session(data: String) -> AppResult<()> {
    let path = swarm_dir()?.join("session.json");
    std::fs::write(&path, data)?;
    fsperm::restrict_file(&path);
    Ok(())
}

#[tauri::command]
fn load_session() -> Option<String> {
    std::fs::read_to_string(swarm_dir().ok()?.join("session.json")).ok()
}

#[tauri::command]
fn events_dir() -> AppResult<String> {
    let d = swarm_dir()?.join("events");
    std::fs::create_dir_all(&d)?;
    Ok(d.to_string_lossy().into_owned())
}

/// Best-effort: drop pasted-image temp files older than a day so the directory
/// doesn't grow without bound. Any failure (unreadable dir, missing mtime) is
/// ignored — pruning must never block a paste.
fn prune_clipboard_dir(dir: &std::path::Path) {
    const MAX_AGE_SECS: u64 = 24 * 60 * 60;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let aged = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|d| d.as_secs() > MAX_AGE_SECS);
        if aged {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Persist an image pasted into a terminal and return its absolute path. A PTY
/// can't carry raw image bytes, so — like cmux/WezTerm/iTerm2 — the frontend
/// pastes this path and the CLI agent (Claude Code, Codex) reads the image off
/// disk. The bytes arrive base64-encoded straight from the WebKit paste event,
/// which avoids the macOS pasteboard-type mismatch that makes Claude's own
/// `«class PNGf»` read miss WebKit's `public.png` images. `ext` is allowlisted
/// before it reaches the filename.
#[tauri::command]
fn save_clipboard_image(data: String, ext: String) -> AppResult<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| error::AppError::Other(format!("invalid image data: {e}")))?;
    let dir = swarm_dir()?.join("clipboard");
    std::fs::create_dir_all(&dir)?;
    prune_clipboard_dir(&dir);
    let ext = match ext.to_ascii_lowercase().as_str() {
        e @ ("png" | "jpg" | "jpeg" | "gif" | "webp" | "tiff" | "bmp") => e.to_string(),
        _ => "png".to_string(),
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("paste-{stamp}.{ext}"));
    std::fs::write(&path, &bytes)?;
    fsperm::restrict_file(&path);
    Ok(path.to_string_lossy().into_owned())
}

/// Read the system clipboard's text in the native process. The terminal's
/// context-menu "Paste" calls this instead of `navigator.clipboard.readText()`:
/// that JS API raises WKWebView's modal DOM-paste permission prompt (the stray
/// second "Paste" button, plus a multi-second main-thread stall while its nested
/// run loop is up). Reading via the OS clipboard here has no WebView gate. Returns
/// the empty string when the clipboard holds no text (e.g. an image), so the
/// caller simply pastes nothing rather than erroring.
#[tauri::command]
fn read_clipboard_text(app: tauri::AppHandle) -> AppResult<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt as _;
    Ok(app.clipboard().read_text().unwrap_or_default())
}

/// Emit a native notification and, on click, focus the window and tell the
/// frontend which pane to open (`notif:activate`). macOS only: `send_notification`
/// blocks until the user interacts, so it runs on a detached thread — one cheap
/// parked thread per banner, freed when it's clicked or cleared. Other platforms
/// stay on the JS plugin (no desktop click callback there either, but at least a
/// banner). The window is brought to front in Rust; the frontend does the nav.
/// Bring the main window to the front and tell the frontend which pane to open.
/// Shared by the Linux/Windows notification-click paths below (macOS does its
/// own focus + emit inside macos_notify's delegate).
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn focus_and_activate(app: &AppHandle, pane_id: &str, workspace_id: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit(
        "notif:activate",
        serde_json::json!({ "paneId": pane_id, "workspaceId": workspace_id }),
    );
}

/// Emit a native OS notification and, when the user clicks it, focus the window
/// and open the originating pane (`notif:activate`). Each platform uses its own
/// current native API: macOS UNUserNotificationCenter (macos_notify), Linux
/// notify-rust + a "default" action, Windows a WinRT toast with on_activated.
#[tauri::command]
fn notify_os(
    app: AppHandle,
    title: String,
    body: String,
    sound: Option<String>,
    pane_id: String,
    workspace_id: String,
) {
    #[cfg(target_os = "macos")]
    {
        let _ = &app; // window focus + emit happen in the delegate
        macos_notify::notify(&title, &body, sound.as_deref(), &pane_id, &workspace_id);
    }

    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.summary(&title).body(&body).action("default", "Open");
        if let Some(s) = &sound {
            n.sound_name(s);
        }
        if let Ok(handle) = n.show() {
            // `wait_for_action` is synchronous — it blocks this (already
            // spawned) thread on the dbus event loop until the user acts, and
            // hands the closure the action key. Clicking the body fires the
            // "default" action we registered above.
            handle.wait_for_action(|action| {
                if action == "default" {
                    focus_and_activate(&app, &pane_id, &workspace_id);
                }
            });
        }
    });

    #[cfg(target_os = "windows")]
    {
        // Toast activation fires the callback on click; show() returns at once.
        let app_id = app.config().identifier.clone();
        let _ = sound; // the toast uses the system default sound
        let _ = tauri_winrt_notification::Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_action| {
                focus_and_activate(&app, &pane_id, &workspace_id);
                Ok(())
            })
            .show();
    }
}

/// Absolute path to our own executable — handed to agent hooks so they can
/// re-invoke us as the cross-platform `--notify-helper`. Falls back to the bare
/// name (resolved on PATH) if the exe path can't be determined.
fn swarm_bin_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "swarm".into())
}

/// Exposed to the frontend so it can build Claude Code's Stop-hook command
/// (`<bin> --notify-helper claude-stop`).
#[tauri::command]
fn swarm_bin() -> String {
    swarm_bin_path()
}

/// Install turn-completion notification hooks into the real configs of agents
/// without an isolated-config override (Gemini, Cursor, OpenCode, Amp). Gated
/// on each binary being on PATH; idempotent + defensive. Best-effort.
#[tauri::command]
fn install_agent_hooks() {
    agent_hooks::install_all(&swarm_bin_path());
}

/// Inspectable view of the auto-installed agent hooks: which agents are on PATH,
/// which currently carry swarm's hooks, and where their config lives.
#[tauri::command]
fn agent_integrations_status() -> Vec<agent_hooks::IntegrationStatus> {
    agent_hooks::integrations_status(&swarm_bin_path())
}

/// Before/after of an agent's config so the UI can show a real diff before the
/// user applies or removes swarm's hooks.
#[tauri::command]
fn agent_integration_preview(agent: String) -> AppResult<agent_hooks::IntegrationPreview> {
    agent_hooks::integration_preview(&swarm_bin_path(), &agent)
        .ok_or_else(|| error::AppError::Other(format!("unknown agent: {agent}")))
}

#[tauri::command]
fn agent_integration_apply(agent: String) -> AppResult<()> {
    agent_hooks::integration_apply(&swarm_bin_path(), &agent)
        .ok_or_else(|| error::AppError::Other(format!("could not write config for {agent}")))
}

#[tauri::command]
fn agent_integration_remove(agent: String) -> AppResult<()> {
    agent_hooks::integration_remove(&agent)
        .ok_or_else(|| error::AppError::Other(format!("could not update config for {agent}")))
}

/// Prepare an isolated CODEX_HOME that mirrors the user's ~/.codex (so auth/
/// settings carry over) but adds a `notify` program writing to SWARM_EVENT_FILE.
/// The user's real config is never modified.
#[tauri::command]
fn prepare_codex_home() -> AppResult<String> {
    let home = dirs::home_dir().ok_or_else(|| error::AppError::Other("no home".into()))?;
    let src = home.join(".codex");
    let dst = swarm_dir()?.join("codex-home");
    std::fs::create_dir_all(&dst)?;
    #[cfg(unix)]
    if src.is_dir() {
        for e in std::fs::read_dir(&src)?.flatten() {
            // config.toml is rewritten below; hooks.json is ours (don't symlink the
            // user's over it).
            let name = e.file_name();
            if name == std::ffi::OsStr::new("config.toml")
                || name == std::ffi::OsStr::new("hooks.json")
            {
                continue;
            }
            let target = dst.join(name);
            if !target.exists() {
                let _ = std::os::unix::fs::symlink(e.path(), &target);
            }
        }
    }
    let bin = swarm_bin_path();
    // Session-capture hook (cmux-style restore): write hooks.json into the isolated
    // home and trust it in config.toml so a Codex launched from swarm records its
    // session for `codex resume <id>` on restart.
    let hooks_path = dst.join("hooks.json");
    let _ = std::fs::write(&hooks_path, agent_hooks::codex_session_hooks_json(&bin));
    let hooks_real = std::fs::canonicalize(&hooks_path).unwrap_or_else(|_| hooks_path.clone());

    let raw = std::fs::read_to_string(src.join("config.toml")).unwrap_or_default();
    // Codex's `notify` invokes our cross-platform helper with the turn JSON as an
    // argv arg; it forwards the agent's *actual last message* into SWARM_EVENT_FILE.
    let cfg_out = match toml::from_str::<toml::Table>(&raw) {
        Ok(mut cfg) => {
            cfg.insert(
                "notify".into(),
                toml::Value::Array(vec![
                    toml::Value::String(bin.clone()),
                    toml::Value::String("--notify-helper".into()),
                    toml::Value::String("event".into()),
                ]),
            );
            // `[features] hooks = true` enables Codex's hook system.
            if let Some(t) = cfg
                .entry("features".to_string())
                .or_insert_with(|| toml::Value::Table(Default::default()))
                .as_table_mut()
            {
                t.insert("hooks".into(), toml::Value::Boolean(true));
            }
            // `[hooks.state."<key>"] trusted_hash` pre-trusts our hook so Codex runs
            // it without a prompt.
            let (key, hash) = agent_hooks::codex_trust_entry(&bin, &hooks_real.to_string_lossy());
            if let Some(st) = cfg
                .entry("hooks".to_string())
                .or_insert_with(|| toml::Value::Table(Default::default()))
                .as_table_mut()
                .and_then(|ht| {
                    ht.entry("state".to_string())
                        .or_insert_with(|| toml::Value::Table(Default::default()))
                        .as_table_mut()
                })
            {
                let mut entry = toml::map::Map::new();
                entry.insert("trusted_hash".into(), toml::Value::String(hash));
                st.insert(key, toml::Value::Table(entry));
            }
            toml::to_string(&cfg).unwrap_or(raw)
        }
        // Unparseable config: preserve it verbatim and only append the notify line
        // (string form), skipping the hooks rather than risk losing the user's settings.
        Err(_) => {
            let mut s = raw;
            if !s.contains("swarm-notify") {
                let b = bin.replace('\\', "\\\\");
                s.push_str(&format!(
                    "\n# swarm-notify\nnotify = [\"{b}\", \"--notify-helper\", \"event\"]\n",
                ));
            }
            s
        }
    };
    let cfg_path = dst.join("config.toml");
    std::fs::write(&cfg_path, cfg_out)?;
    // Holds a copy of the user's Codex config (may carry auth-adjacent settings).
    fsperm::restrict_file(&cfg_path);
    Ok(dst.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_agents() -> Vec<agents::AgentDef> {
    agents::list_agents()
}

#[tauri::command]
fn claude_session_exists(id: String) -> bool {
    agents::claude_session_exists(&id)
}

/// The native resume command for a pane's captured agent session, or null when
/// there's no restorable capture (no agent ran in that pane, the session is gone,
/// or it was a non-restorable launch). Used on hydrate to bring an agent — and the
/// user's launch flags — back after a restart, cmux-style.
#[tauri::command]
fn agent_session_resume(pane_id: String) -> Option<agent_session::ResumeCommand> {
    agent_session::resume_command(&pane_id)
}

/// Forget a pane's captured agent session (the pane was closed for good).
#[tauri::command]
fn agent_session_forget(pane_id: String) {
    agent_session::forget(&pane_id);
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<TerminalManager>,
    reg: State<WorkspaceRegistry>,
    opts: SpawnOpts,
    on_update: UpdateChannel,
) -> AppResult<String> {
    // A PTY is the most direct path to code execution, so harden the inputs:
    // non-empty command, and a cwd that resolves inside an opened workspace.
    if opts.command.trim().is_empty() {
        return Err(error::AppError::Invalid("empty command".into()));
    }
    reg.ensure_within_root(&opts.cwd)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.spawn(app, id.clone(), opts, on_update)?;
    Ok(id)
}

#[tauri::command]
fn pty_attach(
    state: State<TerminalManager>,
    id: String,
    on_update: UpdateChannel,
) -> AppResult<()> {
    state.attach(&id, on_update)
}

#[tauri::command]
fn pty_write(state: State<TerminalManager>, id: String, data: String) -> AppResult<()> {
    state.write(&id, &data)
}

#[tauri::command]
fn pty_resize(state: State<TerminalManager>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_set_visible(state: State<TerminalManager>, id: String, visible: bool) -> AppResult<()> {
    state.set_visible(&id, visible)
}

#[tauri::command]
fn pty_scroll(state: State<TerminalManager>, id: String, delta: i32) -> AppResult<()> {
    state.scroll(&id, delta)
}

#[tauri::command]
fn pty_selection_text(
    state: State<TerminalManager>,
    id: String,
    start: (usize, usize),
    end: (usize, usize),
) -> AppResult<String> {
    state.selection_text(&id, start, end)
}

#[tauri::command]
fn watch_worktree(
    app: AppHandle,
    state: State<WatcherManager>,
    reg: State<WorkspaceRegistry>,
    workspace_id: String,
    path: String,
) -> AppResult<()> {
    reg.ensure_within_root(&path)?;
    state.watch_worktree(app, workspace_id, path)
}

#[tauri::command]
fn unwatch_worktree(state: State<WatcherManager>, workspace_id: String) {
    state.unwatch_worktree(&workspace_id);
}

#[tauri::command]
fn pty_kill(state: State<TerminalManager>, id: String) -> AppResult<()> {
    state.kill(&id)
}

#[tauri::command]
fn pty_alive(state: State<TerminalManager>, id: String) -> bool {
    state.alive(&id)
}

/// `(pane_id, pty_id)` for every PTY that survived a webview reload, so the
/// reloaded frontend can reattach to its agents instead of re-spawning them.
#[tauri::command]
fn pty_live(state: State<TerminalManager>) -> Vec<(String, String)> {
    state.live_panes()
}

/// Kill every live PTY whose id isn't in `keep` — the frontend's post-hydrate
/// sweep of sessions orphaned by a reload (closed panes / duplicates).
#[tauri::command]
fn pty_reap(state: State<TerminalManager>, keep: Vec<String>) {
    state.reap(&keep);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Agent completion hooks re-invoke us as `swarm --notify-helper <mode>`: do
    // that work and exit before any GUI/Tauri setup. Pure Rust, cross-platform.
    let argv: Vec<String> = std::env::args().collect();
    if let Some(i) = argv.iter().position(|a| a == "--notify-helper") {
        notify_helper::run(&argv[i + 1..]);
        return;
    }

    // Repair $PATH before anything spawns. A bundled .app launched from Finder/Dock
    // inherits only launchd's minimal PATH, so agent CLIs (claude, codex, …) resolved
    // by bare name in agents::on_path and the PTY CommandBuilder would not be found.
    // This pulls the login-shell PATH into the process env; harmless when run from a
    // terminal (PATH already correct).
    let _ = fix_path_env::fix();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init());
    // Self-update plugins are desktop-only; the JS side drives check/install.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .manage(TerminalManager::default())
        .manage(WatcherManager::default())
        .manage(WorkspaceRegistry::default())
        .menu(|app| {
            let app_menu = SubmenuBuilder::new(app, "swarm")
                .about(None)
                .separator()
                .item(
                    &MenuItemBuilder::with_id("settings", "Settings…")
                        .accelerator("CmdOrCtrl+,")
                        .build(app)?,
                )
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                // No native accelerator: ⌘⇧P is owned by a JS keydown handler
                // (App.tsx). A native Shift+letter key-equivalent is consumed by
                // AppKit before the webview *and* matches unreliably in tao/muda,
                // so the menu item is click-only and the shortcut lives in JS.
                .item(&MenuItemBuilder::with_id("command_palette", "Command Palette").build(app)?)
                .separator()
                .item(
                    &MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sidebar")
                        .accelerator("CmdOrCtrl+B")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("panel_scm", "Source Control")
                        .accelerator("CmdOrCtrl+Shift+G")
                        .build(app)?,
                )
                .item(&MenuItemBuilder::with_id("panel_prs", "Pull Requests").build(app)?)
                .item(
                    &MenuItemBuilder::with_id("panel_notifications", "Notifications")
                        .accelerator("CmdOrCtrl+I")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                        .accelerator("CmdOrCtrl+Shift+=")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                        .accelerator("CmdOrCtrl+-")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                        .accelerator("CmdOrCtrl+0")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("agent_integrations", "Agent Integrations…")
                        .build(app)?,
                )
                // ⌘/ is owned by the JS keydown handler (see command_palette note).
                .item(&MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts").build(app)?)
                .separator()
                .fullscreen()
                .build()?;
            let term = SubmenuBuilder::new(app, "Terminal")
                .item(
                    &MenuItemBuilder::with_id("new_terminal", "New Terminal")
                        .accelerator("CmdOrCtrl+T")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("split_right", "Split Right")
                        .accelerator("CmdOrCtrl+D")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("split_down", "Split Down")
                        .accelerator("CmdOrCtrl+Shift+D")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("close_pane", "Close Terminal")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?,
                )
                .build()?;
            let mut proj = SubmenuBuilder::new(app, "Project")
                .item(
                    &MenuItemBuilder::with_id("new_workspace", "New Project…")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("close_workspace", "Close Project")
                        .accelerator("CmdOrCtrl+Shift+W")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("ws_next", "Next Project")
                        .accelerator("CmdOrCtrl+Shift+]")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("ws_prev", "Previous Project")
                        .accelerator("CmdOrCtrl+Shift+[")
                        .build(app)?,
                )
                .separator();
            for i in 1..=9 {
                proj = proj.item(
                    &MenuItemBuilder::with_id(format!("ws_{i}"), format!("Project {i}"))
                        .accelerator(format!("CmdOrCtrl+{i}"))
                        .build(app)?,
                );
            }
            let project = proj.build()?;
            let window = SubmenuBuilder::new(app, "Window").minimize().build()?;
            MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &view, &term, &project, &window])
                .build()
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .setup(|app| {
            // Register the UNUserNotificationCenter delegate (click handling) and
            // request notification authorization. No-op unless bundled.
            #[cfg(target_os = "macos")]
            macos_notify::init(app.handle().clone());
            // Watch ~/.swarm/events (one file per pane) event-driven: an agent
            // appending a line fires `pane:notify` with no interval polling.
            if let Some(home) = dirs::home_dir() {
                let watchers = app.state::<WatcherManager>();
                let dir = home.join(".swarm").join("events");
                let _ = watchers.start_events(app.handle().clone(), dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_root,
            repo_info,
            init_repo,
            file_diff_hunks,
            status_and_stats,
            git_log,
            stage,
            unstage,
            stage_all,
            unstage_all,
            commit,
            discard,
            checkout_ref,
            create_branch,
            reset_to,
            revert_commit,
            reveal_path,
            pr_checkout,
            pr_list,
            pr_detail,
            gh_login,
            gh_available,
            list_agents,
            claude_session_exists,
            save_session,
            load_session,
            save_clipboard_image,
            read_clipboard_text,
            events_dir,
            prepare_codex_home,
            notify_os,
            swarm_bin,
            install_agent_hooks,
            agent_integrations_status,
            agent_integration_preview,
            agent_integration_apply,
            agent_integration_remove,
            agent_session_resume,
            agent_session_forget,
            commit_detail,
            commit_diff,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_scroll,
            pty_selection_text,
            pty_set_visible,
            pty_kill,
            pty_alive,
            pty_live,
            pty_reap,
            watch_worktree,
            unwatch_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
