// SPDX-License-Identifier: GPL-3.0-or-later
//! Git operations via libgit2 (no shelling out to the `git` binary).
//!
//! This module is swarm's wedge against cmux: first-class *worktree* listing and
//! creation, per-worktree status, and unified diffs ready for review.

use crate::error::{AppError, AppResult};
use git2::{
    Branch, BranchType, Delta, Diff, DiffFormat, DiffOptions, Repository, Status, StatusOptions,
    WorktreeAddOptions, WorktreePruneOptions,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head_branch: Option<String>,
    pub head_short: Option<String>,
    pub is_detached: bool,
    pub remote_url: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_main: bool,
    pub is_locked: bool,
    pub locked_reason: Option<String>,
    pub is_prunable: bool,
    pub ahead: usize,
    pub behind: usize,
    pub dirty_count: usize,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
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

fn is_dirty(repo: &Repository) -> bool {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    repo.statuses(Some(&mut opts))
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

fn ahead_behind(repo: &Repository) -> (usize, usize) {
    let local = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let upstream = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_owned))
        .and_then(|name| repo.find_branch(&name, BranchType::Local).ok())
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().target());
    match upstream {
        Some(up) => repo.graph_ahead_behind(local, up).unwrap_or((0, 0)),
        None => (0, 0),
    }
}

pub fn repo_info(path: &str) -> AppResult<RepoInfo> {
    let repo = open_main(path)?;
    let wd = workdir(&repo)?;
    let head = repo.head().ok();
    let is_detached = repo.head_detached().unwrap_or(false);
    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(str::to_owned));
    Ok(RepoInfo {
        path: wd.to_string_lossy().into_owned(),
        name: repo_basename(&repo),
        head_branch: head
            .as_ref()
            .and_then(|h| h.shorthand().ok().map(str::to_owned)),
        head_short: head
            .as_ref()
            .and_then(|h| h.target())
            .map(|o| short_oid(&o)),
        is_detached,
        remote_url,
        dirty: is_dirty(&repo),
    })
}

fn short_oid(oid: &git2::Oid) -> String {
    oid.to_string().chars().take(8).collect()
}

/// List the main checkout plus every linked worktree, each with live metadata.
pub fn list_worktrees(path: &str) -> AppResult<Vec<WorktreeInfo>> {
    let repo = open_main(path)?;
    let mut out = Vec::new();

    // Main checkout first.
    let main_wd = workdir(&repo)?;
    out.push(worktree_info_for_path(
        &main_wd,
        &repo_basename(&repo),
        true,
        None,
        false,
    )?);

    // Linked worktrees.
    let names = repo.worktrees()?;
    for name in names.iter().flatten().flatten() {
        let wt = match repo.find_worktree(name) {
            Ok(w) => w,
            Err(_) => continue,
        };
        let wt_path = wt.path().to_path_buf();
        let lock = wt.is_locked().ok();
        let (locked, reason) = match lock {
            Some(git2::WorktreeLockStatus::Locked(r)) => (true, r),
            _ => (false, None),
        };
        let prunable = wt.is_prunable(None).unwrap_or(false);
        out.push(worktree_info_for_path(
            &wt_path,
            name,
            false,
            Some((locked, reason)),
            prunable,
        )?);
    }
    Ok(out)
}

fn worktree_info_for_path(
    wt_path: &Path,
    name: &str,
    is_main: bool,
    lock: Option<(bool, Option<String>)>,
    is_prunable: bool,
) -> AppResult<WorktreeInfo> {
    // Opening the worktree's own repo gives us its HEAD, status, ahead/behind.
    let (branch, head_oid, dirty_count, ahead, behind) = match Repository::open(wt_path) {
        Ok(r) => {
            let head = r.head().ok();
            let branch = head
                .as_ref()
                .and_then(|h| h.shorthand().ok().map(str::to_owned));
            let head_oid = head
                .as_ref()
                .and_then(|h| h.target())
                .map(|o| short_oid(&o));
            let mut so = StatusOptions::new();
            so.include_untracked(true).recurse_untracked_dirs(true);
            let dirty_count = r.statuses(Some(&mut so)).map(|s| s.len()).unwrap_or(0);
            let (a, b) = ahead_behind(&r);
            (branch, head_oid, dirty_count, a, b)
        }
        Err(_) => (None, None, 0, 0, 0),
    };
    let (is_locked, locked_reason) = lock.unwrap_or((false, None));
    Ok(WorktreeInfo {
        name: name.to_string(),
        path: wt_path.to_string_lossy().into_owned(),
        branch,
        head_oid,
        is_main,
        is_locked,
        locked_reason,
        is_prunable,
        ahead,
        behind,
        dirty_count,
    })
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Where swarm keeps its worktrees: `~/.swarm/worktrees/<repo>/<branch>`.
/// Deliberately *outside* the repo so the user's tree stays clean.
fn worktrees_root(repo: &Repository) -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home directory".into()))?;
    Ok(home
        .join(".swarm")
        .join("worktrees")
        .join(repo_basename(repo)))
}

/// Create a new branch (from `base_ref` or HEAD) and add a worktree for it.
pub fn create_worktree(
    repo_path: &str,
    branch_name: &str,
    base_ref: Option<&str>,
) -> AppResult<WorktreeInfo> {
    let repo = open_main(repo_path)?;
    if branch_name.trim().is_empty() {
        return Err(AppError::Invalid("branch name is empty".into()));
    }

    let base_commit = match base_ref {
        Some(r) if !r.is_empty() => repo.revparse_single(r)?.peel_to_commit()?,
        _ => repo.head()?.peel_to_commit()?,
    };

    let safe = sanitize(branch_name);
    let root = worktrees_root(&repo)?;
    std::fs::create_dir_all(&root)?;
    let wt_path = root.join(&safe);
    if wt_path.exists() {
        return Err(AppError::Invalid(format!(
            "worktree path already exists: {}",
            wt_path.display()
        )));
    }

    // Reuse an existing branch or create a fresh one.
    let branch: Branch = match repo.find_branch(branch_name, BranchType::Local) {
        Ok(b) => b,
        Err(_) => repo.branch(branch_name, &base_commit, false)?,
    };
    let reference = branch.into_reference();

    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&reference));
    repo.worktree(&safe, &wt_path, Some(&opts))?;

    worktree_info_for_path(&wt_path, &safe, false, Some((false, None)), false)
}

/// Remove a linked worktree (and its files). `force` also removes locked ones.
pub fn remove_worktree(repo_path: &str, name: &str, force: bool) -> AppResult<()> {
    let repo = open_main(repo_path)?;
    let wt = repo
        .find_worktree(name)
        .map_err(|_| AppError::NotFound(format!("worktree '{name}' not found")))?;
    let path = wt.path().to_path_buf();

    let mut popts = WorktreePruneOptions::new();
    popts.valid(true).working_tree(true);
    if force {
        popts.locked(true);
    }
    wt.prune(Some(&mut popts))?;

    // `prune` removes the admin files; remove leftover working tree dir if present.
    if path.exists() {
        let _ = std::fs::remove_dir_all(&path);
    }
    Ok(())
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

/// Per-file change list for a worktree (staged + unstaged + untracked).
pub fn changes(worktree_path: &str) -> AppResult<Vec<FileChange>> {
    let repo = Repository::open(worktree_path)?;
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

/// Unified-diff patch text for one file (parsed into hunks by the frontend).
pub fn file_diff(worktree_path: &str, file: &str, staged: bool) -> AppResult<String> {
    let repo = Repository::open(worktree_path)?;
    let diff = build_diff(&repo, Some(file), staged)?;
    let mut buf = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin);
        }
        buf.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;
    Ok(buf)
}

/// Aggregate insertions/deletions across the whole worktree (unstaged + staged).
pub fn diff_stats(worktree_path: &str) -> AppResult<DiffStatsInfo> {
    let repo = Repository::open(worktree_path)?;
    let mut files = 0usize;
    let mut ins = 0usize;
    let mut del = 0usize;
    for staged in [false, true] {
        if let Ok(diff) = build_diff(&repo, None, staged) {
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

pub fn list_branches(repo_path: &str) -> AppResult<Vec<BranchInfo>> {
    let repo = open_main(repo_path)?;
    let mut out = Vec::new();
    for b in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = b?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(str::to_owned));
        out.push(BranchInfo {
            is_head: branch.is_head(),
            name,
            upstream,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
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
    pub email: String,
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
    let email = sig.email().unwrap_or("").to_string();
    let message = c.message().unwrap_or("").to_string();
    let time = c.time().seconds();
    let parents: Vec<String> = c.parent_ids().map(|p| p.to_string()).collect();
    Ok(CommitDetail {
        oid: oid.to_string(),
        short: short_oid(&oid),
        message,
        author,
        email,
        time,
        parents,
        files,
    })
}

/// Unified patch for one file within a commit (vs its first parent).
pub fn commit_file_diff(repo_path: &str, oid_str: &str, file: &str) -> AppResult<String> {
    let repo = open_main(repo_path)?;
    let oid = git2::Oid::from_str(oid_str)?;
    let c = repo.find_commit(oid)?;
    let tree = c.tree()?;
    let parent = c.parent(0).ok();
    let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let mut buf = String::new();
    diff.print(DiffFormat::Patch, |_d, _h, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin);
        }
        buf.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;
    Ok(buf)
}

/// Full unified patch for a commit (all files, vs first parent).
pub fn commit_diff(repo_path: &str, oid_str: &str) -> AppResult<String> {
    let repo = open_main(repo_path)?;
    let oid = git2::Oid::from_str(oid_str)?;
    let c = repo.find_commit(oid)?;
    let tree = c.tree()?;
    let parent = c.parent(0).ok();
    let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    let mut buf = String::new();
    diff.print(DiffFormat::Patch, |_d, _h, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin);
        }
        buf.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;
    Ok(buf)
}

/// Stage everything and commit — "accept" an agent's work in its worktree.
pub fn commit_all(worktree_path: &str, message: &str) -> AppResult<String> {
    let repo = Repository::open(worktree_path)?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("swarm", "swarm@localhost"))?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(short_oid(&oid))
}

pub fn stage_paths(worktree_path: &str, paths: Vec<String>) -> AppResult<()> {
    let repo = Repository::open(worktree_path)?;
    let mut index = repo.index()?;
    let root = Path::new(worktree_path);
    for p in &paths {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    /// `worktrees_root`/`swarm_dir` resolve against `$HOME`, and tests mutate it
    /// process-wide. Serialize every test that touches HOME so the parallel test
    /// runner can't interleave two `set_var("HOME", …)` calls.
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn scratch() -> PathBuf {
        let p = std::env::temp_dir().join(format!("swarm-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
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
        }
        commit_file(&repo, "a.txt", "hello\nworld\n", "init");
        repo
    }

    /// Init a repo *without* configured identity to exercise the signature fallback.
    fn init_bare_identity(dir: &Path) -> Repository {
        Repository::init(dir).unwrap()
    }

    #[test]
    fn worktree_lifecycle_and_diff() {
        let _guard = HOME_LOCK.lock().unwrap();
        // Redirect ~/.swarm into a scratch dir for isolation.
        let home = scratch();
        std::env::set_var("HOME", &home);

        let repo_dir = scratch();
        let _repo = init_repo(&repo_dir);
        let repo_path = repo_dir.to_str().unwrap();

        // Initially: just the main worktree.
        let before = list_worktrees(repo_path).unwrap();
        assert_eq!(before.len(), 1);
        assert!(before[0].is_main);

        // Create a worktree on a new branch.
        let wt = create_worktree(repo_path, "feat/x", None).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feat/x"));

        let after = list_worktrees(repo_path).unwrap();
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|w| w.branch.as_deref() == Some("feat/x")));

        // Make a change in the worktree → it should show up.
        fs::write(Path::new(&wt.path).join("b.txt"), "new file\n").unwrap();
        fs::write(Path::new(&wt.path).join("a.txt"), "hello\nCHANGED\n").unwrap();
        let ch = changes(&wt.path).unwrap();
        assert!(ch
            .iter()
            .any(|c| c.path == "b.txt" && c.status == "untracked"));
        assert!(ch
            .iter()
            .any(|c| c.path == "a.txt" && c.status == "modified"));

        let patch = file_diff(&wt.path, "a.txt", false).unwrap();
        assert!(patch.contains("CHANGED"));

        let stats = diff_stats(&wt.path).unwrap();
        assert!(stats.insertions >= 1);

        // Accept the work.
        let oid = commit_all(&wt.path, "do the thing").unwrap();
        assert_eq!(oid.len(), 8);
        assert!(changes(&wt.path).unwrap().is_empty());

        // Remove it.
        remove_worktree(repo_path, "feat-x", false).unwrap();
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 1);
    }

    #[test]
    fn repo_info_reports_branch_dirty_and_name() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();

        let info = repo_info(path).unwrap();
        assert_eq!(info.name, dir.file_name().unwrap().to_string_lossy());
        assert!(info.head_branch.is_some());
        assert!(!info.is_detached);
        assert!(!info.dirty, "fresh checkout should be clean");
        assert_eq!(info.head_short.as_ref().map(|s| s.len()), Some(8));

        fs::write(dir.join("a.txt"), "dirty now\n").unwrap();
        assert!(repo_info(path).unwrap().dirty, "edit makes it dirty");
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
    fn commit_all_stages_then_commits_everything() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "x\n").unwrap();
        fs::write(dir.join("b.txt"), "y\n").unwrap();

        commit_all(path, "everything").unwrap();
        assert!(changes(path).unwrap().is_empty());
    }

    #[test]
    fn commit_on_empty_repo_creates_root_and_uses_signature_fallback() {
        let dir = scratch();
        let repo = init_bare_identity(&dir); // no user.name/email configured
        let path = dir.to_str().unwrap();
        fs::write(dir.join("a.txt"), "first\n").unwrap();

        // No HEAD yet, no signature → must fall back to the swarm identity.
        let oid = commit_all(path, "root").unwrap();
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
        assert_eq!(detail.email, "test@swarm.local");
        assert!(detail.files.iter().any(|f| f.path == "a.txt"));

        let fd = commit_file_diff(path, &oid.to_string(), "a.txt").unwrap();
        assert!(fd.contains("NEWLINE"));
        let full = commit_diff(path, &oid.to_string()).unwrap();
        assert!(full.contains("NEWLINE"));
    }

    #[test]
    fn commit_detail_rejects_bad_oid() {
        let dir = scratch();
        let _repo = init_repo(&dir);
        let err = commit_detail(dir.to_str().unwrap(), "not-an-oid").unwrap_err();
        assert!(matches!(err, AppError::Git(_)));
    }

    #[test]
    fn list_branches_marks_head_and_sorts() {
        let dir = scratch();
        let repo = init_repo(&dir);
        let path = dir.to_str().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("aaa-feature", &head, false).unwrap();
        repo.branch("zzz-feature", &head, false).unwrap();

        let branches = list_branches(path).unwrap();
        let names: Vec<_> = branches.iter().map(|b| b.name.clone()).collect();
        assert!(names.contains(&"aaa-feature".to_string()));
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "branches are sorted by name");
        assert_eq!(branches.iter().filter(|b| b.is_head).count(), 1);
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
    fn remove_worktree_errors_when_missing() {
        let _guard = HOME_LOCK.lock().unwrap();
        std::env::set_var("HOME", scratch());
        let dir = scratch();
        let _repo = init_repo(&dir);
        let err = remove_worktree(dir.to_str().unwrap(), "ghost", false).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn create_worktree_rejects_empty_branch() {
        let _guard = HOME_LOCK.lock().unwrap();
        std::env::set_var("HOME", scratch());
        let dir = scratch();
        let _repo = init_repo(&dir);
        let err = create_worktree(dir.to_str().unwrap(), "  ", None).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn open_main_resolves_from_a_linked_worktree() {
        let _guard = HOME_LOCK.lock().unwrap();
        std::env::set_var("HOME", scratch());
        let dir = scratch();
        let _repo = init_repo(&dir);
        let main_path = dir.to_str().unwrap();

        let wt = create_worktree(main_path, "side", Some("HEAD")).unwrap();
        // repo_info on the *worktree* path must report the main checkout's path.
        let info = repo_info(&wt.path).unwrap();
        let canon_main = std::fs::canonicalize(main_path).unwrap();
        let canon_info = std::fs::canonicalize(&info.path).unwrap();
        assert_eq!(canon_info, canon_main);

        // git_log via the worktree path sees the shared history.
        assert!(!git_log(&wt.path, 10).unwrap().is_empty());
    }

    #[test]
    fn sanitize_replaces_unsafe_characters() {
        assert_eq!(sanitize("feat/x"), "feat-x");
        assert_eq!(sanitize("a b@c#d"), "a-b-c-d");
        assert_eq!(sanitize("keep.dots_and-dashes"), "keep.dots_and-dashes");
        // Non-ascii scalars become dashes; embedded ascii (n, c, d) survives.
        assert_eq!(sanitize("Ünïcödé"), "-n-c-d-");
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
}
