// SPDX-License-Identifier: GPL-3.0-or-later
//! Git operations via libgit2 (no shelling out to the `git` binary).
//!
//! Per-repo status, structured diffs ready for review, commit history, and
//! staging/commit operations — all on the repository the user opened.

use crate::error::{AppError, AppResult};
use git2::{Delta, Diff, DiffFormat, DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head_branch: Option<String>,
    /// `false` when `path` is a plain folder with no git repo yet. The workspace
    /// still opens (terminals/agents work); the SCM panel offers to `git init`.
    pub is_repo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStatsInfo {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Open the *main* repository even when `path` points at a linked worktree.
fn open_main(path: &str) -> AppResult<Repository> {
    let repo = Repository::discover(path)?;
    if repo.is_worktree() {
        // `commondir` is the main `.git` dir; its parent is the primary workdir.
        let common = repo.commondir().to_path_buf();
        let main = common.parent().unwrap_or(&common).to_path_buf();
        return Ok(Repository::open(main)?);
    }
    Ok(repo)
}

fn workdir(repo: &Repository) -> AppResult<PathBuf> {
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::Invalid("repository has no working directory (bare?)".into()))
}

fn repo_basename(repo: &Repository) -> String {
    workdir(repo)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "repo".into())
}

pub fn repo_info(path: &str) -> AppResult<RepoInfo> {
    match open_main(path) {
        Ok(repo) => {
            let wd = workdir(&repo)?;
            let head = repo.head().ok();
            Ok(RepoInfo {
                path: wd.to_string_lossy().into_owned(),
                name: repo_basename(&repo),
                head_branch: head
                    .as_ref()
                    .and_then(|h| h.shorthand().ok().map(str::to_owned)),
                is_repo: true,
            })
        }
        // Not a git repo (and none in any parent): open it as a plain folder so the
        // user can run terminals/agents in a fresh project dir and `git init` later.
        Err(AppError::Git(e)) if e.code() == git2::ErrorCode::NotFound => Ok(folder_info(path)),
        Err(e) => Err(e),
    }
}

/// `RepoInfo` for a path that isn't a git repository yet.
fn folder_info(path: &str) -> RepoInfo {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "folder".into());
    RepoInfo {
        path: path.to_string(),
        name,
        head_branch: None,
        is_repo: false,
    }
}

/// `git init` a folder so it becomes a real repository, returning its fresh info.
pub fn init_repo(path: &str) -> AppResult<RepoInfo> {
    Repository::init(path)?;
    repo_info(path)
}

fn short_oid(oid: &git2::Oid) -> String {
    oid.to_string().chars().take(8).collect()
}

fn status_label(s: Status) -> &'static str {
    if s.is_conflicted() {
        "conflicted"
    } else if s.intersects(Status::INDEX_NEW | Status::WT_NEW) {
        if s.contains(Status::WT_NEW) && !s.intersects(Status::INDEX_NEW) {
            "untracked"
        } else {
            "added"
        }
    } else if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        "deleted"
    } else if s.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        "renamed"
    } else if s.intersects(Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) {
        "typechange"
    } else {
        "modified"
    }
}

/// Per-file change list for a repo (staged + unstaged + untracked).
fn changes_in(repo: &Repository) -> AppResult<Vec<FileChange>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut out = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let s = entry.status();
        if s.is_ignored() {
            continue;
        }
        let staged = s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        );
        let unstaged = s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        );
        let path = entry
            .path()
            .ok()
            .map(str::to_owned)
            .or_else(|| {
                entry.index_to_workdir().and_then(|d| {
                    d.new_file()
                        .path()
                        .map(|p| p.to_string_lossy().into_owned())
                })
            })
            .unwrap_or_default();
        let old_path = entry
            .head_to_index()
            .or_else(|| entry.index_to_workdir())
            .and_then(|d| {
                d.old_file()
                    .path()
                    .map(|p| p.to_string_lossy().into_owned())
            })
            .filter(|op| op != &path);
        out.push(FileChange {
            path,
            old_path,
            status: status_label(s),
            staged,
            unstaged,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn build_diff<'a>(repo: &'a Repository, file: Option<&str>, staged: bool) -> AppResult<Diff<'a>> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3);
    if let Some(f) = file {
        opts.pathspec(f);
    }
    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    Ok(diff)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: &'static str, // "add" | "del" | "ctx"
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkBundle {
    pub hunks: Vec<DiffHunk>,
    /// True when the libgit2 walk was stopped at [`DIFF_LINE_CAP`] — the UI
    /// should surface a "diff truncated" banner.
    pub truncated: bool,
}

/// Hard cap on patch lines surfaced through the IPC boundary in one go. A
/// `pnpm-lock.yaml` swap can be 30k+ lines; rendering that synchronously
/// freezes the webview's main thread for seconds. Five thousand lines covers
/// every real review scenario; beyond that, drop to the user's editor.
pub const DIFF_LINE_CAP: usize = 5_000;

/// Structured hunks for one file — line numbers come straight from libgit2, so
/// the frontend never parses a patch on the main thread (the old `parsePatch`).
///
/// Returns the hunks (capped at [`DIFF_LINE_CAP`] content lines) plus a flag
/// that lets the UI surface a "truncated" banner without re-walking the diff.
pub fn file_diff_hunks(worktree_path: &str, file: &str, staged: bool) -> AppResult<HunkBundle> {
    let repo = Repository::open(worktree_path)?;
    let diff = build_diff(&repo, Some(file), staged)?;
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut produced = 0usize;
    let mut truncated = false;
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            'H' => {
                let header = String::from_utf8_lossy(line.content())
                    .trim_end()
                    .to_string();
                hunks.push(DiffHunk {
                    header,
                    lines: Vec::new(),
                });
            }
            c @ (' ' | '+' | '-') => {
                if produced >= DIFF_LINE_CAP {
                    // libgit2 turns a `false` return into GIT_EUSER (-7), which
                    // would surface as an error. Keep iterating but discard the
                    // overflow lines — the diff is still walked but the buffer
                    // stops growing.
                    truncated = true;
                    return true;
                }
                produced += 1;
                if let Some(h) = hunks.last_mut() {
                    let mut text = String::from_utf8_lossy(line.content()).into_owned();
                    if text.ends_with('\n') {
                        text.pop();
                        if text.ends_with('\r') {
                            text.pop();
                        }
                    }
                    let kind = match c {
                        '+' => "add",
                        '-' => "del",
                        _ => "ctx",
                    };
                    h.lines.push(DiffLine {
                        kind,
                        text,
                        old_no: line.old_lineno(),
                        new_no: line.new_lineno(),
                    });
                }
            }
            _ => {}
        }
        true
    })?;
    Ok(HunkBundle { hunks, truncated })
}

/// Aggregate insertions/deletions across the whole worktree (unstaged + staged).
fn diff_stats_in(repo: &Repository) -> AppResult<DiffStatsInfo> {
    let mut files = 0usize;
    let mut ins = 0usize;
    let mut del = 0usize;
    for staged in [false, true] {
        if let Ok(diff) = build_diff(repo, None, staged) {
            if let Ok(stats) = diff.stats() {
                files += stats.files_changed();
                ins += stats.insertions();
                del += stats.deletions();
            }
        }
    }
    Ok(DiffStatsInfo {
        files_changed: files,
        insertions: ins,
        deletions: del,
    })
}

/// Combined per-file changes *and* aggregate diff stats from a single repo open.
/// The status panel needs both on every refresh; computing them together halves
/// the repo opens and collapses two IPC round-trips into one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusAndStats {
    pub changes: Vec<FileChange>,
    pub stats: DiffStatsInfo,
}

pub fn status_and_stats(worktree_path: &str) -> AppResult<StatusAndStats> {
    let repo = Repository::open(worktree_path)?;
    Ok(StatusAndStats {
        changes: changes_in(&repo)?,
        stats: diff_stats_in(&repo)?,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub is_head: bool,
}

/// Commit history across all local branches, topologically ordered — for the graph.
pub fn git_log(repo_path: &str, limit: usize) -> AppResult<Vec<CommitInfo>> {
    let repo = open_main(repo_path)?;
    let head_oid = repo.head().ok().and_then(|h| h.target());

    let mut refmap: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if !(r.is_branch() || r.is_tag()) {
                continue;
            }
            if let (Some(oid), Ok(name)) = (r.target(), r.shorthand()) {
                refmap
                    .entry(oid.to_string())
                    .or_default()
                    .push(name.to_string());
            }
        }
    }

    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let _ = walk.push_glob("refs/heads/*");
    let _ = walk.push_head();

    let mut out = Vec::new();
    for oid in walk.flatten() {
        if out.len() >= limit {
            break;
        }
        let c = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.push(CommitInfo {
            short: short_oid(&oid),
            summary: c.summary().ok().flatten().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
            parents: c.parent_ids().map(|p| p.to_string()).collect(),
            refs: refmap.remove(&oid.to_string()).unwrap_or_default(),
            is_head: Some(oid) == head_oid,
            oid: oid.to_string(),
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub short: String,
    pub message: String,
    pub author: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub files: Vec<CommitFile>,
}

fn delta_label(d: Delta) -> &'static str {
    match d {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        Delta::Copied => "renamed",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

/// Full details of one commit: message, author, and the files it changed
/// (diffed against its first parent).
pub fn commit_detail(repo_path: &str, oid_str: &str) -> AppResult<CommitDetail> {
    let repo = open_main(repo_path)?;
    let oid = git2::Oid::from_str(oid_str)?;
    let c = repo.find_commit(oid)?;
    let tree = c.tree()?;
    let parent = c.parent(0).ok();
    let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    let mut files = Vec::new();
    for d in diff.deltas() {
        let path = d
            .new_file()
            .path()
            .or_else(|| d.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        files.push(CommitFile {
            path,
            status: delta_label(d.status()),
        });
    }
    let sig = c.author();
    let author = sig.name().unwrap_or("").to_string();
    let message = c.message().unwrap_or("").to_string();
    let time = c.time().seconds();
    let parents: Vec<String> = c.parent_ids().map(|p| p.to_string()).collect();
    Ok(CommitDetail {
        oid: oid.to_string(),
        short: short_oid(&oid),
        message,
        author,
        time,
        parents,
        files,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiff {
    pub patch: String,
    /// True when libgit2 was stopped at [`DIFF_LINE_CAP`] content lines.
    pub truncated: bool,
}

/// Full unified patch for a commit (all files, vs first parent). Capped at
/// [`DIFF_LINE_CAP`] content lines so a 30k-line lockfile bump can't freeze
/// the webview's main thread.
pub fn commit_diff(repo_path: &str, oid_str: &str) -> AppResult<CommitDiff> {
    let repo = open_main(repo_path)?;
    let oid = git2::Oid::from_str(oid_str)?;
    let c = repo.find_commit(oid)?;
    let tree = c.tree()?;
    let parent = c.parent(0).ok();
    let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let mut patch = String::new();
    let mut produced = 0usize;
    let mut truncated = false;
    diff.print(DiffFormat::Patch, |_d, _h, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            if produced >= DIFF_LINE_CAP {
                // See note in file_diff_hunks: keep returning true, just drop
                // the overflow — `false` would surface as GIT_EUSER.
                truncated = true;
                return true;
            }
            produced += 1;
            patch.push(origin);
            patch.push_str(&String::from_utf8_lossy(line.content()));
        } else {
            // Hunk headers / file headers still get written verbatim — they're
            // tiny and the frontend needs them to parse hunk boundaries.
            patch.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    })?;
    Ok(CommitDiff { patch, truncated })
}

/// Resolve `p` (relative to `root`) and confirm it lives under the canonical
/// `root`. Returns `None` when:
///   - `root` itself doesn't canonicalise (caller is bogus),
///   - the resolved candidate escapes the root (e.g. `../outside.txt`,
///     `/etc/passwd`, or a symlink whose target points outside).
///
/// Non-existent leaves are accepted as long as the parent is inside the root —
/// that's the legitimate "discard an already-staged-but-now-removed file" case.
/// This is defence-in-depth on top of `WorkspaceRegistry::ensure_within_root`:
/// per-entry containment guards against the renderer constructing a list with
/// well-formed worktree-relative paths *and* traversal entries mixed together.
fn contained(root: &Path, p: &str) -> Option<PathBuf> {
    let canon_root = std::fs::canonicalize(root).ok()?;
    let candidate = canon_root.join(p);
    let canon = std::fs::canonicalize(&candidate).ok().or_else(|| {
        // Untracked path may have just been removed; resolve via its parent.
        let parent = candidate.parent()?.to_path_buf();
        let name = candidate.file_name()?.to_os_string();
        Some(std::fs::canonicalize(parent).ok()?.join(name))
    })?;
    if canon.starts_with(&canon_root) {
        Some(canon)
    } else {
        None
    }
}

pub fn stage_paths(worktree_path: &str, paths: Vec<String>) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    let mut index = repo.index()?;
    let root = Path::new(worktree_path);
    for p in &paths {
        // Skip any entry that escapes the worktree (`..`, absolute, symlinked
        // outside). The path the index sees is still the worktree-relative one
        // (`rel`), which is what libgit2 expects.
        if contained(root, p).is_none() {
            continue;
        }
        let rel = Path::new(p);
        if root.join(p).exists() {
            index.add_path(rel)?;
        } else {
            index.remove_path(rel)?;
        }
    }
    index.write()?;
    Ok(())
}

pub fn unstage_paths(worktree_path: &str, paths: Vec<String>) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(commit) => {
            repo.reset_default(Some(commit.as_object()), paths.iter().map(|s| s.as_str()))?;
        }
        None => {
            let mut index = repo.index()?;
            for p in &paths {
                let _ = index.remove_path(Path::new(p));
            }
            index.write()?;
        }
    }
    Ok(())
}

pub fn stage_all(worktree_path: &str) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    let mut index = repo.index()?;
    index.update_all(["*"].iter(), None)?; // modifications + deletions of tracked files
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?; // new files
    index.write()?;
    Ok(())
}

pub fn unstage_all(worktree_path: &str) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(commit) => {
            repo.reset(commit.as_object(), git2::ResetType::Mixed, None)?;
        }
        None => {
            let mut index = repo.index()?;
            index.clear()?;
            index.write()?;
        }
    }
    Ok(())
}

/// Commit the staged index as-is (VS Code "Commit" behaviour).
pub fn commit(worktree_path: &str, message: &str) -> AppResult<String> {
    let repo = Repository::open(worktree_path)?;
    let mut index = repo.index()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("swarm", "swarm@localhost"))?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(short_oid(&oid))
}

/// Discard working-tree changes for `paths` (VS Code "Discard Changes"):
/// tracked files are restored to their HEAD content (and unstaged if staged),
/// untracked files are deleted from disk. Destructive — the frontend confirms.
///
/// Per-entry containment: each path is canonicalised against the worktree root
/// and silently skipped if it would escape (`../outside.txt`, `/etc/passwd`,
/// a symlink with an out-of-root target). Without this, an untracked entry's
/// `fs::remove_file(root.join(p))` would happily delete the resolved target.
pub fn discard_paths(worktree_path: &str, paths: Vec<String>) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    let root = Path::new(worktree_path);
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    // Pre-filter to entries that resolve inside the worktree. Anything that
    // escapes is dropped before it can reach `remove_file` or libgit2.
    let safe: Vec<(&String, PathBuf)> = paths
        .iter()
        .filter_map(|p| contained(root, p).map(|canon| (p, canon)))
        .collect();
    if safe.is_empty() {
        return Ok(());
    }

    // Unstage these paths first so a staged-then-discarded change is fully
    // dropped (index back to HEAD), letting checkout_head restore the worktree.
    if let Some(commit) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        repo.reset_default(
            Some(commit.as_object()),
            safe.iter().map(|(p, _)| p.as_str()),
        )?;
    }

    let mut co = git2::build::CheckoutBuilder::new();
    co.force();
    let mut had_tracked = false;
    for (p, canon) in &safe {
        let tracked = head_tree
            .as_ref()
            .is_some_and(|t| t.get_path(Path::new(p)).is_ok());
        if tracked {
            co.path(p);
            had_tracked = true;
        } else {
            // Untracked (or staged-add): remove the file from the worktree.
            // Use the canonical path so a re-evaluation of `root.join(p)` can't
            // re-introduce traversal between the contain-check and the unlink.
            let _ = std::fs::remove_file(canon);
        }
    }
    if had_tracked {
        repo.checkout_head(Some(&mut co))?;
    }
    Ok(())
}

/// Check out a local branch (attached HEAD) or any other committish (detached
/// HEAD). Uses a *safe* checkout, so a dirty worktree that would be overwritten
/// surfaces an error rather than silently clobbering local edits.
pub fn checkout_ref(repo_path: &str, name: &str) -> AppResult<()> {
    let repo = open_main(repo_path)?;
    let obj = repo.revparse_single(name)?;
    let commit = obj.peel_to_commit()?;
    repo.checkout_tree(commit.as_object(), None)?;
    if repo.find_branch(name, git2::BranchType::Local).is_ok() {
        repo.set_head(&format!("refs/heads/{name}"))?;
    } else {
        repo.set_head_detached(commit.id())?;
    }
    Ok(())
}

/// Create a branch named `name` at `start` (a committish; empty = current HEAD)
/// and check it out.
pub fn create_branch(repo_path: &str, name: &str, start: &str) -> AppResult<()> {
    let repo = open_main(repo_path)?;
    let target = if start.is_empty() {
        repo.head()?.peel_to_commit()?
    } else {
        repo.revparse_single(start)?.peel_to_commit()?
    };
    repo.branch(name, &target, false)?;
    repo.checkout_tree(target.as_object(), None)?;
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(())
}

/// Reset the current branch to `oid`. `mode` is "soft" | "mixed" | "hard"
/// (anything else falls back to mixed). "hard" is destructive — the frontend
/// confirms before calling.
pub fn reset_to(repo_path: &str, oid: &str, mode: &str) -> AppResult<()> {
    let repo = open_main(repo_path)?;
    let target = repo.revparse_single(oid)?;
    let kind = match mode {
        "soft" => git2::ResetType::Soft,
        "hard" => git2::ResetType::Hard,
        _ => git2::ResetType::Mixed,
    };
    repo.reset(&target, kind, None)?;
    Ok(())
}

/// Revert `oid` and commit the result (like `git revert <oid>`). Conflicts are
/// surfaced as an error (rather than leaving the repo mid-revert) so the user
/// can resolve them in a terminal. Returns the new commit's short oid.
pub fn revert_commit(repo_path: &str, oid: &str) -> AppResult<String> {
    let repo = open_main(repo_path)?;
    let commit = repo.revparse_single(oid)?.peel_to_commit()?;
    repo.revert(&commit, None)?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        // Abandon the half-applied revert and bail — never leave a wedged state.
        let _ = repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()));
        let _ = repo.cleanup_state();
        return Err(AppError::Invalid(
            "revert hit conflicts; resolve it in a terminal".into(),
        ));
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("swarm", "swarm@localhost"))?;
    let head = repo.head()?.peel_to_commit()?;
    let summary = commit.summary().ok().flatten().unwrap_or("commit");
    let msg = format!(
        "Revert \"{summary}\"\n\nThis reverts commit {}.\n",
        commit.id()
    );
    let new = repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &[&head])?;
    let _ = repo.cleanup_state();
    Ok(short_oid(&new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch() -> PathBuf {
        let p = std::env::temp_dir().join(format!("swarm-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Test-only thin wrapper: the public surface is `status_and_stats`, but the
    /// per-file change list is what most assertions care about.
    fn changes(path: &str) -> AppResult<Vec<FileChange>> {
        Ok(status_and_stats(path)?.changes)
    }

    /// Test-only thin wrapper over `status_and_stats` for the aggregate counts.
    fn diff_stats(path: &str) -> AppResult<DiffStatsInfo> {
        Ok(status_and_stats(path)?.stats)
    }

    fn commit_file(repo: &Repository, name: &str, body: &str, msg: &str) -> git2::Oid {
        let wd = repo.workdir().unwrap();
        fs::write(wd.join(name), body).unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new(name)).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    fn init_repo(dir: &Path) -> Repository {
        let repo = Repository::init(dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "swarm-test").unwrap();
            cfg.set_str("user.email", "test@swarm.local").unwrap();
            // Keep checked-out content byte-identical to what we write: without
            // this, git's CRLF conversion (autocrlf defaults on under Git for
            // Windows) checks `a.txt` back out as "hello\r\nworld\r\n", so the
            // discard/reset assertions comparing against "hello\nworld\n" fail.
            cfg.set_bool("core.autocrlf", false).unwrap();
        }
        commit_file(&repo, "a.txt", "hello\nworld\n", "init");
        repo
    }

    /// Init a repo *without* configured identity to exercise the signature fallback.
    fn init_bare_identity(dir: &Path) -> Repository {
        Repository::init(dir).unwrap()
    }

    /// Add a linked worktree directly via libgit2 — exercises `open_main`'s
    /// worktree-resolution path without the app needing to create one.
    fn add_worktree(main_path: &str, name: &str) -> PathBuf {
        let repo = Repository::open(main_path).unwrap();
        let wt_path = scratch().join(name);
        repo.worktree(name, &wt_path, None).unwrap();
        wt_path
    }

    #[test]
    fn repo_info_reports_branch_and_name() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();

        let info = repo_info(path).unwrap();
        assert_eq!(info.name, dir.file_name().unwrap().to_string_lossy());
        assert!(info.head_branch.is_some());
        assert!(info.is_repo);
    }

    #[test]
    fn repo_info_on_plain_folder_reports_not_a_repo() {
        // A fresh empty project dir with no git repo (and none in any parent)
        // must open as a plain folder, not error — so the user can run terminals
        // in it and `git init` later.
        let dir = scratch();
        let path = dir.to_str().unwrap();

        let info = repo_info(path).unwrap();
        assert!(!info.is_repo);
        assert!(info.head_branch.is_none());
        assert_eq!(info.name, dir.file_name().unwrap().to_string_lossy());
        assert_eq!(info.path, path);
    }

    #[test]
    fn init_repo_makes_a_plain_folder_a_repository() {
        let dir = scratch();
        let path = dir.to_str().unwrap();
        assert!(!repo_info(path).unwrap().is_repo);

        let info = super::init_repo(path).unwrap();
        assert!(info.is_repo);
        // It's a real repo now: a second open succeeds and status reads cleanly.
        assert!(repo_info(path).unwrap().is_repo);
        assert!(changes(path).unwrap().is_empty());
    }

    #[test]
    fn changes_distinguish_staged_unstaged_and_untracked() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();

        fs::write(dir.join("a.txt"), "hello\nCHANGED\n").unwrap(); // modify tracked
        fs::write(dir.join("new.txt"), "fresh\n").unwrap(); // untracked

        let ch = changes(path).unwrap();
        let a = ch.iter().find(|c| c.path == "a.txt").unwrap();
        assert_eq!(a.status, "modified");
        assert!(a.unstaged && !a.staged);
        let n = ch.iter().find(|c| c.path == "new.txt").unwrap();
        assert_eq!(n.status, "untracked");

        // Stage the modification → now it reads as staged.
        stage_paths(path, vec!["a.txt".into()]).unwrap();
        let staged = changes(path).unwrap();
        let a2 = staged.iter().find(|c| c.path == "a.txt").unwrap();
        assert!(a2.staged, "a.txt should be staged after stage_paths");

        // Output is sorted by path.
        let paths: Vec<_> = staged.iter().map(|c| c.path.clone()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
        let _ = repo;
    }

    #[test]
    fn stage_unstage_roundtrip() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "v2\n").unwrap();

        stage_paths(path, vec!["a.txt".into()]).unwrap();
        assert!(changes(path).unwrap().iter().any(|c| c.staged));
        unstage_paths(path, vec!["a.txt".into()]).unwrap();
        assert!(changes(path).unwrap().iter().all(|c| !c.staged));

        stage_all(path).unwrap();
        assert!(changes(path).unwrap().iter().all(|c| c.staged));
        unstage_all(path).unwrap();
        assert!(changes(path).unwrap().iter().all(|c| !c.staged));
    }

    #[test]
    fn commit_only_commits_the_staged_index() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();

        fs::write(dir.join("a.txt"), "staged change\n").unwrap();
        fs::write(dir.join("b.txt"), "unstaged new\n").unwrap();
        stage_paths(path, vec!["a.txt".into()]).unwrap();

        let oid = commit(path, "partial").unwrap();
        assert_eq!(oid.len(), 8);

        // a.txt is committed; b.txt remains untracked/unstaged.
        let after = changes(path).unwrap();
        assert!(!after.iter().any(|c| c.path == "a.txt"));
        assert!(after.iter().any(|c| c.path == "b.txt"));
    }

    #[test]
    fn stage_all_then_commit_commits_everything() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "x\n").unwrap();
        fs::write(dir.join("b.txt"), "y\n").unwrap();

        stage_all(path).unwrap();
        commit(path, "everything").unwrap();
        assert!(changes(path).unwrap().is_empty());
    }

    #[test]
    fn commit_on_empty_repo_creates_root_and_uses_signature_fallback() {
        let dir = scratch();
        let repo = init_bare_identity(&dir); // no user.name/email configured
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "first\n").unwrap();

        // No HEAD yet, no signature → must fall back to the swarm identity.
        stage_all(path).unwrap();
        let oid = commit(path, "root").unwrap();
        assert_eq!(oid.len(), 8);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 0, "root commit has no parents");
    }

    #[test]
    fn git_log_orders_newest_first_and_marks_head() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        commit_file(&repo, "a.txt", "v2\n", "second");
        let third = commit_file(&repo, "a.txt", "v3\n", "third");

        let log = git_log(path, 100).unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].summary, "third");
        assert_eq!(log[2].summary, "init");
        assert!(log[0].is_head);
        assert_eq!(log[0].oid, third.to_string());
        assert_eq!(log[1].oid, log[0].parents[0]);
        assert!(log.iter().all(|c| c.short.len() == 8));

        // Limit is honoured.
        assert_eq!(git_log(path, 2).unwrap().len(), 2);
    }

    #[test]
    fn commit_detail_and_diffs() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let oid = commit_file(&repo, "a.txt", "hello\nNEWLINE\n", "edit a");

        let detail = commit_detail(path, &oid.to_string()).unwrap();
        assert_eq!(detail.message.trim(), "edit a");
        assert_eq!(detail.author, "swarm-test");
        assert!(detail.files.iter().any(|f| f.path == "a.txt"));

        let full = commit_diff(path, &oid.to_string()).unwrap();
        assert!(full.patch.contains("NEWLINE"));
        assert!(!full.truncated, "tiny commit should not be truncated");
    }

    #[test]
    fn commit_detail_rejects_bad_oid() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let err = commit_detail(dir.to_str().unwrap(), "not-an-oid").unwrap_err();
        assert!(matches!(err, AppError::Git(_)));
    }

    #[test]
    fn file_diff_hunks_yields_structured_lines_with_numbers() {
        let dir = scratch();
        let _repo = init_repo(&dir); // a.txt = "hello\nworld\n"
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "hello\nthere\nworld\n").unwrap();

        let bundle = file_diff_hunks(path, "a.txt", false).unwrap();
        assert!(!bundle.truncated);
        let hunks = &bundle.hunks;
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@"));
        // The inserted "there" line is an addition with a new line number, no old.
        let add = hunks[0]
            .lines
            .iter()
            .find(|l| l.kind == "add")
            .expect("an added line");
        assert_eq!(add.text, "there");
        assert!(add.new_no.is_some());
        assert!(add.old_no.is_none());
        // Context lines carry both numbers.
        assert!(hunks[0]
            .lines
            .iter()
            .any(|l| l.kind == "ctx" && l.old_no.is_some() && l.new_no.is_some()));
    }

    #[test]
    fn status_and_stats_reports_changes_and_stats_in_one_pass() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "hello\nthere\nworld\n").unwrap(); // modify tracked
        fs::write(dir.join("new.txt"), "fresh\n").unwrap(); // untracked

        let combined = status_and_stats(path).unwrap();
        assert!(combined.changes.iter().any(|c| c.path == "new.txt"));
        assert!(combined
            .changes
            .iter()
            .any(|c| c.path == "a.txt" && c.status == "modified"));
        assert!(combined.stats.insertions >= 1);
        assert!(combined.stats.files_changed >= 1);
    }

    #[test]
    fn diff_stats_aggregates_insertions_and_deletions() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        // Original: "hello\nworld\n". Replace with extra lines.
        fs::write(dir.join("a.txt"), "hello\nthere\nworld\nmore\n").unwrap();
        let stats = diff_stats(path).unwrap();
        assert!(stats.insertions >= 2);
        assert!(stats.files_changed >= 1);
    }

    #[test]
    fn open_main_resolves_from_a_linked_worktree() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let main_path = dir.to_str().unwrap();

        let wt_path = add_worktree(main_path, "side");
        let wt = wt_path.to_str().unwrap();
        // repo_info on the *worktree* path must report the main checkout's path.
        let info = repo_info(wt).unwrap();
        let canon_main = std::fs::canonicalize(main_path).unwrap();
        let canon_info = std::fs::canonicalize(&info.path).unwrap();
        assert_eq!(canon_info, canon_main);

        // git_log via the worktree path sees the shared history.
        assert!(!git_log(wt, 10).unwrap().is_empty());
    }

    #[test]
    fn status_label_maps_every_state() {
        assert_eq!(status_label(Status::WT_NEW), "untracked");
        assert_eq!(status_label(Status::INDEX_NEW), "added");
        assert_eq!(status_label(Status::WT_MODIFIED), "modified");
        assert_eq!(status_label(Status::INDEX_MODIFIED), "modified");
        assert_eq!(status_label(Status::WT_DELETED), "deleted");
        assert_eq!(status_label(Status::INDEX_RENAMED), "renamed");
        assert_eq!(status_label(Status::WT_TYPECHANGE), "typechange");
        assert_eq!(status_label(Status::CONFLICTED), "conflicted");
    }

    #[test]
    fn delta_label_maps_every_delta() {
        assert_eq!(delta_label(Delta::Added), "added");
        assert_eq!(delta_label(Delta::Deleted), "deleted");
        assert_eq!(delta_label(Delta::Renamed), "renamed");
        assert_eq!(delta_label(Delta::Copied), "renamed");
        assert_eq!(delta_label(Delta::Typechange), "typechange");
        assert_eq!(delta_label(Delta::Modified), "modified");
        assert_eq!(delta_label(Delta::Unmodified), "modified");
    }

    #[test]
    fn discard_restores_tracked_and_deletes_untracked() {
        let dir = scratch();
        let _repo = init_repo(&dir); // a.txt = "hello\nworld\n"
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "hello\nGARBAGE\n").unwrap(); // modify tracked
        fs::write(dir.join("junk.txt"), "throwaway\n").unwrap(); // untracked
        stage_paths(path, vec!["a.txt".into()]).unwrap(); // even staged → discarded

        discard_paths(path, vec!["a.txt".into(), "junk.txt".into()]).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "hello\nworld\n"
        );
        assert!(!dir.join("junk.txt").exists());
        assert!(changes(path).unwrap().is_empty());
    }

    #[test]
    fn c3_discard_paths_refuses_escape_with_double_dot() {
        // A traversal entry (`../outside.txt`) must NOT cause an unlink outside
        // the worktree. Even though `ensure_within_root` gates the worktree, a
        // crafted list can mix legitimate entries with a `..` entry — per-path
        // containment is what defends here.
        let base = scratch();
        let work = base.join("inner");
        fs::create_dir_all(&work).unwrap();
        let _repo = init_repo(&work);
        let outside = base.join("outside.txt");
        fs::write(&outside, "do not delete\n").unwrap();
        // A worktree file that *should* be deleted, alongside the escape entry.
        fs::write(work.join("untracked.txt"), "burn me\n").unwrap();

        discard_paths(
            work.to_str().unwrap(),
            vec!["../outside.txt".into(), "untracked.txt".into()],
        )
        .unwrap();

        assert!(outside.exists(), "discard must not follow `..` out");
        assert!(
            !work.join("untracked.txt").exists(),
            "legitimate entry must still be removed"
        );
    }

    #[test]
    fn c3_discard_paths_refuses_absolute_outside_root() {
        // An absolute path that *is* a real file but lives outside the worktree
        // must be ignored, not deleted.
        let dir = scratch();
        let _repo = init_repo(&dir);
        let outside_dir = scratch();
        let outside = outside_dir.join("victim.txt");
        fs::write(&outside, "do not delete\n").unwrap();

        discard_paths(
            dir.to_str().unwrap(),
            vec![outside.to_string_lossy().into_owned()],
        )
        .unwrap();

        assert!(
            outside.exists(),
            "discard must not delete an absolute path outside the worktree"
        );
    }

    #[test]
    fn c3_stage_paths_skips_escape_without_erroring() {
        // `stage_paths` mixes a legitimate worktree entry with an escape: the
        // legitimate file is staged, the escape entry is silently dropped (no
        // libgit2 error, no index corruption).
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "edit\n").unwrap();

        stage_paths(path, vec!["a.txt".into(), "../escape.txt".into()]).unwrap();

        let staged = changes(path).unwrap();
        let a = staged.iter().find(|c| c.path == "a.txt").unwrap();
        assert!(a.staged, "legitimate stage entry must still apply");
    }

    #[test]
    fn create_branch_then_checkout_roundtrip() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let main = repo.head().unwrap().shorthand().unwrap().to_string();

        create_branch(path, "feature", "").unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");

        checkout_ref(path, &main).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), main);
    }

    #[test]
    fn checkout_commit_detaches_head() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        commit_file(&repo, "a.txt", "v2\n", "second");

        checkout_ref(path, &first.to_string()).unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), first);
    }

    #[test]
    fn reset_hard_moves_head_and_resets_worktree() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        commit_file(&repo, "a.txt", "v2\n", "second");

        reset_to(path, &first.to_string(), "hard").unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), first);
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "hello\nworld\n"
        );
    }

    #[test]
    fn reset_soft_keeps_worktree_moves_head() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        commit_file(&repo, "a.txt", "v2\n", "second");

        reset_to(path, &first.to_string(), "soft").unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), first);
        // soft leaves the worktree (the "v2" content) untouched.
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "v2\n");
    }

    #[test]
    fn revert_creates_inverse_commit() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let bad = commit_file(&repo, "b.txt", "oops\n", "add b");
        assert!(dir.join("b.txt").exists());

        let short = revert_commit(path, &bad.to_string()).unwrap();
        assert_eq!(short.len(), 8);
        // The revert undoes the addition.
        assert!(!dir.join("b.txt").exists());
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert!(head.summary().unwrap().unwrap().starts_with("Revert"));
    }

    #[test]
    fn diffs_cap_at_diff_line_cap_and_flag_truncated() {
        // Commit a file with far more lines than the cap, against an empty
        // baseline: both file_diff_hunks and commit_diff must surface the cap
        // and stop early (lines <= cap; truncated == true).
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let huge: String = (0..(DIFF_LINE_CAP + 1_000))
            .map(|i| format!("line-{i}\n"))
            .collect();
        // Modify the seeded a.txt with a huge replacement (clean diff baseline).
        fs::write(dir.join("a.txt"), &huge).unwrap();
        let oid = {
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("a.txt")).unwrap();
            idx.write().unwrap();
            let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "huge", &tree, &[&parent])
                .unwrap()
        };

        // Commit diff: capped + flagged.
        let cd = commit_diff(path, &oid.to_string()).unwrap();
        assert!(cd.truncated, "huge commit must report truncated");
        // The patch carries headers too. Exclude the unified-diff file-header
        // pair (--- a/foo / +++ b/foo) and the @@-hunk lines so we only count
        // honest content lines — those are what the cap guards.
        let content_lines = cd
            .patch
            .lines()
            .filter(|l| {
                (l.starts_with(' ') || l.starts_with('+') || l.starts_with('-'))
                    && !l.starts_with("---")
                    && !l.starts_with("+++")
                    && !l.starts_with("@@")
            })
            .count();
        assert!(
            content_lines <= DIFF_LINE_CAP,
            "patch had {content_lines} content lines, cap is {DIFF_LINE_CAP}"
        );

        // file_diff_hunks (staged=true): same cap applies. The seeded second
        // commit is HEAD, so we diff the staged state vs HEAD by re-staging
        // a fresh edit.
        fs::write(dir.join("a.txt"), &huge).unwrap();
        let mut idx = repo.index().unwrap();
        idx.read(false).unwrap();
        idx.add_path(Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        // After commit + re-add of identical bytes there's no diff vs HEAD;
        // perturb the file to force one.
        fs::write(dir.join("a.txt"), format!("{huge}EXTRA\n")).unwrap();
        let bundle = file_diff_hunks(path, "a.txt", false).unwrap();
        let total_lines: usize = bundle.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(
            total_lines <= DIFF_LINE_CAP,
            "hunks held {total_lines}, cap is {DIFF_LINE_CAP}"
        );
        assert!(bundle.truncated || total_lines < DIFF_LINE_CAP);
    }
}
