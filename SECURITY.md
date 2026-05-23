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

## Supported versions

swarm is pre-1.0; only the latest release receives security fixes.
