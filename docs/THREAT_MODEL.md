# swarm — Threat Model

This document records what swarm defends against, what it explicitly does not,
and the mechanisms behind each guarantee. It complements [`SECURITY.md`](../SECURITY.md).

## What swarm is

A local, single-user desktop app (Tauri: a Rust core + the OS webview, no
Electron/Chromium bundle). It runs AI coding agents in real PTYs, shows git
state via libgit2, and surfaces GitHub PRs via the user's `gh` CLI. It self-updates
from signed GitHub releases.

## Assets

- The user's source repositories and local filesystem.
- The user's shell privileges (terminals run as the user).
- The user's `gh`/GitHub session (held by `gh`, not by swarm).
- The integrity of the installed binary and its updates (the whole user base).

## Trust boundaries

1. **Terminal output → app.** PTY bytes are fully attacker-influenced — any
   program an agent runs can emit arbitrary bytes, including OSC sequences.
2. **Frontend (webview) → Rust core.** All privileged work (filesystem, git,
   subprocess, PTY) crosses the Tauri IPC boundary into Rust.
3. **Network → updater.** `latest.json` and update artifacts are fetched over
   the network from GitHub.
4. **CI/supply chain → release artifacts.** Third-party Actions and dependencies
   participate in producing the signed binary.

## Threats and mitigations

### T1 — Terminal output injects UI / runs code (boundary 1)
The terminal renders as a **cell grid produced in Rust** (Alacritty VT engine),
streamed as binary frames and painted as styled `<span>`s — escape sequences
become cell attributes, never DOM/HTML. There is no `dangerouslySetInnerHTML`
path for terminal content. The OSC 9/99/777 notification parser is pure, unit-
tested, and **fuzzed** (`fuzz/fuzz_targets/parse_notifications.rs`). Notifications
are tagged with `source: "terminal"`, labelled as untrusted in the UI, and their
body is never treated as a URL or action.

### T2 — Compromised frontend reaches the filesystem (boundary 2)
The **CSP is the primary defence**: `default-src 'self'`, no remote/inline script
in production, `object-src`/`frame-src`/`frame-ancestors`/`form-action` `'none'`,
`base-uri 'self'`, `worker-src 'self'`. As defence-in-depth, every path-taking
IPC command validates its path against a registry of roots the user explicitly
opened (`src-tauri/guard.rs`, canonicalize + containment). So even a subverted
page can only touch repositories already on screen — no sudden `/etc` read, no
shell spawned in `/`. PTY spawns additionally reject an empty command and a
`cwd` outside an opened root.

### T3 — Argument injection / hangs via `gh` (boundary 2)
Every `gh` call goes through one hardened helper (`src-tauri/src/github.rs`):
non-interactive env (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, …), stdin
from `/dev/null`, a 15 s watchdog that kills a hung subprocess, and stdout drained
on a side thread to avoid pipe deadlock. The PR selector is passed after a `--`
separator so it can never be parsed as a flag.

### T4 — Malicious or downgrade update (boundary 3)
Update artifacts are **minisign-signed**; the client verifies the signature before
installing. As defence-in-depth against a tampered `latest.json`, the client also
refuses any version that is not **strictly newer** than the running one, blocking
a forced downgrade to a known-vulnerable release. The signing key is
password-protected and only reachable from a reviewer-gated release Environment.

### T5 — Supply-chain compromise (boundary 4)
GitHub Actions are pinned to **commit SHAs** (Dependabot keeps them current).
Tokens are least-privilege (`contents: read` by default), and checkouts that don't
push set `persist-credentials: false`. Merge gates: `cargo-deny` (RUSTSEC
advisories + licence allowlist + sources + bans), `pnpm audit --audit-level=high`,
and **CodeQL**. Releases publish **SLSA build provenance** for every artifact, and
**OpenSSF Scorecard** tracks posture. The release signing key is isolated to a
protected Environment so a rogue matrix job can't read it.

### T6 — Local resource exhaustion
PTY sessions are capped (64) and the reader→render queue is bounded (~2 MB), so
flooding output applies OS backpressure instead of growing memory without bound.

### T7 — Local file disclosure
`~/.swarm` is created `0700` and `session.json` / the Codex config copy are written
`0600` on Unix, so other local accounts can't read swarm's state.

## Out of scope / accepted risks

- **Commands the user runs are trusted.** Terminals execute real processes with
  the user's privileges — the same trust model as any terminal emulator. swarm
  does not sandbox agent commands.
- **`gh`/system trust.** A compromised `gh`, shell, or OS is out of scope.
- **Code signing / notarization** is not yet in place (tracked separately); the
  updater's signature provides artifact integrity in the meantime.
- **A malicious dependency that passes all gates** (advisory DB lag, a novel
  supply-chain attack) remains a residual risk, reduced but not eliminated by the
  measures in T5.

## Verifying a release artifact

Build provenance can be checked with the GitHub CLI:

```sh
gh attestation verify <downloaded-artifact> --repo seizeddev/swarm
```
