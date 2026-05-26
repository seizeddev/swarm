# Contributing to swarm

Thanks for helping build swarm. It's early — issues, ideas, and PRs are all welcome.

## Project layout

```
src/            React + Vite + Tailwind v4 frontend
  components/   Sidebar, Workspace, Terminal (canvas orchestrator), DiffViewer
  lib/          ipc (typed Tauri commands), types, theme (palette)
  lib/term/     terminal renderer: grid model, metrics, glyph atlas,
                WebGL2/Canvas2D backends, input + selection encoding
  store.ts      zustand app state
src-tauri/src/  Rust core
  git.rs            libgit2 status / diff / branches / staging + write-ops
                    (discard, checkout, reset, revert); resolves linked worktrees
  terminal.rs       Alacritty VT engine + PTY + grid streaming (wire v2)
  github.rs         PR status + checkout via `gh`
  agents.rs         agent registry + PATH detection
  agent_session.rs  capture/restore agent session id + launch flags (cmux-style)
  agent_hooks.rs    install per-agent session-start hooks
  notify_helper.rs  `swarm --notify-helper` (last-message + session capture)
  macos_notify.rs   UNUserNotificationCenter banners (objc2)
  osc.rs            OSC notification/hyperlink parsing
  watcher.rs        filesystem change events (notify)
  guard.rs          path-allowlist registry for path-taking commands
  error.rs          one serializable error type for all commands
  lib.rs            Tauri command wiring
```

## Ground rules

- **The webview never parses ANSI.** Terminal emulation lives in `terminal.rs`; the frontend only paints the grid it receives.
- **No shelling out to `git`.** Use libgit2 (`git2`) in `git.rs`.
- **Don't store credentials.** GitHub access goes through the user's existing `gh` auth.
- **Keep it light.** Avoid heavy dependencies; respect the size-optimized release profile.

## Dev loop

```bash
pnpm install
pnpm tauri dev
```

## Tests

Both halves of the app are unit-tested and gated in CI.

```bash
# Frontend (Vitest) — pure logic + the zustand store with a mocked IPC layer.
pnpm test              # run once
pnpm test:watch        # watch mode
pnpm test:coverage     # enforces coverage thresholds (85%+)

# Rust core (cargo) — git, terminal VT/OSC parsing, agents, github, errors.
cd src-tauri
cargo test             # unit + integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Frontend tests live in `src/**/__tests__/*.test.ts`; Rust tests live in a
`#[cfg(test)] mod tests` at the bottom of each module, each operating on its own
throwaway repo/scratch dir under the temp directory. Frontend type-check:
`pnpm build` (runs `tsc`).

## Releasing & auto-updates

swarm ships signed self-updates via `tauri-plugin-updater`. The running app polls
`latest.json` on the GitHub release (at launch, on window focus, and every 15
min) and shows an **Update available** banner at the bottom of the sidebar;
clicking it downloads, verifies, installs, and offers a restart.

Updates must be **signed**, or clients reject them. The keypair was generated
with `pnpm tauri signer generate`:

- **Public key** lives in `tauri.conf.json` → `plugins.updater.pubkey`. Safe to commit.
- **Private key** is `~/.tauri/swarm.key` — **never commit it.** Add it to GitHub:
  - Repo → Settings → Secrets and variables → Actions → New repository secret
  - `TAURI_SIGNING_PRIVATE_KEY` = full contents of `~/.tauri/swarm.key`
  - The key is **password-protected**. Store the password as a second secret,
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `release.yml` reads both. Both secrets
    are exposed only to the protected `release` environment (required reviewers),
    so signing runs only on an approved build, not on every matrix job. See the
    key-rotation runbook in [SECURITY.md](./SECURITY.md).

To cut a release:

1. Bump `version` in **all four** files (they must match): `package.json`,
   `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock`
   (`cargo update -p swarm --precise <version>`). Add a `CHANGELOG.md` entry.
2. Tag and push: `git tag v0.4.0 && git push origin v0.4.0`. **`v*` tags are
   protected and cannot be deleted or re-pointed** — if a build is wrong, bump to
   a new version rather than re-tagging.
3. `release.yml` makes one **draft** release, then a matrix builds every platform.
   The signing jobs sit behind the protected `release` environment, so **approve
   the pending deployment** for the run before the build matrix can sign and upload.
4. Once all platforms have uploaded their artifacts + `latest.json` to the draft,
   **publish** it (`gh release edit <tag> --draft=false`). The endpoint
   `releases/latest/download/latest.json` only resolves once it's the published
   latest release — that's the moment every running app starts offering the update.

If you lose the private key, you must ship a new public key in an update signed
with the *old* key first; otherwise existing installs can never update again.

## Commits & PRs

- Keep PRs focused; describe the user-facing change.
- Add or update a test when you touch `git.rs`, `terminal.rs`, or `store.ts`.
- Run `pnpm test:coverage`, `cargo test`, and `pnpm build` before pushing.

## License of contributions

swarm is licensed under **GPL-3.0-or-later** (see [LICENSE](./LICENSE)). By
submitting a contribution you agree it is licensed under the same terms
(inbound = outbound). New source files should carry the SPDX header:

```
// SPDX-License-Identifier: GPL-3.0-or-later
```
