// SPDX-License-Identifier: GPL-3.0-or-later
//! File-permission helpers used everywhere we touch the user's home dir.
//!
//! Centralised so every site (lib.rs, agent_session.rs, notify_helper.rs) ends up
//! at the same `0600` / `0700` invariant: no other-readable session snapshots,
//! credential captures, or per-agent event files. Best-effort on Unix; a no-op
//! on platforms whose POSIX bits aren't authoritative — there a perms failure
//! must never fail the surrounding write.

use std::fs::OpenOptions;
use std::path::Path;

/// Tighten a just-written file to owner read/write only (`0600`) on Unix. No-op
/// elsewhere. Best-effort: a perms failure shouldn't fail the whole write — the
/// file is the source of truth, not the mode bit.
pub fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path; // unused outside Unix
    }
}

/// Tighten a directory to owner-only (`0700`) on Unix. Same best-effort posture
/// as [`restrict_file`].
pub fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// `OpenOptions` configured for an append-only owner-only log file: create it
/// with mode `0600` on Unix (no race window between create and chmod), append
/// and write enabled. Non-Unix gets the same flags without the mode bit.
#[cfg(unix)]
pub fn open_options_owner_only() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = OpenOptions::new();
    opts.create(true).append(true).write(true).mode(0o600);
    opts
}

#[cfg(not(unix))]
pub fn open_options_owner_only() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true).write(true);
    opts
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every caller below is `#[cfg(unix)]` — on Windows this would otherwise
    // trip the `dead_code` warning that CI's `clippy -D warnings` (Linux) and
    // every Windows `cargo test` run flag.
    #[cfg(unix)]
    fn scratch_dir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("swarm-fsperm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn restrict_file_sets_mode_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir();
        let p = dir.join("x");
        std::fs::write(&p, b"hi").unwrap();
        // Start permissive to prove we actually tighten.
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        restrict_file(&p);
        let m = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600, "expected 0600, got {m:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn restrict_dir_sets_mode_0700_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        restrict_dir(&dir);
        let m = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o700, "expected 0700, got {m:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restrict_file_on_missing_path_is_noop() {
        // Best-effort posture: a missing path must not error or panic.
        let missing =
            std::env::temp_dir().join(format!("swarm-fsperm-missing-{}", uuid::Uuid::new_v4()));
        restrict_file(&missing);
        restrict_dir(&missing);
    }

    #[cfg(unix)]
    #[test]
    fn open_options_owner_only_creates_file_at_0600() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir();
        let path = dir.join("log");
        {
            let mut f = open_options_owner_only().open(&path).unwrap();
            writeln!(f, "line").unwrap();
        }
        let m = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // The newly-created file was opened with `mode(0o600)`, so the kernel
        // applied that mode minus the process umask. We treat anything stricter
        // as fine, but it must never be readable/writable by group/world.
        assert_eq!(m & 0o077, 0, "group/world bits leaked: {m:o}");
        // Append works: a second open extends the file.
        {
            let mut f = open_options_owner_only().open(&path).unwrap();
            writeln!(f, "again").unwrap();
        }
        let read = std::fs::read_to_string(&path).unwrap();
        assert!(read.contains("line"));
        assert!(read.contains("again"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
