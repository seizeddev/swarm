mod agents;
mod error;
mod git;
mod github;
mod terminal;

use error::AppResult;
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, State};
use terminal::{SpawnOpts, TerminalManager, WireGrid};

#[tauri::command]
fn repo_info(path: String) -> AppResult<git::RepoInfo> {
    git::repo_info(&path)
}

#[tauri::command]
fn list_worktrees(path: String) -> AppResult<Vec<git::WorktreeInfo>> {
    git::list_worktrees(&path)
}

#[tauri::command]
fn create_worktree(
    repo_path: String,
    branch_name: String,
    base_ref: Option<String>,
) -> AppResult<git::WorktreeInfo> {
    git::create_worktree(&repo_path, &branch_name, base_ref.as_deref())
}

#[tauri::command]
fn remove_worktree(repo_path: String, name: String, force: bool) -> AppResult<()> {
    git::remove_worktree(&repo_path, &name, force)
}

#[tauri::command]
fn changes(worktree_path: String) -> AppResult<Vec<git::FileChange>> {
    git::changes(&worktree_path)
}

#[tauri::command]
fn file_diff(worktree_path: String, file: String, staged: bool) -> AppResult<String> {
    git::file_diff(&worktree_path, &file, staged)
}

#[tauri::command]
fn diff_stats(worktree_path: String) -> AppResult<git::DiffStatsInfo> {
    git::diff_stats(&worktree_path)
}

#[tauri::command]
fn list_branches(repo_path: String) -> AppResult<Vec<git::BranchInfo>> {
    git::list_branches(&repo_path)
}

#[tauri::command]
fn git_log(repo_path: String, limit: usize) -> AppResult<Vec<git::CommitInfo>> {
    git::git_log(&repo_path, limit)
}

#[tauri::command]
fn commit_detail(repo_path: String, oid: String) -> AppResult<git::CommitDetail> {
    git::commit_detail(&repo_path, &oid)
}

#[tauri::command]
fn commit_file_diff(repo_path: String, oid: String, file: String) -> AppResult<String> {
    git::commit_file_diff(&repo_path, &oid, &file)
}

#[tauri::command]
fn commit_diff(repo_path: String, oid: String) -> AppResult<String> {
    git::commit_diff(&repo_path, &oid)
}

#[tauri::command]
fn commit_all(worktree_path: String, message: String) -> AppResult<String> {
    git::commit_all(&worktree_path, &message)
}

#[tauri::command]
fn stage(worktree_path: String, paths: Vec<String>) -> AppResult<()> {
    git::stage_paths(&worktree_path, paths)
}

#[tauri::command]
fn unstage(worktree_path: String, paths: Vec<String>) -> AppResult<()> {
    git::unstage_paths(&worktree_path, paths)
}

#[tauri::command]
fn stage_all(worktree_path: String) -> AppResult<()> {
    git::stage_all(&worktree_path)
}

#[tauri::command]
fn unstage_all(worktree_path: String) -> AppResult<()> {
    git::unstage_all(&worktree_path)
}

#[tauri::command]
fn commit(worktree_path: String, message: String) -> AppResult<String> {
    git::commit(&worktree_path, &message)
}

#[tauri::command]
fn pr_for_branch(repo_path: String, branch: String) -> AppResult<Option<github::PrInfo>> {
    github::pr_for_branch(&repo_path, &branch)
}

#[tauri::command]
fn gh_available() -> bool {
    github::gh_available()
}

#[tauri::command]
fn pr_list(repo_path: String) -> AppResult<Vec<github::PrSummary>> {
    github::pr_list(&repo_path)
}

#[tauri::command]
fn gh_login() -> Option<String> {
    github::gh_login()
}

fn swarm_dir() -> AppResult<std::path::PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".swarm"))
        .ok_or_else(|| error::AppError::Other("no home directory".into()))
}

#[tauri::command]
fn save_session(data: String) -> AppResult<()> {
    let dir = swarm_dir()?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("session.json"), data)?;
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
    std::fs::write(dst.join("config.toml"), cfg)?;
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
    opts: SpawnOpts,
    on_grid: Channel<WireGrid>,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    state.spawn(app, id.clone(), opts, on_grid)?;
    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<TerminalManager>, id: String, data: String) -> AppResult<()> {
    state.write(&id, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<Option<WireGrid>> {
    state.resize(&id, cols, rows)
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalManager::default())
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
            // Watch ~/.swarm/events for agent notification files (one per pane).
            // Any agent that appends a line to its file triggers a notification.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let dir = match dirs::home_dir() {
                    Some(h) => h.join(".swarm").join("events"),
                    None => return,
                };
                let _ = std::fs::create_dir_all(&dir);
                let mut seen: std::collections::HashMap<String, (std::time::SystemTime, u64)> =
                    std::collections::HashMap::new();
                let mut first = true;
                loop {
                    if let Ok(rd) = std::fs::read_dir(&dir) {
                        for e in rd.flatten() {
                            let name = e.file_name().to_string_lossy().into_owned();
                            if let Ok(meta) = e.metadata() {
                                let key = (
                                    meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                                    meta.len(),
                                );
                                if seen.get(&name).map(|v| *v != key).unwrap_or(true) {
                                    seen.insert(name.clone(), key);
                                    if !first {
                                        let body = std::fs::read_to_string(e.path())
                                            .ok()
                                            .and_then(|c| c.lines().last().map(str::to_string))
                                            .unwrap_or_default();
                                        let _ = handle.emit(
                                            "pane:notify",
                                            serde_json::json!({ "paneId": name, "body": body }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    first = false;
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repo_info,
            list_worktrees,
            create_worktree,
            remove_worktree,
            changes,
            file_diff,
            diff_stats,
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
            pty_write,
            pty_resize,
            pty_kill,
            pty_alive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
