<!-- Thanks for contributing to swarm! -->

## What & why

<!-- What does this change, and why? Link any issue: Closes #123 -->

## Checklist

- [ ] `cargo test` passes (`src-tauri`)
- [ ] `cargo fmt` + `cargo clippy -- -D warnings` clean
- [ ] `pnpm build` (typecheck) passes
- [ ] Added/updated a test for `git.rs` or `terminal.rs` if I touched them
- [ ] No credentials stored; GitHub access stays via the user's `gh`
- [ ] The webview does not parse ANSI (terminal emulation stays in Rust)
