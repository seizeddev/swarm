#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Bump the swarm version in lockstep across the four files that MUST agree
# (see CLAUDE.md → Releasing): package.json, src-tauri/Cargo.toml,
# src-tauri/tauri.conf.json, and src-tauri/Cargo.lock.
#
# Usage:
#   scripts/bump-version.sh 0.5.0    # set an explicit version
#   scripts/bump-version.sh patch    # 0.4.0 -> 0.4.1
#   scripts/bump-version.sh minor    # 0.4.0 -> 0.5.0  (default if no arg)
#   scripts/bump-version.sh major    # 0.4.0 -> 1.0.0
#
# It does NOT commit, tag, or touch CHANGELOG.md — those stay deliberate.

set -euo pipefail

# Run from the repo root regardless of where the script is invoked.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# cargo isn't on PATH in every shell here (see CLAUDE.md).
export PATH="$HOME/.cargo/bin:$PATH"

PKG="package.json"
CARGO_TOML="src-tauri/Cargo.toml"
TAURI_CONF="src-tauri/tauri.conf.json"

die() {
  echo "error: $*" >&2
  exit 1
}

# --- current version (source of truth: package.json) -------------------------
CURRENT="$(perl -ne 'if (/"version":\s*"([^"]+)"/) { print $1; exit }' "$PKG")"
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not read a semver version from $PKG (got '$CURRENT')"

# --- resolve the requested target into NEW -----------------------------------
ARG="${1:-minor}"
IFS=. read -r MAJ MIN PAT <<<"$CURRENT"
case "$ARG" in
  major) NEW="$((MAJ + 1)).0.0" ;;
  minor) NEW="${MAJ}.$((MIN + 1)).0" ;;
  patch) NEW="${MAJ}.${MIN}.$((PAT + 1))" ;;
  *)
    [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "argument must be major|minor|patch or an X.Y.Z version (got '$ARG')"
    NEW="$ARG"
    ;;
esac

if [[ "$NEW" == "$CURRENT" ]]; then
  die "new version equals current ($CURRENT) — nothing to do"
fi

echo "Bumping swarm: $CURRENT -> $NEW"

# --- rewrite the three text files (first matching version line only) ---------
# package.json + tauri.conf.json: the first `"version": "..."` key.
V="$NEW" perl -i -pe 'if (!$d && /"version":\s*"[^"]*"/) { s/("version":\s*")[^"]*(")/$1$ENV{V}$2/; $d=1 }' "$PKG"
V="$NEW" perl -i -pe 'if (!$d && /"version":\s*"[^"]*"/) { s/("version":\s*")[^"]*(")/$1$ENV{V}$2/; $d=1 }' "$TAURI_CONF"
# Cargo.toml: the first top-of-line `version = "..."` — that's [package]'s,
# never a dependency's (those are inline `{ version = "..." }`).
V="$NEW" perl -i -pe 'if (!$d && /^version = "[^"]*"/) { s/"[^"]*"/"$ENV{V}"/; $d=1 }' "$CARGO_TOML"

# --- Cargo.lock: the proper, lockfile-correct way ----------------------------
cargo update -p swarm --precise "$NEW" --manifest-path src-tauri/Cargo.toml >/dev/null 2>&1 \
  || die "cargo update failed — is cargo installed and src-tauri/Cargo.lock present?"

# --- verify all four now agree -----------------------------------------------
fail=0
check() { # file, grep-pattern, label
  if grep -q "$2" "$1"; then
    echo "  ✓ $3"
  else
    echo "  ✗ $3 — $1 was not updated to $NEW" >&2
    fail=1
  fi
}
check "$PKG"         "\"version\": \"$NEW\""  "package.json"
check "$CARGO_TOML"  "^version = \"$NEW\""    "src-tauri/Cargo.toml"
check "$TAURI_CONF"  "\"version\": \"$NEW\""  "src-tauri/tauri.conf.json"
grep -A1 '^name = "swarm"' src-tauri/Cargo.lock | grep -q "version = \"$NEW\"" \
  && echo "  ✓ src-tauri/Cargo.lock" || { echo "  ✗ src-tauri/Cargo.lock not at $NEW" >&2; fail=1; }

[[ "$fail" -eq 0 ]] || die "version bump incomplete — check the files above"

cat <<EOF

Done — all four files are at $NEW.

Next (deliberate, not automated):
  1. Move CHANGELOG.md [Unreleased] items under a [$NEW] section.
  2. Review:  git diff
  3. Commit:  git commit -am "chore(release): bump version to $NEW"
  4. Tag:     git tag v$NEW && git push origin main --tags
     (v* tags are protected — pick a NEW version if a build is wrong, never re-tag.)
EOF
