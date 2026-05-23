# Contributing to swarm

Thanks for helping build swarm. It's early — issues, ideas, and PRs are all welcome.

## Project layout

```
src/            React + Vite + Tailwind v4 frontend
  components/   Sidebar, Workspace, Terminal (cell-grid renderer), DiffViewer
  lib/          ipc (typed Tauri commands), types, theme (palette), keys
  store.ts      zustand app state
src-tauri/src/  Rust core
  git.rs        libgit2 worktrees / status / diff / branches
  terminal.rs   Alacritty VT engine + PTY + grid streaming
  github.rs     PR status via `gh`
  agents.rs     agent registry + PATH detection
  error.rs      one serializable error type for all commands
  lib.rs        Tauri command wiring
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
`#[cfg(test)] mod tests` at the bottom of each module. Tests that touch `$HOME`
(worktree creation) serialize through a `HOME_LOCK` mutex — keep new
HOME-dependent tests behind it. Frontend type-check: `pnpm build` (runs `tsc`).

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
  - This key has **no password**, so there is no password secret. The workflow
    sets `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""` directly (GitHub rejects
    empty-valued secrets, and an empty password isn't sensitive). If you
    regenerate the key *with* a password, store it as a secret and reference it
    there instead.

To cut a release:

1. Bump `version` in `tauri.conf.json` **and** `src-tauri/Cargo.toml` (must match).
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds every platform, signs the artifacts,
   generates `latest.json`, and uploads everything to a **draft** release.
4. **Publish** the draft release. The endpoint
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
