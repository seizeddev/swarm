// SPDX-License-Identifier: GPL-3.0-or-later
mod agents;
mod error;
mod git;
mod github;
mod guard;
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
async fn list_worktrees(
    reg: State<'_, WorkspaceRegistry>,
    path: String,
) -> AppResult<Vec<git::WorktreeInfo>> {
    reg.ensure_within_root(&path)?;
    off_thread(move || git::list_worktrees(&path)).await
}

#[tauri::command]
async fn create_worktree(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    branch_name: String,
    base_ref: Option<String>,
) -> AppResult<git::WorktreeInfo> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::create_worktree(&repo_path, &branch_name, base_ref.as_deref())).await
}

#[tauri::command]
async fn remove_worktree(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    name: String,
    force: bool,
) -> AppResult<()> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::remove_worktree(&repo_path, &name, force)).await
}

#[tauri::command]
async fn changes(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
) -> AppResult<Vec<git::FileChange>> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::changes(&worktree_path)).await
}

#[tauri::command]
async fn file_diff(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    file: String,
    staged: bool,
) -> AppResult<String> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::file_diff(&worktree_path, &file, staged)).await
}

#[tauri::command]
async fn file_diff_hunks(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    file: String,
    staged: bool,
) -> AppResult<Vec<git::DiffHunk>> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::file_diff_hunks(&worktree_path, &file, staged)).await
}

#[tauri::command]
async fn diff_stats(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
) -> AppResult<git::DiffStatsInfo> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::diff_stats(&worktree_path)).await
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
async fn list_branches(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
) -> AppResult<Vec<git::BranchInfo>> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::list_branches(&repo_path)).await
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
async fn commit_file_diff(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
    file: String,
) -> AppResult<String> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::commit_file_diff(&repo_path, &oid, &file)).await
}

#[tauri::command]
async fn commit_diff(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<String> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || git::commit_diff(&repo_path, &oid)).await
}

#[tauri::command]
async fn commit_all(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    message: String,
) -> AppResult<String> {
    reg.ensure_within_root(&worktree_path)?;
    off_thread(move || git::commit_all(&worktree_path, &message)).await
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
async fn pr_for_branch(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    branch: String,
) -> AppResult<Option<github::PrInfo>> {
    reg.ensure_within_root(&repo_path)?;
    off_thread(move || github::pr_for_branch(&repo_path, &branch)).await
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

/// Tighten a just-written file to owner read/write only (`0600`) on Unix. No-op
/// elsewhere. Best-effort: a perms failure shouldn't fail the whole write.
#[cfg(unix)]
fn restrict_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_file(_path: &std::path::Path) {}

#[tauri::command]
fn save_session(data: String) -> AppResult<()> {
    let path = swarm_dir()?.join("session.json");
    std::fs::write(&path, data)?;
    restrict_file(&path);
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
            if e.file_name() == std::ffi::OsStr::new("config.toml") {
                continue;
            }
            let target = dst.join(e.file_name());
            if !target.exists() {
                let _ = std::os::unix::fs::symlink(e.path(), &target);
            }
        }
    }
    let mut cfg = std::fs::read_to_string(src.join("config.toml")).unwrap_or_default();
    if !cfg.contains("swarm-notify") {
        cfg.push_str(
            "\n# swarm-notify\nnotify = [\"bash\", \"-c\", \"echo 'Turn complete' >> \\\"$SWARM_EVENT_FILE\\\"\", \"--\"]\n",
        );
    }
    let cfg_path = dst.join("config.toml");
    std::fs::write(&cfg_path, cfg)?;
    // Holds a copy of the user's Codex config (may carry auth-adjacent settings).
    restrict_file(&cfg_path);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair $PATH before anything spawns. A bundled .app launched from Finder/Dock
    // inherits only launchd's minimal PATH, so agent CLIs (claude, codex, …) resolved
    // by bare name in agents::on_path and the PTY CommandBuilder would not be found.
    // This pulls the login-shell PATH into the process env; harmless when run from a
    // terminal (PATH already correct).
    let _ = fix_path_env::fix();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            list_worktrees,
            create_worktree,
            remove_worktree,
            changes,
            file_diff,
            file_diff_hunks,
            diff_stats,
            status_and_stats,
            list_branches,
            git_log,
            commit_all,
            stage,
            unstage,
            stage_all,
            unstage_all,
            commit,
            pr_for_branch,
            pr_list,
            pr_detail,
            gh_login,
            gh_available,
            list_agents,
            claude_session_exists,
            save_session,
            load_session,
            events_dir,
            prepare_codex_home,
            commit_detail,
            commit_file_diff,
            commit_diff,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_set_visible,
            pty_kill,
            pty_alive,
            watch_worktree,
            unwatch_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
