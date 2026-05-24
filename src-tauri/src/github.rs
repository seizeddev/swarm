// SPDX-License-Identifier: GPL-3.0-or-later
use crate::error::AppResult;
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Hard cap on any `gh` invocation. A hung subprocess (network stall, auth
/// prompt slipping through) must never wedge the off-thread pool indefinitely.
const GH_TIMEOUT: Duration = Duration::from_secs(15);

/// Run `gh` non-interactively and return its stdout on success, or `None` on any
/// failure (spawn error, non-zero exit, or timeout) so every caller degrades
/// gracefully to an empty result — exactly the prior behaviour, now bounded.
///
/// Hardening: stdin is `/dev/null` and the prompt/update/colour env is forced
/// off, so `gh` can never block waiting for a human; a watchdog kills it past
/// `GH_TIMEOUT`. stdout is drained on a side thread so a large `--json` payload
/// can't deadlock against the pipe buffer while we wait.
fn run_gh(args: &[&str], cwd: Option<&str>) -> Option<Vec<u8>> {
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= GH_TIMEOUT {
                    let _ = child.kill();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };
    let _ = child.wait(); // reap; the reader thread ends as the pipe closes

    match status {
        Some(status) if status.success() => rx.recv_timeout(Duration::from_secs(1)).ok(),
        _ => None,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub is_draft: bool,
    pub checks: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub head_ref: String,
    pub review_decision: Option<String>,
    pub checks: Option<String>,
}

fn rollup_status(v: &serde_json::Value) -> Option<String> {
    let arr = v.get("statusCheckRollup")?.as_array()?;
    let mut failing = 0;
    let mut pending = 0;
    for c in arr {
        match c.get("conclusion").and_then(|x| x.as_str()).unwrap_or("") {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            "" => pending += 1,
            _ => failing += 1,
        }
    }
    Some(if failing > 0 {
        "failing".into()
    } else if pending > 0 {
        "pending".into()
    } else {
        "passing".into()
    })
}

pub fn pr_list(repo_path: &str) -> AppResult<Vec<PrSummary>> {
    let stdout = match run_gh(
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,url,state,isDraft,author,headRefName,reviewDecision,statusCheckRollup",
        ],
        Some(repo_path),
    ) {
        Some(o) => o,
        None => return Ok(vec![]),
    };
    let arr: serde_json::Value = serde_json::from_slice(&stdout).unwrap_or_default();
    let items = match arr.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    Ok(items
        .iter()
        .map(|v| PrSummary {
            number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
            title: v
                .get("title")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            url: v
                .get("url")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            state: v
                .get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            is_draft: v.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
            author: v
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            head_ref: v
                .get("headRefName")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            review_decision: v
                .get("reviewDecision")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            checks: rollup_status(v),
        })
        .collect())
}

pub fn gh_login() -> Option<String> {
    let stdout = run_gh(&["api", "user", "-q", ".login"], None)?;
    let s = String::from_utf8_lossy(&stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn gh_available() -> bool {
    run_gh(&["--version"], None).is_some()
}

pub fn pr_for_branch(repo_path: &str, branch: &str) -> AppResult<Option<PrInfo>> {
    // A ref starting with `-` would be parsed as a flag; reject it outright, and
    // additionally pass the branch after a `--` separator so `gh` always treats
    // it as the positional PR selector (argument-injection defence, M-1).
    if branch.starts_with('-') {
        return Ok(None);
    }
    let stdout = match run_gh(
        &[
            "pr",
            "view",
            "--json",
            "number,title,state,url,isDraft,statusCheckRollup",
            "--",
            branch,
        ],
        Some(repo_path),
    ) {
        Some(o) => o,
        None => return Ok(None),
    };

    let v: serde_json::Value = match serde_json::from_slice(&stdout) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let checks = v
        .get("statusCheckRollup")
        .and_then(|r| r.as_array())
        .map(|arr| {
            let mut failing = 0;
            let mut pending = 0;
            for c in arr {
                match c.get("conclusion").and_then(|x| x.as_str()).unwrap_or("") {
                    "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
                    "" => pending += 1,
                    _ => failing += 1,
                }
            }
            if failing > 0 {
                "failing".to_string()
            } else if pending > 0 {
                "pending".to_string()
            } else {
                "passing".to_string()
            }
        });

    Ok(Some(PrInfo {
        number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
        title: v
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        state: v
            .get("state")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        url: v
            .get("url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        is_draft: v.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
        checks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rollup_passing_when_all_checks_succeed() {
        let v = json!({
            "statusCheckRollup": [
                { "conclusion": "SUCCESS" },
                { "conclusion": "NEUTRAL" },
                { "conclusion": "SKIPPED" },
            ]
        });
        assert_eq!(rollup_status(&v).as_deref(), Some("passing"));
    }

    #[test]
    fn rollup_failing_dominates_pending() {
        let v = json!({
            "statusCheckRollup": [
                { "conclusion": "SUCCESS" },
                { "conclusion": "" },          // pending
                { "conclusion": "FAILURE" },   // failing
            ]
        });
        assert_eq!(rollup_status(&v).as_deref(), Some("failing"));
    }

    #[test]
    fn rollup_pending_when_any_check_is_unfinished() {
        let v = json!({
            "statusCheckRollup": [
                { "conclusion": "SUCCESS" },
                { "conclusion": "" },
            ]
        });
        assert_eq!(rollup_status(&v).as_deref(), Some("pending"));
    }

    #[test]
    fn rollup_missing_conclusion_field_is_pending() {
        // A check object with no `conclusion` key counts as pending.
        let v = json!({ "statusCheckRollup": [ { "name": "build" } ] });
        assert_eq!(rollup_status(&v).as_deref(), Some("pending"));
    }

    #[test]
    fn rollup_empty_array_is_passing() {
        let v = json!({ "statusCheckRollup": [] });
        assert_eq!(rollup_status(&v).as_deref(), Some("passing"));
    }

    #[test]
    fn rollup_absent_field_yields_none() {
        assert_eq!(rollup_status(&json!({})), None);
        assert_eq!(rollup_status(&json!({ "statusCheckRollup": null })), None);
    }

    #[test]
    fn pr_list_returns_empty_when_gh_unavailable() {
        // A non-repo path with gh likely uninstalled in CI: must degrade to [].
        let out = pr_list("/nonexistent-path-xyz").unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn pr_for_branch_returns_none_when_gh_unavailable() {
        let out = pr_for_branch("/nonexistent-path-xyz", "main").unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn pr_for_branch_rejects_dash_prefixed_ref() {
        // A ref that looks like a flag must short-circuit to None and never be
        // handed to `gh` (argument-injection guard, M-1).
        assert!(pr_for_branch("/nonexistent-path-xyz", "--repo")
            .unwrap()
            .is_none());
        assert!(pr_for_branch(".", "-x").unwrap().is_none());
    }
}
