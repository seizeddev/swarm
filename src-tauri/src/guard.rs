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
//! Roots only enter the registry through the **native folder picker**: the
//! `pick_workspace` IPC asks Rust to raise an OS dialog and registers whatever
//! the user clicks on — the renderer never gets to call `register`. The set is
//! mirrored to `~/.swarm/trusted-roots.json` (`0600`) so a relaunch can restore
//! it without reissuing the dialog; an entry that no longer canonicalises is
//! silently dropped on load.
//!
//! Mirrors the `TerminalManager`/`WatcherManager` state-manager pattern: a cheap
//! `Clone` wrapper around `Arc<Mutex<…>>` managed by Tauri.

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// On-disk schema for the trusted-roots file. A flat versioned envelope so a
/// future shape change won't silently downgrade the contents.
#[derive(Serialize, Deserialize)]
struct TrustedRoots {
    v: u32,
    roots: Vec<String>,
}

const SCHEMA_V: u32 = 1;

/// Canonicalized roots the user has explicitly opened (via the native
/// "open repository" dialog or session restore). Containment is checked against
/// these registered roots only.
#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    roots: Arc<Mutex<HashSet<PathBuf>>>,
    /// Set once at startup (via `with_persist_path`); when present, every
    /// `register` writes the snapshot back. A bare `OnceLock` so the path is
    /// fixed for the process — no race with concurrent registrations.
    persist_path: Arc<OnceLock<PathBuf>>,
}

impl WorkspaceRegistry {
    /// Configure the persistence file path. Idempotent: a second call is a
    /// no-op (the first wins), since the path is fixed for the process.
    pub fn with_persist_path(&self, path: PathBuf) {
        let _ = self.persist_path.set(path);
    }

    /// Record a root the user opened. Canonicalises first so later containment
    /// checks compare resolved (symlink-free) paths on both sides, then writes
    /// the snapshot to the persist file (if configured). Returns the canonical
    /// path so the caller can use it for the immediate follow-up call (which
    /// it would otherwise have to canonicalise again).
    pub fn register(&self, path: &str) -> AppResult<PathBuf> {
        let canon = std::fs::canonicalize(path)?;
        {
            let mut roots = self.roots.lock();
            roots.insert(canon.clone());
        }
        self.persist();
        Ok(canon)
    }

    /// Snapshot of registered roots, sorted by path for deterministic on-disk output.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self.roots.lock().iter().cloned().collect();
        v.sort();
        v
    }

    /// Write the current snapshot to the persist file (best-effort). Called
    /// after every mutation. A write failure is intentionally swallowed: the
    /// in-memory registry remains correct for the current session, and the
    /// file is reconstructed on the next successful write.
    fn persist(&self) {
        let Some(path) = self.persist_path.get() else {
            return;
        };
        let roots = self
            .roots()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let envelope = TrustedRoots { v: SCHEMA_V, roots };
        let Ok(json) = serde_json::to_string(&envelope) else {
            return;
        };
        if std::fs::write(path, json).is_ok() {
            crate::fsperm::restrict_file(path);
        }
    }

    /// Load roots from a previously persisted snapshot. Entries that no longer
    /// canonicalise (e.g. the user moved/deleted the repo while swarm was off)
    /// are silently dropped. The persist path is set as a side effect, so any
    /// later `register` will rewrite this file.
    pub fn load_trusted(&self, store_path: &Path) -> AppResult<()> {
        self.with_persist_path(store_path.to_path_buf());
        let s = match std::fs::read_to_string(store_path) {
            Ok(s) => s,
            // No prior snapshot yet: that's the first-run case; nothing to do.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let envelope: TrustedRoots = match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(_) => return Ok(()), // unparseable: ignore, will be overwritten on next register
        };
        if envelope.v != SCHEMA_V {
            return Ok(()); // unknown schema — drop the file silently
        }
        let mut loaded = HashSet::new();
        for p in envelope.roots {
            if let Ok(canon) = std::fs::canonicalize(&p) {
                loaded.insert(canon);
            }
        }
        *self.roots.lock() = loaded;
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
        let returned = reg.register(root.to_str().unwrap()).unwrap();
        assert_eq!(returned, root, "register returns the canonical path");

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

    #[test]
    fn c2_trusted_roots_round_trip_through_disk() {
        // Registering a root in one registry must persist to disk; a fresh
        // registry pointed at the same file then loads the root back and
        // accepts paths inside it.
        let store_dir = scratch();
        let store_file = store_dir.join("trusted-roots.json");
        let repo = scratch();
        let nested = repo.join("src");
        fs::create_dir_all(&nested).unwrap();

        let first = WorkspaceRegistry::default();
        first.with_persist_path(store_file.clone());
        first.register(repo.to_str().unwrap()).unwrap();
        assert!(store_file.exists(), "register must write the persist file");

        let second = WorkspaceRegistry::default();
        second.load_trusted(&store_file).unwrap();
        assert!(
            second.ensure_within_root(nested.to_str().unwrap()).is_ok(),
            "reloaded registry must allow children of a previously-registered root"
        );
    }

    #[test]
    fn c2_load_drops_entries_that_no_longer_resolve() {
        // A persisted root that no longer canonicalises (deleted/moved) is
        // silently dropped on load — the registry never trusts a stale path.
        let store_dir = scratch();
        let store_file = store_dir.join("trusted-roots.json");
        let gone = store_dir.join("not-there");
        let envelope = TrustedRoots {
            v: SCHEMA_V,
            roots: vec![gone.to_string_lossy().into_owned()],
        };
        std::fs::write(&store_file, serde_json::to_string(&envelope).unwrap()).unwrap();

        let reg = WorkspaceRegistry::default();
        reg.load_trusted(&store_file).unwrap();
        assert!(reg.roots().is_empty(), "stale root must not load");
    }

    #[cfg(unix)]
    #[test]
    fn h4_ensure_within_root_resolves_symlinks_to_canonical_under_root() {
        // A registered root reached via a symlink whose *target* is under the
        // root must still come back as the canonical (symlink-free) path so
        // downstream commands operate on the resolved location, not on the
        // symlink. Defence-in-depth: a separate process could swing the
        // symlink target out from under us between the registry check and the
        // real call; the canonical path freezes that out.
        use std::os::unix::fs as unix_fs;
        let base = scratch();
        let real_root = base.join("real");
        let link_root = base.join("link");
        fs::create_dir_all(&real_root).unwrap();
        unix_fs::symlink(&real_root, &link_root).unwrap();
        let real_root = std::fs::canonicalize(&real_root).unwrap();

        let reg = WorkspaceRegistry::default();
        reg.register(real_root.to_str().unwrap()).unwrap();

        // Asking with the *symlinked* path returns the canonical (real) form.
        let resolved = reg.ensure_within_root(link_root.to_str().unwrap()).unwrap();
        assert_eq!(resolved, real_root);

        // A nested path through the symlink resolves to its canonical location too.
        let nested = real_root.join("src");
        fs::create_dir_all(&nested).unwrap();
        let via_link = link_root.join("src");
        let resolved = reg.ensure_within_root(via_link.to_str().unwrap()).unwrap();
        assert_eq!(resolved, nested);
    }

    #[cfg(unix)]
    #[test]
    fn h4_ensure_within_root_rejects_symlink_pointing_outside_root() {
        // A path that canonicalises *outside* every registered root must be
        // rejected, even if the surface path looks like it's inside. (`tmp/
        // root/safe-looking` → `/etc/passwd`).
        use std::os::unix::fs as unix_fs;
        let base = scratch();
        let root = base.join("root");
        let outside = base.join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "do not reach").unwrap();
        let symlink = root.join("escape");
        unix_fs::symlink(&outside, &symlink).unwrap();

        let reg = WorkspaceRegistry::default();
        reg.register(root.to_str().unwrap()).unwrap();

        let err = reg
            .ensure_within_root(symlink.to_str().unwrap())
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "got {err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn c2_persist_file_is_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let store_dir = scratch();
        let store_file = store_dir.join("trusted-roots.json");
        let repo = scratch();

        let reg = WorkspaceRegistry::default();
        reg.with_persist_path(store_file.clone());
        reg.register(repo.to_str().unwrap()).unwrap();

        let m = std::fs::metadata(&store_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600, "persist file must be owner-only, got {m:o}");
    }
}
