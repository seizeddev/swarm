# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-24

A performance, security, and design release. No data migration required; the
persisted session format is unchanged.

### Added

- **Responsive layout** — the app now reflows across narrow and wide windows, with a resizable inspector panel.
- **Empty state for terminals** — closing the last terminal in a workspace now shows a prompt with a one-click *Open a terminal* button instead of a blank pane.

### Changed

- **Deep design overhaul** — a unified material system and chrome, reworked information architecture, and refined diff/PR presentation. The UI stays strictly monochrome.
- Bumped frontend tooling to current releases (Vite 8, Vitest 4, `@vitejs/plugin-react` 6).

### Performance

- Terminal grid streams as damage deltas with burst coalescing and visibility gating; grid frames are sent as binary over IPC instead of JSON.
- Git and GitHub commands run off the main thread with deduplicated status; filesystem watching uses `notify` events instead of interval polling.
- Diff and history views are virtualized, with diff hunks parsed in Rust.
- Render path uses selector subscriptions, lazy panes with PTY reattach, and the React Compiler; terminal lines/panes use CSS containment and `content-visibility`.
- The hot terminal dependencies are built at `-O3`.

### Security

- **Path-allowlist guard** — every path-taking command validates against roots the frontend registers, reducing blast radius behind the CSP.
- Frontend hardening: opener allowlist, paste guard, and bounded decoding.
- Bounded PTY, hardened GitHub CLI usage, and fuzzing of the notification/OSC parser.
- CI supply-chain hardening: all GitHub Actions pinned to commit SHAs, least-privilege tokens, and dependency gates. Release signing sits behind a protected environment.

### Fixed

- **Terminal fills the full pane height for full-screen TUIs.** Agents are now launched through the user's interactive login shell (as a real terminal emulator does), so they inherit the complete environment — `PATH`, locale, and personal settings such as Claude Code's `CLAUDE_CODE_NO_FLICKER`. A GUI launch (e.g. from the packaged `.dmg`) previously gave agents only a minimal environment, so Claude Code fell back to a reduced inline render and the terminal looked cut off at the bottom; it now renders full-height regardless of how the app was launched.
- The PTY is sized from the pane's real geometry: a degenerate (0×0 / 1-row) measurement during a slow first paint is no longer sent, and the grid re-fits at several settle points after spawn so it reliably fills the pane.
- Terminal grid keeps painting after cleanup — the requestAnimationFrame handle is reset correctly.

### Removed

- Dead code, unused commands, and the unwired worktree subsystem.

## [0.1.0] - 2026-05-23

First public release.

### Added

- **Automatic updates** — signed self-updates via `tauri-plugin-updater`. The app polls the GitHub release at launch, on window focus, and every 15 min; a monochrome **Update available** banner at the bottom of the sidebar downloads, verifies, and installs on click, then offers a one-click restart.
- **Multi-project workspaces** — open several repos at once and switch between them from the rail; each keeps its own terminals, source control, and PRs.
- **Multi-terminal splits** — split a terminal right or down into a tiled layout with draggable dividers; sessions stay alive across tab and workspace switches.
- **Notifications** — agents that emit OSC 9 / OSC 99 (kitty) / OSC 777 sequences (or ring the bell) light up their tab and workspace, with a notifications panel and focus-aware suppression + dedup.
- **Session restore** — workspaces, tab/split layout, and working directories are persisted and rebuilt on launch; agents relaunch with their resume command (`claude --continue`, `codex resume --last`).
- **Source Control panel** (VS Code-style) — staged/unstaged groups, stage/unstage, commit, and per-file diff viewer (libgit2).
- **Pull Requests panel** — open PRs via the GitHub CLI with check status, grouped by author.
- Real terminal emulation via the Alacritty engine in Rust (no xterm.js); the cell grid is streamed to the webview.

### Notes

- Pre-1.0: interfaces and persisted snapshot format may change.
- Licensed under **GPL-3.0-or-later**.

[Unreleased]: https://github.com/seizeddev/swarm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/seizeddev/swarm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/seizeddev/swarm/releases/tag/v0.1.0
