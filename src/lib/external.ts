// SPDX-License-Identifier: GPL-3.0-or-later
// Guarded wrapper around the system opener. The OS opener (`xdg-open`/`open`/
// `ShellExecute`) will resolve any URL it's handed, so an attacker-supplied
// `file:`, `javascript:`, or custom-scheme URL must never reach it. Defence in
// depth: the JS guard rejects before the IPC trip, and `open_external_url`
// rejects again in Rust. The renderer no longer has the `opener:allow-open-url`
// capability, so the only path to the OS opener is through this command.
import { invoke } from "@tauri-apps/api/core";

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
 *
 * The JS-side scheme check is the fast reject path; Rust re-validates and is
 * the authoritative gate (the renderer can't reach the OS opener any other way).
 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) {
    throw new Error(`refusing to open non-http(s) URL: ${url}`);
  }
  await invoke<void>("open_external_url", { url });
}
