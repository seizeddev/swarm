// SPDX-License-Identifier: GPL-3.0-or-later
mod agent_hooks;
mod agents;
mod error;
mod git;
mod github;
mod guard;
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
) -> AppResult<String> {
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

/// Emit a native notification and, on click, focus the window and tell the
/// frontend which pane to open (`notif:activate`). macOS only: `send_notification`
/// blocks until the user interacts, so it runs on a detached thread — one cheap
/// parked thread per banner, freed when it's clicked or cleared. Other platforms
/// stay on the JS plugin (no desktop click callback there either, but at least a
/// banner). The window is brought to front in Rust; the frontend does the nav.
/// Bring the main window to the front and tell the frontend which pane to open.
/// Shared by every platform's notification-click path below.
#[cfg(desktop)]
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
/// and open the originating pane (`notif:activate`). Every platform has its own
/// click mechanism, so each is handled separately; on macOS/Linux the call
/// blocks until interaction, so it runs on a detached thread.
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
    std::thread::spawn(move || {
        let mut opts = mac_notification_sys::Notification::new();
        if let Some(s) = &sound {
            opts.sound(s.as_str());
        }
        let resp = mac_notification_sys::send_notification(&title, None, &body, Some(&opts));
        // A click on the banner body (or its default action) means "take me
        // there"; close/none/reply/error → nothing.
        if matches!(
            resp,
            Ok(mac_notification_sys::NotificationResponse::Click)
                | Ok(mac_notification_sys::NotificationResponse::ActionButton(_))
        ) {
            focus_and_activate(&app, &pane_id, &workspace_id);
        }
    });

    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.summary(&title).body(&body).action("default", "Open");
        if let Some(s) = &sound {
            n.sound_name(s);
        }
        if let Ok(handle) = n.show() {
            // The freedesktop backend is async (zbus); clicking the body fires
            // the "default" action. Drive it on Tauri's runtime.
            tauri::async_runtime::block_on(handle.wait_for_action(
                |res: &notify_rust::ActionResponse| {
                    if let notify_rust::ActionResponse::Custom(a) = res {
                        if *a == "default" {
                            focus_and_activate(&app, &pane_id, &workspace_id);
                        }
                    }
                },
            ));
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
    // Codex's `notify` invokes our cross-platform helper with the turn JSON as
    // an argv arg; it forwards the agent's *actual last message* into
    // SWARM_EVENT_FILE, where the events watcher turns it into a `pane:notify`.
    let mut cfg = std::fs::read_to_string(src.join("config.toml")).unwrap_or_default();
    if !cfg.contains("swarm-notify") {
        // TOML basic strings: backslashes (Windows paths) must be escaped.
        let bin = swarm_bin_path().replace('\\', "\\\\");
        cfg.push_str(&format!(
            "\n# swarm-notify\nnotify = [\"{bin}\", \"--notify-helper\", \"event\"]\n",
        ));
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
            // Deliver notifications under our own bundle id (not the Finder
            // default mac-notification-sys would otherwise pick). Once-guarded.
            #[cfg(target_os = "macos")]
            let _ = mac_notification_sys::set_application(&app.config().identifier);
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
            file_diff_hunks,
            status_and_stats,
            git_log,
            stage,
            unstage,
            stage_all,
            unstage_all,
            commit,
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
            notify_os,
            swarm_bin,
            install_agent_hooks,
            commit_detail,
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
