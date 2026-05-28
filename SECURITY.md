# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's [private vulnerability reporting](https://github.com/valewnrt/swarm/security/advisories/new), or email the maintainers. We aim to acknowledge reports within 72 hours.

## Scope & design

swarm is a local desktop app. A few properties worth knowing:

- **No credentials are stored by swarm.** GitHub access is delegated to your existing `gh` CLI authentication.
- **Git operations use libgit2** (the `git2` crate) directly — swarm does not shell out to `git`.
- **Terminals run real local processes** with your shell's privileges. Only run agents/commands you trust, the same as in any terminal.
- The frontend runs in the system webview and is scoped by **Tauri's capability system** (`src-tauri/capabilities/`).

A full analysis lives in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Confirmed guarantees

These are the security properties we actively maintain and verify:

- **Terminal output cannot inject UI.** VT parsing runs in Rust (Alacritty's engine) and the resulting cell grid is painted onto a `<canvas>` (WebGL2/Canvas2D), never DOM/HTML — escape sequences become pixels, never markup, so a hostile program's output can't mount an XSS.
- **No `git` shell-out.** All version-control work goes through libgit2, removing an entire class of argument-injection and `$PATH`-hijack risks.
- **Strict Content-Security-Policy.** `default-src 'self'`, no remote script, `object-src`/`frame-src`/`form-action` `'none'`, `base-uri 'self'`. This is the primary defence keeping a compromised page from executing or exfiltrating.
- **Filesystem blast-radius guard.** Every path-taking command is validated against a registry of roots the user explicitly opened (`src-tauri/guard.rs`); a subverted frontend can't reach `/etc` or spawn a shell in `/`. Roots only enter the registry through the Rust-side `pick_workspace` IPC, which raises the native folder picker — the renderer can no longer authorize a path itself. The set is mirrored to `~/.swarm/trusted-roots.json` (mode 0600) and reloaded at startup; stale entries are silently dropped.
- **PTY input requires a per-session sealed token.** `pty_spawn` returns `{id, token}`; every mutating PTY IPC (`pty_write`/`pty_resize`/`pty_kill`/…) needs the token, compared constant-time on the Rust side. `pty_reattach` rotates the token after a webview reload so the pre-reload page's token is dead. The token never leaks through `pty_live` (which only returns ids), so a script that gains read-only access to the live list still can't write into someone else's PTY.
- **Per-launch agent argv allowlisted.** `pty_spawn` rejects any `command` not in the agent registry or the user's login shell; the `env` is restricted to the swarm-internal keys (`SWARM_PANE_ID`, `SWARM_EVENT_FILE`, `SWARM_AGENT_ARGV_JSON`, `CODEX_HOME`, `CLAUDE_CODE_NO_FLICKER`), so a subverted renderer can't ride `LD_PRELOAD` / `ZDOTDIR` / `BASH_ENV` / a swapped `PATH` into the login-shell wrapper.
- **External URL opens are scheme-gated in Rust.** The `opener:allow-open-url` capability was dropped; every external open goes through `open_external_url`, which parses the URL with `url::Url` and refuses anything other than http/https before the OS handler sees it. The JS-side scheme check is a fast-reject layer above this.
- **Persisted agent sessions redact credential values.** `~/.swarm/agent-sessions/<paneId>.json` is mode 0600 and credential-bearing flag values (cursor `--api-key`/`-H`/`--header`, codex `--remote-auth-token-env`) are replaced with `[REDACTED]` before they hit disk. A captured launch that touched a tool/MCP/permission surface (claude `--mcp-config`, `--allowedTools`, `--system-prompt`, …) is also marked non-restorable, so auto-re-arming an attacker-supplied MCP server on every restart can't happen.
- **`gh` is run hardened.** Non-interactive (no prompts), with a 15 s watchdog timeout, refs passed after a `--` separator, and dash-prefixed refs rejected.
- **Signed, rollback-protected updates.** Update artifacts are minisign-signed; the client refuses any version that isn't strictly newer than the running one (`src/lib/updater.ts`).
- **Hardened supply chain.** All GitHub Actions are pinned to commit SHAs; `cargo-deny` (RUSTSEC advisories + licence/ban/source policy), `pnpm audit`, and CodeQL gate every PR; npm installs are age-quarantined (`minimumReleaseAge`, 7 days) so freshly published versions can't be auto-pulled before vetting, with `trustPolicy: no-downgrade` rejecting updates whose provenance/signature signals weaken; releases carry SLSA build provenance; OpenSSF Scorecard tracks posture.
- **Zero-panic Rust.** No `unwrap`/`expect`/`panic!` in production code; the OSC notification parser is fuzzed.

## Updater signing key — rotation runbook

The updater trusts a single minisign key pair. The **public** key lives in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the **private** key is a
repo secret and never enters the tree. To rotate (or set up) the key:

1. Generate a **password-protected** key:
   ```sh
   tauri signer generate -w ~/.tauri/swarm.key
   ```
   (Choose a strong passphrase when prompted.)
2. Put the printed **public key** into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`, and commit it.
3. Set the repo secrets (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `~/.tauri/swarm.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the passphrase from step 1.
4. Securely delete any old, unprotected key material.

> Rotating the public key breaks auto-update for clients pinned to the previous
> key (they must reinstall). swarm is pre-1.0, so this is acceptable; document it
> in the release notes when it happens.

The release signing job is gated behind a protected **`release` GitHub
Environment** (required reviewers), so the private key is exposed only to a
human-approved run — never to an arbitrary matrix build.

## Supported versions

swarm is pre-1.0; only the latest release receives security fixes.
