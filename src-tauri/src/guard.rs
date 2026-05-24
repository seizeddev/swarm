// SPDX-License-Identifier: GPL-3.0-or-later
//! Filesystem blast-radius guard.
//!
//! The strict CSP is swarm's *primary* defence: a compromised frontend can't run
//! arbitrary code in the first place. This is defence-in-depth behind it. Every
//! path-taking command (git operations, PTY `cwd`) is validated against a
//! registry of roots the user *explicitly* opened, so even if the webview were
//! subverted it could only touch repositories already on screen — never a sudden
//! read of `/etc` or a shell spawned in `/`.
//!
//! Mirrors the `TerminalManager`/`WatcherManager` state-manager pattern: a cheap
//! `Clone` wrapper around `Arc<Mutex<…>>` managed by Tauri.

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Canonicalized roots the frontend has explicitly opened (via the native
/// "open repository" dialog or session restore). Containment is checked against
/// these plus the implicit `~/.swarm/worktrees` tree (which swarm itself owns).
#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    roots: Arc<Mutex<HashSet<PathBuf>>>,
}

/// The implicit always-allowed root: `~/.swarm/worktrees`, where `create_worktree`
/// places every worktree it makes. Returns `None` only if there is no home dir.
fn worktrees_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".swarm").join("worktrees"))
}

impl WorkspaceRegistry {
    /// Record a root the user opened. Canonicalizes first so later containment
    /// checks compare resolved (symlink-free) paths on both sides.
    pub fn register(&self, path: &str) -> AppResult<()> {
        let canon = std::fs::canonicalize(path)?;
        self.roots.lock().insert(canon);
        Ok(())
    }

    /// True when `candidate` is one of, or lives under, an allowed root —
    /// the registered roots plus the implicit `worktrees` tree (passed in so the
    /// logic is unit-testable without mutating the process-global `$HOME`).
    fn is_allowed(&self, candidate: &Path, worktrees: Option<&Path>) -> bool {
        // `~/.swarm/worktrees` may not exist yet (no worktree created); compare
        // against the path directly so the implicit allow holds once it does.
        if worktrees.is_some_and(|wt| candidate.starts_with(wt)) {
            return true;
        }
        self.roots.lock().iter().any(|r| candidate.starts_with(r))
    }

    /// Validate that `path` resolves inside an opened workspace (or the worktrees
    /// tree), returning the canonical path. `AppError::Invalid` otherwise — the
    /// same error kind the frontend already handles for bad input.
    pub fn ensure_within_root(&self, path: &str) -> AppResult<PathBuf> {
        let canon = std::fs::canonicalize(path)
            .map_err(|_| AppError::Invalid(format!("path does not resolve: {path}")))?;
        if self.is_allowed(&canon, worktrees_root().as_deref()) {
            Ok(canon)
        } else {
            Err(AppError::Invalid(format!(
                "path is outside any opened workspace: {path}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch() -> PathBuf {
        let p = std::env::temp_dir().join(format!("swarm-guard-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        // Canonicalize so assertions compare against the resolved form (macOS
        // maps /var -> /private/var, /tmp -> /private/tmp).
        std::fs::canonicalize(&p).unwrap()
    }

    #[test]
    fn unregistered_path_is_rejected() {
        let reg = WorkspaceRegistry::default();
        let dir = scratch();
        let err = reg.ensure_within_root(dir.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn registered_root_and_children_are_allowed() {
        let reg = WorkspaceRegistry::default();
        let root = scratch();
        reg.register(root.to_str().unwrap()).unwrap();

        // The root itself.
        assert_eq!(
            reg.ensure_within_root(root.to_str().unwrap()).unwrap(),
            root
        );
        // A nested file/dir under it.
        let child = root.join("src");
        fs::create_dir_all(&child).unwrap();
        assert!(reg.ensure_within_root(child.to_str().unwrap()).is_ok());
    }

    #[test]
    fn sibling_with_shared_prefix_is_not_a_child() {
        // Component-wise containment: `/x/repo-evil` must NOT count as inside `/x/repo`.
        let reg = WorkspaceRegistry::default();
        let base = scratch();
        let root = base.join("repo");
        let sibling = base.join("repo-evil");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        reg.register(root.to_str().unwrap()).unwrap();
        assert!(reg.ensure_within_root(root.to_str().unwrap()).is_ok());
        assert!(reg.ensure_within_root(sibling.to_str().unwrap()).is_err());
    }

    #[test]
    fn nonexistent_path_is_invalid_not_a_panic() {
        let reg = WorkspaceRegistry::default();
        let err = reg
            .ensure_within_root("/surely/not/here/swarm-xyz-123")
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn worktrees_tree_is_implicitly_allowed() {
        // Drive is_allowed directly with a synthetic worktrees root, so the test
        // never mutates the process-global $HOME (which would race git.rs's tests).
        let base = scratch();
        let worktrees = base.join(".swarm").join("worktrees");
        let inside = worktrees.join("repo").join("br");
        let outside = base.join("elsewhere");

        let reg = WorkspaceRegistry::default(); // nothing registered
        assert!(reg.is_allowed(&inside, Some(&worktrees)));
        // The tree root itself and a sibling outside it.
        assert!(reg.is_allowed(&worktrees, Some(&worktrees)));
        assert!(!reg.is_allowed(&outside, Some(&worktrees)));
        // With no worktrees root and no registered roots, nothing is allowed.
        assert!(!reg.is_allowed(&inside, None));
    }
}
