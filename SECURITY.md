# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's [private vulnerability reporting](https://github.com/seizeddev/swarm/security/advisories/new), or email the maintainers. We aim to acknowledge reports within 72 hours.

## Scope & design

swarm is a local desktop app. A few properties worth knowing:

- **No credentials are stored by swarm.** GitHub access is delegated to your existing `gh` CLI authentication.
- **Git operations use libgit2** (the `git2` crate) directly — swarm does not shell out to `git`.
- **Terminals run real local processes** with your shell's privileges. Only run agents/commands you trust, the same as in any terminal.
- The frontend runs in the system webview and is scoped by **Tauri's capability system** (`src-tauri/capabilities/`).

A full analysis lives in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Confirmed guarantees

These are the security properties we actively maintain and verify:

- **Terminal output cannot inject UI.** The terminal is rendered as a cell grid built in Rust (Alacritty's VT engine), not as DOM/HTML — escape sequences become styled cells, never markup, so a hostile program's output can't mount an XSS.
- **No `git` shell-out.** All version-control work goes through libgit2, removing an entire class of argument-injection and `$PATH`-hijack risks.
- **Strict Content-Security-Policy.** `default-src 'self'`, no remote script, `object-src`/`frame-src`/`form-action` `'none'`, `base-uri 'self'`. This is the primary defence keeping a compromised page from executing or exfiltrating.
- **Filesystem blast-radius guard.** Every path-taking command is validated against a registry of roots the user explicitly opened (`src-tauri/guard.rs`); a subverted frontend can't reach `/etc` or spawn a shell in `/`.
- **`gh` is run hardened.** Non-interactive (no prompts), with a 15 s watchdog timeout, refs passed after a `--` separator, and dash-prefixed refs rejected.
- **Signed, rollback-protected updates.** Update artifacts are minisign-signed; the client refuses any version that isn't strictly newer than the running one (`src/lib/updater.ts`).
- **Hardened supply chain.** All GitHub Actions are pinned to commit SHAs; `cargo-deny` (RUSTSEC advisories + licence/ban/source policy), `pnpm audit`, and CodeQL gate every PR; releases carry SLSA build provenance; OpenSSF Scorecard tracks posture.
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
