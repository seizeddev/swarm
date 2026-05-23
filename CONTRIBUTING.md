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

cd src-tauri
cargo test       # unit + integration tests
cargo clippy     # lints
```

Frontend type-check: `pnpm build` (runs `tsc`).

## Commits & PRs

- Keep PRs focused; describe the user-facing change.
- Add or update a test when you touch `git.rs` or `terminal.rs`.
- Run `cargo test` and `pnpm build` before pushing.
