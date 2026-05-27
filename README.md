<div align="center">

# swarm

**The agentic development environment, built around the terminal.**

Run a swarm of AI coding agents in parallel — with source control, diffs, and pull requests built in.

A lightweight, cross-platform desktop app. Rust core, native webview, no Electron.

[![CI](https://github.com/valewnrt/swarm/actions/workflows/ci.yml/badge.svg)](https://github.com/valewnrt/swarm/actions/workflows/ci.yml)
[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-informational.svg)](./LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555)

<br />

<img src="docs/demo.gif" alt="swarm in action — parallel Claude Code terminals, then the built-in Source Control view with per-file diffs" width="860" />

</div>

---

## Why swarm

Running several Claude Code / Codex sessions at once is the new normal. The terminal is the easy part — what's missing is everything *around* it: seeing what each agent changed, whether its PR is green, and getting back to exactly where you were after a restart.

[cmux](https://github.com/manaflow-ai/cmux) nailed the parallel-terminal feel but is deliberately *"a primitive, not a solution"* — macOS-only, and it leaves diffs and review to you. swarm keeps that terminal-first feel and folds in the parts you keep reaching for: a real Git view, pull requests, and per-agent session restore — on macOS, Linux, **and** Windows, in a binary that doesn't ship a browser.

## Features

### Terminals

- **A real terminal, done right.** VT emulation runs in Rust via the [Alacritty](https://github.com/alacritty/alacritty) engine and is painted on a GPU `<canvas>` (WebGL2, with a Canvas2D fallback). No xterm.js — so full-screen TUI agents like Claude Code render correctly, with mouse reporting, scrollback, selection/copy, and OSC 8 hyperlinks.
- **Infinite terminals & splits.** Split right or down into a tiled layout with draggable dividers; every session stays alive across tab and workspace switches.
- **Paste screenshots.** Paste an image straight into a terminal: swarm writes it to a temp file and hands the agent the file path, so agents that read images off disk just work.

### Agents & sessions

- **Agent-aware.** Detects the CLIs you have installed — Claude Code, Codex, Gemini, OpenCode, Amp, Cursor, Aider — and launches them in the right directory through your real login shell, so they inherit your full environment.
- **Session restore.** On relaunch, swarm rebuilds your workspaces, split layout, and working directories, and resumes each agent where it left off (`claude --resume <id>`, `codex resume <id>`, …) **with its original launch flags preserved** (e.g. `--dangerously-skip-permissions`).

### Git & GitHub, built in

- **Source Control.** A VS Code-style panel with staged/unstaged groups, stage/unstage, commit (⌘/Ctrl+Enter), and GitHub-style per-file diffs — all via libgit2, never shelling out to `git`.
- **Right-click anything.** Context menus across terminals, the diff tree, PR rows, and tabs, with Git write-ops (discard, checkout, create branch, reset, revert), PR checkout, and reveal-in-Finder.
- **Pull Requests.** Open PRs with passing / failing / pending checks, grouped by author, through your existing `gh` auth — swarm stores no tokens of its own.

### Stay in flow

- **Multi-project workspaces.** Open several repos at once and switch from the rail; each keeps its own terminals, source control, and PRs.
- **Notifications that tell you *which* agent.** A pane's tab and workspace light up when an agent needs you; when swarm is in the background, a native desktop banner fires (with sound) carrying the agent's actual last message — click it to focus the window and jump straight to the pane. swarm picks up OSC 9 / 99 (kitty) / 777 sequences and the bell, with an in-app history (unread badge, click-to-pane), focus-aware suppression, and dedup.

## Install

**Download a ready-to-run build — no toolchain required.** Grab the file for your OS from the [latest release](https://github.com/valewnrt/swarm/releases/latest):

| OS | Download | Then |
| --- | --- | --- |
| **macOS** | `swarm_*_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel) | Open the `.dmg`, drag **swarm** to Applications. First launch: right-click → **Open** (the build is unsigned, so a normal double-click is blocked once). |
| **Linux** | `swarm_*_amd64.AppImage` | `chmod +x swarm_*.AppImage && ./swarm_*.AppImage` — or install the `.deb` with `sudo apt install ./swarm_*.deb`. |
| **Windows** | `swarm_*_x64-setup.exe` | Run the installer. On the SmartScreen prompt: **More info → Run anyway** (unsigned build). |

Optional: install [`gh`](https://cli.github.com) and run `gh auth login` to enable the Pull Requests panel. That's it — swarm stores no credentials and needs no further setup.

swarm **auto-updates**: it checks the latest GitHub release at launch, on focus, and periodically, then offers a one-click, signed update — so you only download once.

> No build for your platform yet? Build it yourself in a few commands — see [Development](#development).

## Keyboard shortcuts

Shown with ⌘ for macOS; use **Ctrl** on Windows and Linux.

**Projects**

| Shortcut | Action |
| --- | --- |
| ⌘ N | New project |
| ⌘ ⇧ W | Close project |
| ⌘ 1–9 | Jump to project 1–9 |
| ⌘ ⇧ ] · ⌘ ⇧ [ | Next · previous project |

**Terminals**

| Shortcut | Action |
| --- | --- |
| ⌘ T | New terminal |
| ⌘ D | Split right |
| ⌘ ⇧ D | Split down |
| ⌘ W | Close terminal |
| ⌘ C | Copy selection (sends SIGINT when there's no selection) |

**Panels & view**

| Shortcut | Action |
| --- | --- |
| ⌘ ⇧ P | Command palette |
| ⌘ B | Toggle sidebar |
| ⌘ ⇧ G | Source Control |
| ⌘ I | Notifications |
| ⌘ / | Keyboard shortcuts |
| ⌘ , | Settings |
| ⌘ ⇧ = · ⌘ - · ⌘ 0 | Zoom in · out · reset |

## Architecture

```
┌───────────────────────────────────────────────┐
│  React + Vite + Tailwind v4    (system webview) │
│  • WebGL2/Canvas2D terminal renderer (no xterm) │
│  • source control · history · PRs · terminals   │
└───────────────▲─────────────────────────────────┘
                │  Tauri IPC (commands + Channel)
┌───────────────┴─────────────────────────────────┐
│  Rust core (src-tauri)                           │
│  • git.rs       libgit2: diff/status/history     │
│  • terminal.rs  Alacritty VT engine + PTY        │
│  • github.rs    PR status via `gh`               │
│  • agents.rs    agent registry + detection       │
└──────────────────────────────────────────────────┘
```

Terminal bytes are parsed by the Alacritty engine **in Rust**; only the resulting cell grid (run-length-coalesced) is streamed to the frontend over a Tauri `Channel`, where it's painted on a `<canvas>` (WebGL2, Canvas2D fallback). The webview never parses ANSI, and terminal text never becomes a DOM node.

## Performance & security

- Native system webview + a size-optimized Rust release profile (`lto`, `opt-level=s`, `panic=abort`, stripped). No bundled Chromium, no Node runtime shipped.
- Git operations use libgit2 directly — no shelling out to `git`.
- GitHub access is delegated to your existing `gh` auth; swarm stores no credentials.
- A strict Content-Security-Policy plus a path-allowlist guard scope what the frontend can reach. The full threat model lives in [SECURITY.md](./SECURITY.md) and [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

## Development

Want to hack on swarm? The full guide — prerequisites, project layout, house rules, and how to reproduce the CI gate locally — is in **[CONTRIBUTING.md](./CONTRIBUTING.md)**. The short version:

```bash
git clone https://github.com/valewnrt/swarm.git
cd swarm
corepack enable     # activates the pinned pnpm (bundled with Node 20+)
pnpm install
pnpm tauri dev      # run the app (frontend HMR + Rust core)
pnpm tauri build    # build an installable bundle

# Rust core
cd src-tauri && cargo test
```

## License

[GNU General Public License v3.0 or later](./LICENSE) © 2026-present Valentin Weinert and the swarm contributors.

swarm is **copyleft**: you may use, study, share, and modify it freely, but any distributed derivative must also be released under the GPLv3. This keeps swarm and its forks open — no one can ship a closed-source commercial version.

**Need a non-GPL license?** A commercial license is available for organizations that can't comply with the GPL — for example, to embed swarm in a closed-source product. Contact **seized870@gmail.com**.
