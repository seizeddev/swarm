# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-project workspaces** — open several repos at once and switch between them from the rail; each keeps its own terminals, source control, and PRs.
- **Multi-terminal splits** — split a terminal right or down into a tiled layout with draggable dividers; sessions stay alive across tab and workspace switches.
- **Notifications** — agents that emit OSC 9 / OSC 99 (kitty) / OSC 777 sequences (or ring the bell) light up their tab and workspace, with a notifications panel and focus-aware suppression + dedup.
- **Session restore** — workspaces, tab/split layout, and working directories are persisted and rebuilt on launch; agents relaunch with their resume command (`claude --continue`, `codex resume --last`).
- **Source Control panel** (VS Code-style) — staged/unstaged groups, stage/unstage, commit, and per-file diff viewer (libgit2).
- **Pull Requests panel** — open PRs via the GitHub CLI with check status, grouped by author.
- Real terminal emulation via the Alacritty engine in Rust (no xterm.js); the cell grid is streamed to the webview.

### Notes

- Pre-1.0: interfaces and persisted snapshot format may change.
