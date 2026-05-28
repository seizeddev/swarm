// SPDX-License-Identifier: GPL-3.0-or-later
//! Filesystem watchers, replacing interval polling with `notify` (FSEvents on
//! macOS, inotify on Linux, kqueue on the BSDs). Two kinds:
//!
//!  - one global watcher on `~/.swarm/events`: an agent appending to its file
//!    fires `pane:notify` immediately, with no 700 ms poll and no `seen` map.
//!  - one watcher per open worktree: any change, debounced ~300 ms, fires
//!    `fs:changed` so the frontend can refresh git status live.
//!
//! Watcher handles live in a `State`-managed map (analogous to `TerminalManager`):
//! adding/removing a workspace adds/drops its watcher.

use crate::error::{AppError, AppResult};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GIT_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Default)]
struct WatcherState {
    /// Global watcher on the agent-events directory; kept alive for app lifetime.
    events: Option<RecommendedWatcher>,
    /// One watcher per workspace id; dropping it stops the watch (and its thread).
    worktrees: HashMap<String, RecommendedWatcher>,
}

#[derive(Clone, Default)]
pub struct WatcherManager {
    inner: Arc<Mutex<WatcherState>>,
}

/// Read the last non-empty line of a file (the agent's latest notification body).
fn last_line(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| c.lines().last().map(str::to_string))
        .unwrap_or_default()
}

/// Hard cap on the per-pane dedup map so it can't grow forever across a long
/// session that visits many pane ids. At the cap we just clear it: dedup state
/// is best-effort (the worst case is a single duplicate notification right
/// after the wipe), and a bounded eviction policy would buy nothing here.
const PANE_DEDUP_CAP: usize = 1024;

/// True when `(name, body)` differs from the last seen entry for `name` (so the
/// caller should emit). Updates `last` to remember the new body. Guarded by
/// [`PANE_DEDUP_CAP`] so the map can't grow without bound.
fn bump_dedup(last: &mut HashMap<String, String>, name: &str, body: &str) -> bool {
    if last.get(name).is_some_and(|b| b == body) {
        return false;
    }
    if last.len() >= PANE_DEDUP_CAP {
        last.clear();
    }
    last.insert(name.to_string(), body.to_string());
    true
}

impl WatcherManager {
    /// Start the global agent-events watcher. Pre-existing files don't fire events
    /// (no change), so there's no startup spam and no need for a "first run" guard.
    pub fn start_events(&self, app: AppHandle, dir: std::path::PathBuf) -> AppResult<()> {
        std::fs::create_dir_all(&dir)?;
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| AppError::Other(e.to_string()))?;
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Other(e.to_string()))?;

        std::thread::spawn(move || {
            // Dedup identical content per pane so one logical notification (which
            // can arrive as several create/modify events) emits once.
            let mut last: HashMap<String, String> = HashMap::new();
            while let Ok(Ok(event)) = rx.recv() {
                if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    continue;
                }
                for path in event.paths {
                    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned())
                    else {
                        continue;
                    };
                    let body = last_line(&path);
                    if !bump_dedup(&mut last, &name, &body) {
                        continue;
                    }
                    let _ = app.emit(
                        "pane:notify",
                        serde_json::json!({ "paneId": name, "body": body }),
                    );
                }
            }
        });

        self.inner.lock().events = Some(watcher);
        Ok(())
    }

    /// Watch a worktree for changes; emits a debounced `fs:changed { workspaceId }`.
    pub fn watch_worktree(
        &self,
        app: AppHandle,
        workspace_id: String,
        path: String,
    ) -> AppResult<()> {
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| AppError::Other(e.to_string()))?;
        watcher
            .watch(Path::new(&path), RecursiveMode::Recursive)
            .map_err(|e| AppError::Other(e.to_string()))?;

        let emit_id = workspace_id.clone();
        std::thread::spawn(move || loop {
            // Block for the first event, then coalesce the burst: keep draining
            // until the tree has been quiet for the debounce window, then emit once.
            if rx.recv().is_err() {
                break; // watcher dropped → workspace closed
            }
            loop {
                match rx.recv_timeout(GIT_DEBOUNCE) {
                    Ok(_) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("fs:changed", serde_json::json!({ "workspaceId": emit_id }));
        });

        // Replacing an existing entry drops the old watcher (and ends its thread).
        self.inner.lock().worktrees.insert(workspace_id, watcher);
        Ok(())
    }

    /// Stop watching a worktree (drops the watcher and lets its thread exit).
    pub fn unwatch_worktree(&self, workspace_id: &str) {
        self.inner.lock().worktrees.remove(workspace_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn last_line_reads_final_nonempty_line() {
        let dir = std::env::temp_dir().join(format!("swarm-w-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("pane-1");
        let mut file = std::fs::File::create(&f).unwrap();
        writeln!(file, "first").unwrap();
        writeln!(file, "second").unwrap();
        assert_eq!(last_line(&f), "second");
    }

    #[test]
    fn last_line_of_missing_file_is_empty() {
        assert_eq!(last_line(Path::new("/no/such/swarm/file")), "");
    }

    #[test]
    fn unwatch_unknown_workspace_is_a_noop() {
        let m = WatcherManager::default();
        m.unwatch_worktree("nope"); // must not panic
    }

    #[test]
    fn bump_dedup_dedupes_and_caps_the_map() {
        let mut last: HashMap<String, String> = HashMap::new();

        // First sighting → emit; second identical sighting → skip.
        assert!(bump_dedup(&mut last, "p1", "hello"));
        assert!(!bump_dedup(&mut last, "p1", "hello"));
        // Body change for the same pane → emit again.
        assert!(bump_dedup(&mut last, "p1", "world"));
        assert_eq!(last.get("p1").map(String::as_str), Some("world"));

        // Push past the cap with distinct pane ids: the map must never grow
        // past PANE_DEDUP_CAP entries. At cap we clear and re-seed, so the size
        // oscillates but stays bounded — the only observable effect is a single
        // duplicate notification right after the wipe.
        last.clear();
        for i in 0..(PANE_DEDUP_CAP * 3) {
            assert!(bump_dedup(&mut last, &format!("pane-{i}"), "x"));
            assert!(last.len() <= PANE_DEDUP_CAP, "grew to {}", last.len());
        }
        assert!(last.contains_key(&format!("pane-{}", PANE_DEDUP_CAP * 3 - 1)));
    }
}
