# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-25

A notifications release. No data migration required; the persisted session
format is unchanged.

### Added

- **Background OS notifications.** When the swarm window is in the background (or a pane is hidden), an agent finishing a turn now raises a native desktop banner with a "Pop"-style sound. Clicking the banner focuses the window and opens the originating pane. Notifications are platform-native on macOS, Linux, and Windows.
- **Real last-message bodies.** A notification now carries the agent's actual final reply rather than a generic "done". Claude reads the documented Stop-hook `last_assistant_message` field; Codex and the other supported agents (Gemini, Cursor, OpenCode, Amp, Aider) surface their real last assistant message via a pure-Rust `swarm --notify-helper` (no bash/jq dependency).
- **In-app notification history.** Notifications are kept in an in-app list with an unread badge on the Bell. Focusing a source pane marks its notifications read while keeping them in history; clicking an entry navigates to its pane.

### Changed

- **Self-update control moved to a hover-popover icon** at the foot of the main rail (previously in the panel), with a dev-only state cycler for previewing every update state.
- **Unfocused split panes are now dimmed** with a background-tinted overlay so the active leaf stands out in a tiled layout.

### Fixed

- **Exactly one clean Claude notification per turn.** Claude Code emits its own intermediate terminal notifications alongside swarm's Stop hook, which could double-notify or show a non-final message; the Stop hook now tags its notification with a sentinel so a Claude pane keeps only that one, carrying the true last assistant message.
- **Regaining window focus** now clears the visible pane's attention state and marks its notifications read, without needing an extra click into the terminal.
- **Linux build.** The freedesktop notification click handler called `notify-rust`'s `wait_for_action` against the wrong (async/`ActionResponse`) signature, breaking the Linux build; it now uses the synchronous `FnOnce(&str)` API. macOS and Windows were unaffected.

### Internal

- macOS notifications migrated from the deprecated `NSUserNotification` to the current `UNUserNotificationCenter` (objc2), with a delegate handling banner-click activation. OS notifications are now Rust-owned (dropped `tauri-plugin-notification`, whose desktop backend offers no click callback).

## [0.2.2] - 2026-05-24

### Fixed

- **Split panes now render live even when unfocused.** A tiled split shows every terminal at once, but only the active leaf was being marked visible — so a sibling pane told the core to stop sending updates and froze, making an agent working in an unfocused split pane look idle until you clicked it. Visibility (on-screen → paints live) is now separate from keyboard focus (active leaf → owns input), so every visible pane streams its agent's output in real time.

## [0.2.1] - 2026-05-24

### Added

- **Empty state for terminals** — closing the last terminal in a workspace now shows a prompt with a one-click *Open a terminal* button instead of a blank pane.

### Fixed

- **Terminal fills the full pane height for full-screen TUIs.** Agents are now launched through the user's interactive login shell (as a real terminal emulator does), so they inherit the complete environment — `PATH`, locale, and personal settings such as Claude Code's `CLAUDE_CODE_NO_FLICKER`. A GUI launch (e.g. from the packaged `.dmg`) previously gave agents only a minimal environment, so Claude Code fell back to a reduced inline render and the terminal looked cut off at the bottom; it now renders full-height regardless of how the app was launched.
- The PTY is sized from the pane's real geometry: a degenerate (0×0 / 1-row) measurement during a slow first paint is no longer sent, and the grid re-fits at several settle points after spawn so it reliably fills the pane.

## [0.2.0] - 2026-05-24

A performance, security, and design release. No data migration required; the
persisted session format is unchanged.

### Added

- **Responsive layout** — the app now reflows across narrow and wide windows, with a resizable inspector panel.

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

[Unreleased]: https://github.com/seizeddev/swarm/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/seizeddev/swarm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/seizeddev/swarm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/seizeddev/swarm/releases/tag/v0.1.0
