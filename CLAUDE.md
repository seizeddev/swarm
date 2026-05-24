# Working principle

- Do everything correctly. No shortcuts.
- Work end-to-end (E2E): finish the whole task, not just a part of it.
- Never guess. Act on knowledge — verify with code analysis, the docs, online research, or by running it.
- If you don't know, find out. Don't assume.

# Project knowledge (learnings)

## Build & verify

- **Rust isn't on `PATH`** in this env: prefix with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Frontend: `pnpm test` / `pnpm test:coverage` (≥85% gate) / `pnpm build` (= `tsc` typecheck + vite). Rust: from `src-tauri/`, `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- **Zero `unwrap/expect/panic!` in production Rust** (only the Tauri entrypoint in `lib.rs`). Keep it that way; errors go through `error.rs`.
- **Every source file carries an SPDX header** `// SPDX-License-Identifier: GPL-3.0-or-later` (CSS uses `/* */`). Add it to any new file. Don't strip trailing newlines (breaks `cargo fmt --check`/prettier).

## License

- **GPL-3.0-or-later** (copyleft — chosen to prevent closed-source commercial forks). `LICENSE`, `Cargo.toml`, `package.json` all declare it. Dependencies are compatible (libgit2 is GPLv2-with-linking-exception; Alacritty/Tauri are MIT/Apache).

## Config gotchas

- `tauri.conf.json` security has a strict prod **`csp`** and a permissive **`devCsp`** (for Vite HMR). `style-src` must keep **`'unsafe-inline'`** — the terminal cell-grid renders with inline styles. Verified rendering in both dev and a release binary.
- Keep `version` identical across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.

## Running / screenshotting the app (macOS)

- The app persists its session to **`~/.swarm/session.json`** (schema in `src/lib/persist.ts`) and restores it on launch. To launch into a specific state (e.g. for a screenshot), **back up the file, seed it** (workspace `repoPath`, a `terminals`/`scm`/`prs` panel, a split `layout`, `claude`/`shell` panes), launch, then **restore the backup**.
- Screen capture needs macOS **Screen Recording + Accessibility** TCC permissions (user-granted; can't be scripted). Get window bounds via `osascript`/System Events, capture with `screencapture -R x,y,w,h`.
- The UI is DOM (cell-grid, no `<canvas>`), but terminal/git/PR data arrives over Tauri IPC — a plain headless browser pointed at the Vite dev URL renders the shell with **no real data**.
- Running the bare `--no-bundle` binary shows a generic **"exec" Dock icon** (no `Info.plist`); the packaged `.app` shows the real icon.

## Releasing (read before touching `release.yml`)

- Triggered by a `v*` tag; builds all platforms and creates a **draft** release that must be **manually published** (`gh release edit <tag> --draft=false`). Needs the `TAURI_SIGNING_PRIVATE_KEY` repo secret for updater artifacts.
- **`release.yml` uses a two-phase pattern on purpose**: a `create-release` job makes one draft and outputs its `release_id`; every build job uploads via `releaseId`. **Do not** go back to per-job `releaseDraft: true` — parallel matrix jobs then race and produce duplicate drafts with artifacts split across them.
- `tauri-action` intermittently fails uploads with transient **`Bad credentials`** (and `actions/checkout` auth blips). Just `gh run rerun <run-id> --failed` — partial reruns keep `create-release`'s output, so artifacts land in the same draft and `latest.json` merges across platforms.
- Builds are **unsigned** (no Developer ID cert; only "Apple Development" certs exist in the keychain). For local install, ad-hoc sign works: `codesign --force --deep --sign - /Applications/swarm.app`.

## Security & supply chain

- **Threat model + guarantees** live in `SECURITY.md` and `docs/THREAT_MODEL.md`; the updater **key-rotation runbook** is in `SECURITY.md`. Update them when the security posture changes.
- **All GitHub Actions are pinned to commit SHAs** (with a `# vX` comment); Dependabot (`github-actions`) bumps them. When adding a workflow, resolve the SHA with `gh api repos/<owner>/<repo>/commits/<tag>` — never use a moving tag. `dtolnay/rust-toolchain` is a *branch*, so pin the action SHA **and** an explicit `toolchain:` (`1.95.0`; matches local).
- **Release signing is gated behind a protected `release` GitHub Environment** (required reviewers) so the password-protected `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) is exposed only to an approved run — not every matrix build. This sits *on top of* the two-phase create/upload pattern, don't remove either.
- **`cargo-deny` config is `src-tauri/deny.toml`.** Gotchas that took tuning: the `fix-path-env` git dep needs `version = "0.0.0"` in `Cargo.toml` (its rev's version) to clear the wildcard ban; `unmaintained = "workspace"` so un-fixable transitive advisories (gtk-rs GTK3, unic-* via tauri-utils) don't fail the gate while real vulnerabilities still do; `allow-git` lists the one vetted git source. Run `cargo deny check all` before touching deps.
- **Path-allowlist guard** (`src-tauri/src/guard.rs`, `WorkspaceRegistry`): every path-taking command validates against roots the frontend registered via `register_root`. The frontend must call `api.registerRoot(...)` (in `store.ts` `addWorkspace`/`hydrate`) **before** any git/PTY command, registering both the picked path and the canonical `repo.path`. `~/.swarm/worktrees` is implicitly allowed. The CSP remains the *primary* defence; this is blast-radius reduction.
- **Fuzzing** is an out-of-tree crate at `src-tauri/fuzz/` (cargo-fuzz, nightly-only, weekly `fuzz.yml`). It is **not** a member of the src-tauri package, so `cargo build`/`clippy`/`cargo-deny` never descend into it. The parser is reached via the `#[doc(hidden)] pub fn __fuzz_parse_notifications` crate-root export.

## Assets

- README hero is `docs/demo.gif`. `docs/banner.png` (+ `docs/make_banner.py`, which renders the in-app `SwarmMark` vector + palette) is the **GitHub social-preview source**, intentionally not referenced in the README.
