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
The terminal's VT parsing runs **in Rust** (Alacritty engine); the resulting cell
grid is streamed as binary frames and painted onto a **`<canvas>`** (WebGL2, with
a Canvas2D fallback) — escape sequences become pixels, never DOM/HTML. There is no
`dangerouslySetInnerHTML` path for terminal content, and terminal text never
becomes a DOM node at all. The OSC 9/99/777 notification parser is pure, unit-
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
shell spawned in `/`.

The registry is now a real boundary: roots only enter it through the Rust-side
`pick_workspace` IPC, which raises the native folder picker — the renderer
never sees `register_root`. The set is persisted to `~/.swarm/trusted-roots.json`
(mode 0600) and reloaded at startup; entries that no longer canonicalise are
dropped on load. Downstream commands operate on the **canonical** path the
guard returns (`ensured()` helper), so a symlink whose target moves between
the registry check and the call can't land work outside the workspace.

Per-list containment defends against a renderer mixing legitimate worktree
paths with traversal entries: `discard_paths` and `stage_paths` validate each
entry independently and silently skip anything that escapes the worktree root.

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
and **CodeQL**. npm dependencies are also **age-quarantined** (`minimumReleaseAge`
in `pnpm-workspace.yaml`, 7 days) so a freshly published — possibly compromised —
version can't be auto-pulled before it's had time to be flagged and unpublished
(`trustPolicy: no-downgrade` additionally rejects updates whose provenance or
signature signals have weakened); the fast-moving vite/rolldown toolchain is the
lone documented exclusion from the age gate.
Releases publish **SLSA build provenance** for every artifact, and
**OpenSSF Scorecard** tracks posture. The release signing key is isolated to a
protected Environment so a rogue matrix job can't read it.

### T6 — Local resource exhaustion
PTY sessions are capped (64) and the reader→render queue is bounded (~2 MB), so
flooding output applies OS backpressure instead of growing memory without bound.

### T7 — Local file disclosure
`~/.swarm` is created `0700` **at process start** (the first `swarm_dir()` call
sits in `setup()` before any session/event-file write, via `WorkspaceRegistry::load_trusted`).
Every subdirectory it creates (`events/`, `clipboard/`, `codex-home/`,
`agent-sessions/`) is locked to `0700` via the shared `fsperm` helper, and every
file (`session.json`, the Codex config copy, `trusted-roots.json`, the codex
`hooks.json`, `agent-sessions/<paneId>.json`) is `0600` — one audit point, one
chmod call site. Credential-bearing values in persisted agent records (cursor
`--api-key`, codex `--remote-auth-token-env`, …) are replaced with `[REDACTED]`
before write, so a stolen record doesn't surrender keys. `save_session`
validates the renderer's JSON against a typed envelope schema, refusing a
malformed snapshot rather than overwriting a good one. `save_clipboard_image`
is capped at 32 MiB.

### T8 — Renderer-side PTY injection / cross-pane writes (boundary 2)
A subverted renderer (or a script in the page) used to be able to call any
mutating PTY IPC with any live `pty_id` — there was nothing stopping it from
writing into another pane's agent. Every spawn now mints a UUID **sealed
token**; the corresponding IPCs (`pty_write`, `pty_resize`, `pty_set_visible`,
`pty_attach`, `pty_kill`, `pty_scroll`, `pty_selection_text`) require it,
compared constant-time on the Rust side. `pty_live` lists pane/PTY ids but
never the token — so even a script that gains read-only access to that list
can't write. `pty_reattach` rotates the token after a webview reload, so the
pre-reload page's token is invalidated at the rotation. `pty_spawn` also
allowlists `command` (only the user's login shell or a registered agent CLI
basename passes — `/usr/bin/curl` is refused).

### T9 — Renderer-controlled environment / login-shell hijack (boundary 2)
The frontend was free to push any `(key, value)` pair into the PTY env. The
login-shell wrapper (`$SHELL -ilc 'exec "$0" "$@"' …`) means a malicious
`LD_PRELOAD`, `ZDOTDIR`, `BASH_ENV`, or swapped `PATH` would land in the
sourced shell profile and swap the binary the agent runs. `terminal::spawn`
now applies a strict allowlist: only `SWARM_PANE_ID`, `SWARM_EVENT_FILE`,
`SWARM_AGENT_ARGV_JSON`, `CODEX_HOME`, and `CLAUDE_CODE_NO_FLICKER` survive
the renderer→PTY hop. The user's real `PATH`/`LANG`/etc reach the child
through the legitimate path — the login shell sources their profile.
`SWARM_EVENT_FILE` itself is containment-checked in `notify_helper`: the
target must canonicalise directly under `~/.swarm/events/`, so a renderer
can't redirect the per-pane event stream to `/etc/passwd` (or any
owner-writable file).

### T10 — Agent-resume re-arming attacker capabilities
The `agent_session` resume machinery rebuilds the agent's launch command on
restart. Without a guard, a launch captured with attacker-influenced flags
(`claude --mcp-config <evil.json>`, `--allowed[d]Tools …`, `--system-prompt
<override>`, `--add-dir`, `--plugin-dir`, …) would auto-re-arm the same
configuration on every relaunch — a persistence vector against the agent
itself. Per-agent `security_value_deny` sets mark these launches
non-restorable: the captured record is preserved (for observability) but
`resume_command` returns `None`, so the pane comes back as a clean shell
instead of re-rolling a hostile MCP server. Swarm's own injected
`--settings <json>` is filtered before the deny check, so a swarm-launched
Claude still restores cleanly.

External URL opens are gated through `open_external_url`, which rejects
non-http(s) schemes (file:, javascript:, custom URI handlers) in Rust
before the OS handler sees them. The renderer no longer holds the
`opener:allow-open-url` capability — every external open goes through this
checked path.

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
gh attestation verify <downloaded-artifact> --repo valewnrt/swarm
```
