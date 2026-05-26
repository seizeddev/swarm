# Contributing to swarm

Thanks for helping build swarm — it's early, and issues, ideas, and PRs are all
welcome. This guide gets you from a fresh clone to a running dev build, then
explains how the project is laid out, what the house rules are, and how to land
a change that passes CI the first time.

If anything here is unclear or out of date, that's a bug too — open an issue or
fix it in a PR.

---

## Prerequisites

swarm is a [Tauri 2](https://v2.tauri.app) app: a **React + Vite** frontend in a
system webview, talking to a **Rust** core. You need three things, plus a few
OS-level libraries Tauri builds against.

| Tool | Version | How to get it |
| --- | --- | --- |
| **Node** | ≥ 20 | [nodejs.org](https://nodejs.org) or your version manager |
| **pnpm** | 10.32.1 (pinned) | `corepack enable` — picks up the version pinned in `package.json` automatically |
| **Rust** | 1.95.0 | [`rustup`](https://rustup.rs), then `rustup toolchain install 1.95.0` and `rustup component add rustfmt clippy` |

CI builds against Rust **1.95.0** exactly, so match it locally to avoid
"works on my machine" lint differences (`rustup override set 1.95.0` inside the
repo pins it per-directory).

### OS-level dependencies

Tauri links against your platform's native webview and a few system libraries.
Install them once:

- **macOS** — Xcode Command Line Tools: `xcode-select --install`. Nothing else.
- **Windows** — the **Microsoft C++ Build Tools** (the "Desktop development with
  C++" workload) and **WebView2** (preinstalled on Windows 11; the Tauri build
  pulls it in on Windows 10).
- **Linux (Debian/Ubuntu)** — the same packages CI installs:

  ```bash
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  Other distros: see the package names in the
  [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

> Optional: install [`gh`](https://cli.github.com) and run `gh auth login` to
> exercise the Pull Requests panel. swarm stores no credentials of its own — it
> rides on your existing `gh` auth.

---

## Getting started

```bash
# 1. Clone (no submodules — a plain clone is everything).
git clone https://github.com/seizeddev/swarm.git
cd swarm

# 2. Install frontend dependencies.
pnpm install

# 3. Run the app in development (Vite HMR + the Rust core, hot-reloading both).
pnpm tauri dev
```

The first `pnpm tauri dev` compiles the Rust core from scratch, so it takes a few
minutes; subsequent runs are incremental and fast. The app window opens
automatically and reloads on frontend edits; Rust changes trigger a rebuild.

To produce a real, installable bundle (`.app`/`.dmg`, `.msi`/`.exe`,
`.deb`/`.AppImage`/`.rpm`) instead of a dev window:

```bash
pnpm tauri build
```

> **Local bundles are unsigned.** On macOS the build's final *updater-signing*
> step will error unless `TAURI_SIGNING_PRIVATE_KEY` is set — that's expected and
> harmless: the `.app` and `.dmg` are already built by then. To run the local
> `.app`, ad-hoc sign it once: `codesign --force --deep --sign - path/to/swarm.app`.
> Signed updater artifacts come from CI, which holds the key.

---

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm tauri dev` | Run the full app in development (frontend HMR + Rust core). |
| `pnpm tauri build` | Build a production, installable bundle for the current OS. |
| `pnpm dev` | Frontend-only Vite server (no Rust). Rarely what you want — IPC commands won't resolve. |
| `pnpm build` | Type-check (`tsc`) **and** build the frontend into `dist/`. |
| `pnpm test` | Run the frontend unit tests (Vitest) once. |
| `pnpm test:watch` | Frontend tests in watch mode. |
| `pnpm test:coverage` | Frontend tests with the 85 % coverage gate (what CI enforces). |
| `cargo test` | Rust unit + integration tests. Run from `src-tauri/`. |
| `cargo clippy --all-targets -- -D warnings` | Rust lints, warnings-as-errors. From `src-tauri/`. |
| `cargo fmt --check` | Rust formatting check. From `src-tauri/`. |

Rust commands run inside `src-tauri/` (or add `--manifest-path src-tauri/Cargo.toml`
from the repo root, as CI does).

---

## How swarm fits together

A 60-second mental model, top to bottom:

- The **Rust core** (`src-tauri/`) owns everything stateful and privileged — the
  PTYs and terminal emulation, libgit2, the `gh` calls, the filesystem watcher.
  It exposes typed **Tauri commands**; the frontend never touches the OS directly.
- The **terminal** is emulated in Rust (the Alacritty VT engine) and the grid is
  streamed to the webview as compact **binary frames** over an IPC channel. The
  frontend paints that grid onto a GPU `<canvas>` (WebGL2, with a Canvas2D
  fallback) — it never parses ANSI itself.
- The **frontend** (`src/`) is React + Vite + Tailwind, with a zustand store
  (`store.ts`) as the single source of truth, talking to Rust through a typed IPC
  layer (`src/lib/`).

See [README → Architecture](./README.md#architecture) for the longer version.

### Project layout

```
src/                React + Vite + Tailwind v4 frontend
  components/        Sidebar, Workspace, Terminal (canvas orchestrator), DiffViewer
  lib/              typed Tauri IPC, shared types, theme/palette
  lib/term/         terminal renderer: grid model, metrics, glyph atlas,
                    WebGL2/Canvas2D backends, input + selection encoding
  store.ts           zustand app state (source of truth)

src-tauri/src/       Rust core
  git.rs            libgit2 status / diff / branches / staging + write-ops
                    (discard, checkout, reset, revert); resolves linked worktrees
  terminal.rs        Alacritty VT engine + PTY + grid streaming (wire protocol v2)
  github.rs          PR status + checkout via `gh`
  agents.rs          agent registry + PATH detection
  agent_session.rs   capture/restore agent session id + launch flags (cmux-style)
  agent_hooks.rs     install per-agent session-start hooks
  notify_helper.rs   `swarm --notify-helper` (last-message + session capture)
  macos_notify.rs    native banners via UNUserNotificationCenter (objc2)
  osc.rs             OSC notification / hyperlink parsing
  watcher.rs         filesystem change events (notify)
  guard.rs           path-allowlist registry for path-taking commands
  error.rs           one serializable error type for every command
  lib.rs             Tauri command wiring (the entrypoint)
```

---

## House rules

These keep the codebase coherent and the security posture intact. PRs are
expected to follow them.

- **The webview never parses ANSI.** Terminal emulation lives in `terminal.rs`;
  the frontend only paints the grid it's handed.
- **No shelling out to `git`.** Use libgit2 (`git2`) in `git.rs`.
- **Don't store credentials.** GitHub access goes through the user's existing
  `gh` auth, never a token swarm holds.
- **No `unwrap`/`expect`/`panic!` in production Rust.** Errors flow through the
  single type in `error.rs`. (The Tauri entrypoint in `lib.rs` is the only
  exception.)
- **Every source file carries the SPDX header** (`.css` uses `/* … */`):

  ```
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```

  Don't strip trailing newlines either — it breaks `cargo fmt --check` / prettier.
- **The UI is strictly monochrome.** Accent is brightness, not hue; colour is
  reserved for git status. Pull shades from the existing CSS variables rather
  than hard-coding new ones.
- **Keep it light.** Avoid heavy dependencies and respect the size-optimized
  release profile.

---

## Tests

Both halves of the app are unit-tested, and CI gates every push and PR.

- **Frontend (Vitest)** — pure logic plus the zustand store against a mocked IPC
  layer. Tests live in `src/**/__tests__/*.test.ts`. `pnpm test:coverage`
  enforces an **85 %** threshold; add tests rather than lowering it.
- **Rust (cargo)** — git, terminal VT/OSC parsing, agents, github, errors. Tests
  live in a `#[cfg(test)] mod tests` at the bottom of each module, each operating
  on its own throwaway repo / scratch dir under the temp directory.

Add or update a test whenever you touch `git.rs`, `terminal.rs`, or `store.ts`.

---

## Before you push: reproduce the CI gate

CI runs exactly these. Running them locally first means green on the first try.
One ordering gotcha: **build the frontend before the Rust steps** — Tauri's
`generate_context!()` embeds `../dist`, so the Rust crate won't build without it.

```bash
# Frontend gate
pnpm install --frozen-lockfile
pnpm test:coverage
pnpm build            # tsc typecheck + Vite build → dist/ (also needed by Rust below)

# Rust gate (from src-tauri/)
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`fmt` and `clippy` are checked on Linux in CI, but `cargo test` runs on
**macOS, Linux, and Windows** — so test logic must be platform-agnostic (e.g.
don't assume LF line endings; Windows git may apply `core.autocrlf`).

---

## Commits & PRs

- Keep PRs focused and describe the **user-facing** change.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `perf:`, `refactor:`, `chore:`, `docs:`…) — scan `git log`
  for the house style.
- Add or update a test when you touch `git.rs`, `terminal.rs`, or `store.ts`.
- Run the CI gate above before pushing.
- Update `CHANGELOG.md` under `[Unreleased]` if the change is user-facing.

---

## Releasing & auto-updates

> Maintainer reference — you don't need this to contribute.

swarm ships signed self-updates via `tauri-plugin-updater`. The running app polls
`latest.json` on the GitHub release (at launch, on window focus, and every 15
min) and shows an **Update available** control at the foot of the rail; clicking
it downloads, verifies, installs, and offers a restart.

Updates must be **signed**, or clients reject them. The keypair was generated
with `pnpm tauri signer generate`:

- **Public key** lives in `tauri.conf.json` → `plugins.updater.pubkey`. Safe to commit.
- **Private key** is `~/.tauri/swarm.key` — **never commit it.** It lives in GitHub as:
  - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `~/.tauri/swarm.key`.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key is **password-protected**, and
    `release.yml` reads both secrets. They're exposed only to the protected
    `release` environment (required reviewers), so signing runs on an approved
    build, not on every matrix job. See the key-rotation runbook in
    [SECURITY.md](./SECURITY.md).

To cut a release:

1. **Bump the version in all four files** (they must match): `package.json`,
   `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock`
   (the last via `cargo update -p swarm --precise <version>`). Move the
   `CHANGELOG.md` `[Unreleased]` items under the new version.
2. **Tag and push:** `git tag v0.4.0 && git push origin v0.4.0`. ⚠️ `v*` tags are
   **protected — they can't be deleted or re-pointed.** If a build is wrong, bump
   to a new version; never re-tag.
3. `release.yml` creates one **draft** release, then a matrix builds every
   platform. The signing jobs sit behind the protected `release` environment, so
   **approve the run's pending deployment** before the matrix can sign and upload.
4. Once all platforms have uploaded their artifacts + `latest.json` to the draft,
   **publish it** (`gh release edit <tag> --draft=false`). The
   `releases/latest/download/latest.json` endpoint only resolves once it's the
   published latest release — that's the moment every running app starts offering
   the update.

If you lose the private key, you must first ship a new public key in an update
signed with the *old* key; otherwise existing installs can never update again.

---

## License of contributions

swarm is licensed under **GPL-3.0-or-later** (see [LICENSE](./LICENSE)). By
submitting a contribution you agree it is licensed under the same terms
(inbound = outbound), and that new source files carry the SPDX header shown in
the house rules above.
