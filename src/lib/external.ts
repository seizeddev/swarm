// SPDX-License-Identifier: GPL-3.0-or-later
// Guarded wrapper around the system opener. The opener plugin will hand a URL
// straight to the OS (`xdg-open`/`open`/`ShellExecute`), so an attacker-supplied
// `file:`, `javascript:`, or custom-scheme URL must never reach it. We only ever
// open PR links, which are always https://github.com/… — so the allowlist is
// deliberately tight: http(s) only.
import { openUrl } from "@tauri-apps/plugin-opener";

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/** True iff `url` parses and uses an http(s) scheme. */
export function isOpenableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Open an external URL via the OS, but only http(s). Returns a promise that
 * resolves when handed off, or rejects if the scheme is disallowed — callers
 * treat rejection as "nothing happened" (no navigation, no shell handler).
 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) {
    throw new Error(`refusing to open non-http(s) URL: ${url}`);
  }
  await openUrl(url);
}
