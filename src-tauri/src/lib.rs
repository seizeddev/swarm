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
use tauri_plugin_dialog::DialogExt;
use terminal::{SpawnOpts, SpawnResult, TerminalManager, UpdateChannel};
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

/// Validate `path` against the registered workspace roots and return the
/// **canonical** form as an owned `String`. Every git/github/PTY command that
/// takes a path uses this so the downstream call operates on the canonicalised
/// (symlink-resolved) path — defence-in-depth against a registered root being
/// reached by a symlink whose target moves out from under us between
/// `ensure_within_root` and the actual call. Cheap shorthand for
/// `reg.ensure_within_root(path)?.to_string_lossy().into_owned()`.
fn ensured(reg: &WorkspaceRegistry, path: &str) -> AppResult<String> {
    Ok(reg.ensure_within_root(path)?.to_string_lossy().into_owned())
}

/// Raise the OS folder picker, register whatever the user clicks on as a trusted
/// root, and return that root's repo info. Replaces the renderer-side dialog +
/// `register_root` IPC pair, so the registry is now a real security boundary:
/// the renderer can no longer authorize an arbitrary path. `Ok(None)` when the
/// user cancels the dialog.
///
/// The blocking variant of the picker is wrapped in `spawn_blocking` so it never
/// parks the async IPC task; the OS picker itself runs on its own main-thread
/// runloop, which is what `tauri-plugin-dialog`'s `blocking_pick_folder`
/// underneath wraps with a oneshot channel.
#[tauri::command]
async fn pick_workspace(
    app: AppHandle,
    reg: State<'_, WorkspaceRegistry>,
) -> AppResult<Option<git::RepoInfo>> {
    let app2 = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .set_title("Open a git repository")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| error::AppError::Other(e.to_string()))?;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| error::AppError::Other(e.to_string()))?;
    let canon = reg.register(path.to_str().unwrap_or_default())?;
    let canon_s = canon.to_string_lossy().into_owned();
    let info = off_thread(move || git::repo_info(&canon_s)).await?;
    // `repo_info` resolves to the canonical workdir — re-register it in case it
    // differs (the user opened a worktree or a symlinked path).
    if info.path != canon.to_string_lossy() {
        reg.register(&info.path)?;
    }
    Ok(Some(info))
}

#[tauri::command]
async fn repo_info(reg: State<'_, WorkspaceRegistry>, path: String) -> AppResult<git::RepoInfo> {
    let path = ensured(&reg, &path)?;
    off_thread(move || git::repo_info(&path)).await
}

/// Session-restore variant of `repo_info`. A persisted workspace whose path no
/// longer canonicalises (the user renamed/moved/deleted the folder while swarm
/// was off) used to throw `AppError::Invalid` from `ensured`, and the frontend
/// silently dropped that workspace from the sidebar. The user saw a tab just
/// vanish with no hint where the work went and no way to repoint it.
///
/// This IPC returns `None` for that case instead of erroring, so the renderer
/// can keep a "missing" stub in the sidebar (greyed-out, with Locate + Forget
/// actions). When the path *does* still resolve, we go through the normal trust
/// check (the session.json roots are loaded in `setup()` before any IPC
/// dispatch, so existence implies a trusted root).
#[tauri::command]
async fn repo_info_for_restore(
    reg: State<'_, WorkspaceRegistry>,
    path: String,
) -> AppResult<Option<git::RepoInfo>> {
    if std::fs::metadata(&path).is_err() {
        return Ok(None);
    }
    let path = ensured(&reg, &path)?;
    off_thread(move || git::repo_info(&path)).await.map(Some)
}

#[tauri::command]
async fn init_repo(reg: State<'_, WorkspaceRegistry>, path: String) -> AppResult<git::RepoInfo> {
    let path = ensured(&reg, &path)?;
    off_thread(move || git::init_repo(&path)).await
}

#[tauri::command]
async fn file_diff_hunks(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    file: String,
    staged: bool,
) -> AppResult<git::HunkBundle> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::file_diff_hunks(&worktree_path, &file, staged)).await
}

#[tauri::command]
async fn status_and_stats(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
) -> AppResult<git::StatusAndStats> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::status_and_stats(&worktree_path)).await
}

#[tauri::command]
async fn git_log(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    limit: usize,
) -> AppResult<Vec<git::CommitInfo>> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::git_log(&repo_path, limit)).await
}

#[tauri::command]
async fn commit_detail(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<git::CommitDetail> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::commit_detail(&repo_path, &oid)).await
}

#[tauri::command]
async fn commit_diff(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<git::CommitDiff> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::commit_diff(&repo_path, &oid)).await
}

#[tauri::command]
async fn stage(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::stage_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn unstage(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::unstage_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn stage_all(reg: State<'_, WorkspaceRegistry>, worktree_path: String) -> AppResult<()> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::stage_all(&worktree_path)).await
}

#[tauri::command]
async fn unstage_all(reg: State<'_, WorkspaceRegistry>, worktree_path: String) -> AppResult<()> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::unstage_all(&worktree_path)).await
}

#[tauri::command]
async fn commit(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    message: String,
) -> AppResult<String> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::commit(&worktree_path, &message)).await
}

#[tauri::command]
async fn discard(
    reg: State<'_, WorkspaceRegistry>,
    worktree_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let worktree_path = ensured(&reg, &worktree_path)?;
    off_thread(move || git::discard_paths(&worktree_path, paths)).await
}

#[tauri::command]
async fn checkout_ref(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::checkout_ref(&repo_path, &name)).await
}

#[tauri::command]
async fn create_branch(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    name: String,
    start: String,
) -> AppResult<()> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::create_branch(&repo_path, &name, &start)).await
}

#[tauri::command]
async fn reset_to(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
    mode: String,
) -> AppResult<()> {
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || git::reset_to(&repo_path, &oid, &mode)).await
}

#[tauri::command]
async fn revert_commit(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    oid: String,
) -> AppResult<String> {
    let repo_path = ensured(&reg, &repo_path)?;
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
    let repo_path = ensured(&reg, &repo_path)?;
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
    let repo_path = ensured(&reg, &repo_path)?;
    off_thread(move || github::pr_list(&repo_path)).await
}

#[tauri::command]
async fn pr_detail(
    reg: State<'_, WorkspaceRegistry>,
    repo_path: String,
    number: u64,
) -> AppResult<Option<github::PrDetail>> {
    let repo_path = ensured(&reg, &repo_path)?;
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

/// On-disk schema mirror of `src/lib/persist.ts::Snap`. We only need the
/// envelope shape to **validate** the JSON the frontend sends — the actual
/// pane/layout state is opaque to Rust and gets written through verbatim. The
/// schema check rejects a malformed snapshot before it lands on disk, so a
/// later hydrate can't crash the app on a corrupted/partial save.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // every field is read by serde's deserialize, not by us
struct SessionEnvelope {
    v: u32,
    active_workspace_id: Option<String>,
    workspaces: Vec<serde_json::Value>,
}

/// Subset of the session schema we read at startup to register each
/// workspace's root. Anything that lands in `session.json` was written there
/// by swarm itself — it's the persisted record of "the user opened these
/// folders" — so we treat it as the authority on trusted roots.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRootsWorkspace {
    repo_path: String,
}
#[derive(serde::Deserialize)]
struct SessionRoots {
    workspaces: Vec<SessionRootsWorkspace>,
}

/// Register the workspace roots listed in `session.json`. Called from
/// `setup()` after `load_trusted`, **unconditionally** and additively: the
/// session file is the user-state-of-record, so every restart should make
/// its workspaces' paths trusted again — `trusted-roots.json` may have
/// diverged (e.g. it was added later, or it lists a different set), and we
/// never want hydrate to drop a workspace just because the two files don't
/// agree. `register` canonicalises; a path that no longer exists is silently
/// skipped (the workspace will fall out at hydrate time, same as before).
fn load_workspace_roots_from_session(reg: &WorkspaceRegistry, swarm_dir: &std::path::Path) {
    let session_path = swarm_dir.join("session.json");
    let Ok(raw) = std::fs::read_to_string(&session_path) else {
        return;
    };
    let Ok(sess) = serde_json::from_str::<SessionRoots>(&raw) else {
        return;
    };
    for ws in sess.workspaces {
        let _ = reg.register(&ws.repo_path);
    }
}

#[tauri::command]
fn save_session(data: String) -> AppResult<()> {
    // Schema-validate before write: a malformed snapshot (renderer bug,
    // truncated paste-into-config attack, …) must not overwrite a good one.
    // `serde_json::from_str::<SessionEnvelope>` accepts both `camelCase` and
    // `snake_case` thanks to the frontend's serializer; if the shape doesn't
    // match, the write is refused and the prior session.json is preserved.
    let _: SessionEnvelope = serde_json::from_str(&data)
        .map_err(|e| error::AppError::Invalid(format!("session schema: {e}")))?;
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
    fsperm::restrict_dir(&d);
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
/// Build the `notify = [...]` TOML array literal for Codex's verbatim-append
/// fallback. The naïve format `"{bin}"` breaks the moment `bin` contains a
/// quote or backslash — `toml::Value::String` handles every TOML escaping rule
/// (quotes, control chars, backslashes) byte-correctly. Tested with a golden
/// round-trip back through `toml::from_str`.
fn codex_notify_string(bin: &str) -> String {
    let arr = toml::Value::Array(vec![
        toml::Value::String(bin.to_string()),
        toml::Value::String("--notify-helper".into()),
        toml::Value::String("event".into()),
    ]);
    arr.to_string()
}

/// Per-paste size cap for clipboard images. WKWebView's paste event will
/// happily hand us a multi-hundred-megabyte buffer if a user pastes a photo
/// from a different app, and the agent can't usefully consume an image that
/// large anyway. 32 MiB is well above any reasonable screenshot and well
/// below the point where the encoded base64 round-trip starts to cost a
/// noticeable fraction of a second.
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[tauri::command]
fn save_clipboard_image(data: String, ext: String) -> AppResult<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| error::AppError::Other(format!("invalid image data: {e}")))?;
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err(error::AppError::Invalid(format!(
            "image too large: {} bytes (max {} bytes)",
            bytes.len(),
            MAX_CLIPBOARD_IMAGE_BYTES
        )));
    }
    let dir = swarm_dir()?.join("clipboard");
    std::fs::create_dir_all(&dir)?;
    fsperm::restrict_dir(&dir);
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
    fsperm::restrict_dir(&dst);
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
    fsperm::restrict_file(&hooks_path);
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
                s.push_str(&format!(
                    "\n# swarm-notify\nnotify = {}\n",
                    codex_notify_string(&bin)
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

/// Parse `s` and confirm it carries an http(s) scheme. Extracted so the gate is
/// unit-testable without invoking the OS opener. Any other scheme — `file:`,
/// `javascript:`, custom URI handlers — is refused at the Rust boundary, so the
/// renderer can no longer talk to `tauri-plugin-opener::open_url` directly
/// (the corresponding `opener:allow-open-url` capability was removed).
fn validate_external_url(s: &str) -> AppResult<url::Url> {
    let parsed =
        url::Url::parse(s).map_err(|e| error::AppError::Invalid(format!("bad url: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(error::AppError::Invalid(format!(
            "refusing scheme: {}",
            parsed.scheme()
        )));
    }
    Ok(parsed)
}

/// Open an external URL through the OS handler. Scheme-gated to http(s) so a
/// subverted webview can't push a `file:` / `javascript:` / custom-scheme URL
/// into `xdg-open`/`open`/`ShellExecute`.
#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> AppResult<()> {
    let parsed = validate_external_url(&url)?;
    use tauri_plugin_opener::OpenerExt as _;
    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|e| error::AppError::Other(e.to_string()))
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
) -> AppResult<SpawnResult> {
    // A PTY is the most direct path to code execution, so harden the inputs:
    // non-empty command, allowlisted against the registry + the user's login
    // shell (a renderer must not be able to spawn `/usr/bin/curl …`), and a cwd
    // that resolves inside an opened workspace.
    if opts.command.trim().is_empty() {
        return Err(error::AppError::Invalid("empty command".into()));
    }
    if !terminal::is_allowed_command(&opts.command) {
        return Err(error::AppError::Invalid(format!(
            "command not allowed: {}",
            opts.command
        )));
    }
    reg.ensure_within_root(&opts.cwd)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.spawn(app, id, opts, on_update)
}

/// Re-bind a still-running PTY in the SAME page (a pane component remounted).
/// The caller proves it's still the legitimate owner by presenting the sealed
/// token it received from `pty_spawn` (or the latest `pty_reattach`). The
/// post-reload "I'm a fresh page" path uses `pty_reattach` instead, which
/// rotates the token.
#[tauri::command]
fn pty_attach(
    state: State<TerminalManager>,
    id: String,
    token: String,
    on_update: UpdateChannel,
) -> AppResult<()> {
    state.attach(&id, &token, on_update)
}

/// Cross-page reattach for a webview that just reloaded: bind to the PTY
/// backing `paneId` and **rotate** its sealed token. The pre-reload page's
/// token is invalidated by the rotation, so even if some script in the dead
/// page is still parked, it can no longer write into our pane. Returns the
/// fresh `(id, token)`; the frontend stores both and uses them for every later
/// mutating call. `NotFound` when no PTY survives for that pane.
#[tauri::command]
fn pty_reattach(
    state: State<TerminalManager>,
    pane_id: String,
    on_update: UpdateChannel,
) -> AppResult<SpawnResult> {
    state.reattach(&pane_id, on_update)
}

#[tauri::command]
fn pty_write(
    state: State<TerminalManager>,
    id: String,
    token: String,
    data: String,
) -> AppResult<()> {
    state.write(&id, &token, &data)
}

#[tauri::command]
fn pty_resize(
    state: State<TerminalManager>,
    id: String,
    token: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.resize(&id, &token, cols, rows)
}

#[tauri::command]
fn pty_set_visible(
    state: State<TerminalManager>,
    id: String,
    token: String,
    visible: bool,
) -> AppResult<()> {
    state.set_visible(&id, &token, visible)
}

#[tauri::command]
fn pty_scroll(
    state: State<TerminalManager>,
    id: String,
    token: String,
    delta: i32,
) -> AppResult<()> {
    state.scroll(&id, &token, delta)
}

#[tauri::command]
fn pty_selection_text(
    state: State<TerminalManager>,
    id: String,
    token: String,
    start: (usize, usize),
    end: (usize, usize),
) -> AppResult<String> {
    state.selection_text(&id, &token, start, end)
}

#[tauri::command]
fn watch_worktree(
    app: AppHandle,
    state: State<WatcherManager>,
    reg: State<WorkspaceRegistry>,
    workspace_id: String,
    path: String,
) -> AppResult<()> {
    let path = ensured(&reg, &path)?;
    state.watch_worktree(app, workspace_id, path)
}

#[tauri::command]
fn unwatch_worktree(state: State<WatcherManager>, workspace_id: String) {
    state.unwatch_worktree(&workspace_id);
}

#[tauri::command]
fn pty_kill(state: State<TerminalManager>, id: String, token: String) -> AppResult<()> {
    state.kill(&id, &token)
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
            // Trust roots are loaded from two sources at startup, both
            // additive (a path listed in either becomes trusted):
            //
            //   1. `trusted-roots.json` — the canonical persistence file
            //      `pick_workspace` writes to, so a freshly-picked workspace
            //      survives even before the frontend's debounced session
            //      save lands.
            //   2. `session.json` — the persisted state-of-record. Every
            //      workspace in it was opened by swarm itself in a prior run,
            //      so it's a legitimate trust source. Reading from it here
            //      means a session full of workspaces always restores cleanly
            //      regardless of whether `trusted-roots.json` happens to have
            //      drifted (e.g. a session that pre-dates the C-2 file).
            //
            // Failures are non-fatal: a fresh registry just starts empty, and
            // the native folder picker refills it.
            if let Ok(dir) = swarm_dir() {
                let store = dir.join("trusted-roots.json");
                let reg = app.state::<WorkspaceRegistry>();
                let _ = reg.load_trusted(&store);
                load_workspace_roots_from_session(&reg, &dir);
            }
            // Watch ~/.swarm/events (one file per pane) event-driven: an agent
            // appending a line fires `pane:notify` with no interval polling.
            if let Some(home) = dirs::home_dir() {
                let watchers = app.state::<WatcherManager>();
                let dir = home.join(".swarm").join("events");
                let _ = watchers.start_events(app.handle().clone(), dir);
            }
            // Refresh every installed agent integration hook to point at the
            // *current* swarm binary, synchronously, before the webview can
            // spawn any agent pane. This is what keeps SessionStart from
            // firing `/bin/sh: …/swarm: No such file` after the user renames
            // the parent repo, moves swarm.app, or runs `cargo clean` — the
            // strip-then-add in `plan_json` replaces a stale entry with the
            // current one. The frontend's startup install call still runs
            // (belt-and-suspenders, e.g. PATH change between launches), but
            // we no longer race it against pane restore.
            agent_hooks::install_all(&swarm_bin_path());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            repo_info,
            repo_info_for_restore,
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
            open_external_url,
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
            pty_reattach,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_workspace_roots_from_session_registers_every_repo_path() {
        // Both auther and valewnrt are in session.json. Without this loader
        // a hydrate would call repoInfo on each and `ensure_within_root`
        // would reject — empty state. The loader registers them so hydrate
        // sees them as trusted.
        let scratch =
            std::env::temp_dir().join(format!("swarm-roots-from-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let repo_a = scratch.join("repo-a");
        let repo_b = scratch.join("repo-b");
        std::fs::create_dir_all(&repo_a).unwrap();
        std::fs::create_dir_all(&repo_b).unwrap();
        let session_json = serde_json::json!({
            "v": 1,
            "activeWorkspaceId": null,
            "workspaces": [
                { "id": "ws-1", "repoPath": repo_a.to_string_lossy(),
                  "panes": [], "tabs": [], "panel": "scm", "activeTab": null },
                { "id": "ws-2", "repoPath": repo_b.to_string_lossy(),
                  "panes": [], "tabs": [], "panel": "scm", "activeTab": null },
            ],
        });
        std::fs::write(scratch.join("session.json"), session_json.to_string()).unwrap();

        let reg = WorkspaceRegistry::default();
        load_workspace_roots_from_session(&reg, &scratch);
        assert!(reg.ensure_within_root(repo_a.to_str().unwrap()).is_ok());
        assert!(reg.ensure_within_root(repo_b.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn load_workspace_roots_from_session_is_additive_to_trusted_roots() {
        // Regression: a `trusted-roots.json` listing `kept` plus a
        // `session.json` listing `extra` must end up trusting BOTH — earlier
        // code skipped the session.json read whenever the registry already
        // had any entries, which left a non-empty trusted-roots silently
        // shadowing the session.json restore (the exact reported bug).
        let scratch =
            std::env::temp_dir().join(format!("swarm-roots-add-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let kept = scratch.join("kept");
        let extra = scratch.join("extra");
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::create_dir_all(&extra).unwrap();

        let reg = WorkspaceRegistry::default();
        reg.with_persist_path(scratch.join("trusted-roots.json"));
        reg.register(kept.to_str().unwrap()).unwrap();

        let session_json = serde_json::json!({
            "v": 1,
            "activeWorkspaceId": null,
            "workspaces": [
                { "id": "ws-1", "repoPath": extra.to_string_lossy(),
                  "panes": [], "tabs": [], "panel": "scm", "activeTab": null },
            ],
        });
        std::fs::write(scratch.join("session.json"), session_json.to_string()).unwrap();

        load_workspace_roots_from_session(&reg, &scratch);
        // BOTH roots are now trusted — the pre-existing `kept` AND the
        // session.json-only `extra`.
        assert!(reg.ensure_within_root(kept.to_str().unwrap()).is_ok());
        assert!(reg.ensure_within_root(extra.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn load_workspace_roots_from_session_is_a_noop_without_file() {
        // No session.json on disk: must not panic, must not register
        // anything.
        let scratch =
            std::env::temp_dir().join(format!("swarm-roots-noop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let reg = WorkspaceRegistry::default();
        load_workspace_roots_from_session(&reg, &scratch);
        assert!(reg.roots().is_empty());
        std::fs::remove_dir_all(&scratch).ok();
    }

    #[cfg(unix)]
    #[test]
    fn l1_events_dir_creates_with_0700_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let path = events_dir().expect("events_dir must succeed when $HOME is set");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "events dir should be 0700, got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn l1_clipboard_dir_creates_with_0700_on_unix() {
        // `save_clipboard_image` creates `~/.swarm/clipboard` lazily — we
        // pre-create it through the same chmod path and verify the mode.
        use std::os::unix::fs::PermissionsExt;
        let dir = swarm_dir().unwrap().join("clipboard");
        std::fs::create_dir_all(&dir).unwrap();
        fsperm::restrict_dir(&dir);
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "clipboard dir should be 0700, got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn m4_swarm_dir_creates_with_0700_on_unix() {
        // `swarm_dir` is called at process start (via `load_trusted` in
        // `setup`), so ~/.swarm exists with mode 0700 BEFORE the first
        // session.json or event-file write — no race window where the dir
        // sits permissively while we populate it. We exercise the helper
        // directly and confirm the bits.
        use std::os::unix::fs::PermissionsExt;
        let dir = swarm_dir().expect("swarm_dir must succeed when $HOME is set");
        assert!(dir.is_dir(), "swarm_dir created the directory");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0700, got {mode:o}");
    }

    #[test]
    fn l3_codex_notify_string_round_trips_a_quote_in_bin_path() {
        // Verbatim-append fallback must produce a TOML array literal that
        // parses back to the same three strings, no matter what's in the bin
        // path. The hand-rolled `"{bin}"` format broke on quotes/backslashes;
        // `toml::Value::String` handles every escaping rule the spec requires.
        let nasty = r#"/p/a"b\c/swarm"#;
        let line = format!("notify = {}", codex_notify_string(nasty));
        // Parse the synthesised line back.
        let parsed: toml::Table = toml::from_str(&line).expect("must parse");
        let arr = parsed["notify"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0].as_str().unwrap(), nasty);
        assert_eq!(arr[1].as_str().unwrap(), "--notify-helper");
        assert_eq!(arr[2].as_str().unwrap(), "event");
    }

    #[test]
    fn m2_save_session_rejects_invalid_schema() {
        // Garbage in: must not overwrite the prior session. We exercise the
        // schema check via the SessionEnvelope deserialise, which is what
        // `save_session` does before any write.
        let r: Result<SessionEnvelope, _> = serde_json::from_str("{not json");
        assert!(r.is_err());
        let r: Result<SessionEnvelope, _> = serde_json::from_str(r#"{"v":1,"workspaces":"oops"}"#);
        assert!(r.is_err(), "workspaces must be an array");
        let r: Result<SessionEnvelope, _> = serde_json::from_str(r#"{"v":"x"}"#);
        assert!(r.is_err(), "v must be a number");
    }

    #[test]
    fn m2_save_session_accepts_a_well_formed_envelope() {
        // The minimum valid shape (mirrors `persist.ts::Snap`): the actual
        // pane/layout state stays opaque (a `serde_json::Value` array).
        let env: SessionEnvelope =
            serde_json::from_str(r#"{"v":1,"activeWorkspaceId":"ws-1","workspaces":[]}"#)
                .expect("well-formed envelope must parse");
        assert_eq!(env.v, 1);
        assert_eq!(env.active_workspace_id.as_deref(), Some("ws-1"));
        assert!(env.workspaces.is_empty());
    }

    #[test]
    fn m2_clipboard_image_size_cap_constant_is_32_mib() {
        // Asserting the constant value (not just that the cap exists) so a
        // future "let's bump this up" change at least surfaces in code review.
        assert_eq!(MAX_CLIPBOARD_IMAGE_BYTES, 32 * 1024 * 1024);
    }

    #[test]
    fn h2_validate_external_url_accepts_http_and_https() {
        let u = validate_external_url("https://github.com/x/y").unwrap();
        assert_eq!(u.scheme(), "https");
        assert!(validate_external_url("http://example.com/").is_ok());
    }

    #[test]
    fn h2_validate_external_url_rejects_file_scheme() {
        // A subverted webview must not be able to push `file:///etc/passwd`
        // into the OS opener (which would happily resolve it to a viewer).
        let err = validate_external_url("file:///etc/passwd").unwrap_err();
        assert!(matches!(err, error::AppError::Invalid(_)), "got {err:?}");
    }

    #[test]
    fn h2_validate_external_url_rejects_javascript_scheme() {
        // `javascript:` is a no-op in a sandboxed external opener on most OSes,
        // but treat it as outright invalid so we don't even hand it to the OS.
        let err = validate_external_url("javascript:alert(1)").unwrap_err();
        assert!(matches!(err, error::AppError::Invalid(_)));
    }

    #[test]
    fn h2_validate_external_url_rejects_unparseable_input() {
        // No scheme, no host, no nothing: must fail parse cleanly.
        let err = validate_external_url("not a url at all").unwrap_err();
        assert!(matches!(err, error::AppError::Invalid(_)));
    }

    #[test]
    fn h2_validate_external_url_rejects_custom_scheme() {
        // A registered URI handler (e.g. `slack://`, `cursor://`) could open a
        // privileged native app — refuse before the OS dispatches it.
        assert!(validate_external_url("slack://channel/x").is_err());
        assert!(validate_external_url("itms-apps://x").is_err());
    }
}
