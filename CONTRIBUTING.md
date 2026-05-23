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

## Commits & PRs

- Keep PRs focused; describe the user-facing change.
- Add or update a test when you touch `git.rs`, `terminal.rs`, or `store.ts`.
- Run `pnpm test:coverage`, `cargo test`, and `pnpm build` before pushing.
