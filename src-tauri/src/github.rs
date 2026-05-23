use crate::error::AppResult;
use serde::Serialize;
use std::process::Command;

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
    let output = Command::new("gh")
        .args([
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,url,state,isDraft,author,headRefName,reviewDecision,statusCheckRollup",
        ])
        .current_dir(repo_path)
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(vec![]),
    };
    let arr: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
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
    let output = Command::new("gh")
        .args(["api", "user", "-q", ".login"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn gh_available() -> bool {
    Command::new("gh")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn pr_for_branch(repo_path: &str, branch: &str) -> AppResult<Option<PrInfo>> {
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            branch,
            "--json",
            "number,title,state,url,isDraft,statusCheckRollup",
        ])
        .current_dir(repo_path)
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Ok(None),
    };

    let v: serde_json::Value = match serde_json::from_slice(&output.stdout) {
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
