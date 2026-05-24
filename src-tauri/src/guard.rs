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
/// these registered roots only.
#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    roots: Arc<Mutex<HashSet<PathBuf>>>,
}

impl WorkspaceRegistry {
    /// Record a root the user opened. Canonicalizes first so later containment
    /// checks compare resolved (symlink-free) paths on both sides.
    pub fn register(&self, path: &str) -> AppResult<()> {
        let canon = std::fs::canonicalize(path)?;
        self.roots.lock().insert(canon);
        Ok(())
    }

    /// True when `candidate` is one of, or lives under, a registered root.
    fn is_allowed(&self, candidate: &Path) -> bool {
        self.roots.lock().iter().any(|r| candidate.starts_with(r))
    }

    /// Validate that `path` resolves inside an opened workspace, returning the
    /// canonical path. `AppError::Invalid` otherwise — the same error kind the
    /// frontend already handles for bad input.
    pub fn ensure_within_root(&self, path: &str) -> AppResult<PathBuf> {
        let canon = std::fs::canonicalize(path)
            .map_err(|_| AppError::Invalid(format!("path does not resolve: {path}")))?;
        if self.is_allowed(&canon) {
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
    fn nothing_is_allowed_without_a_registered_root() {
        let base = scratch();
        let candidate = base.join("repo").join("src");
        let reg = WorkspaceRegistry::default(); // nothing registered
        assert!(!reg.is_allowed(&candidate));
    }
}
