// SPDX-License-Identifier: GPL-3.0-or-later
// One platform signal for the whole frontend. Detection was previously ad-hoc
// (Shortcuts.tsx read navigator.platform, notify.ts read userAgent) and most
// call sites that *should* branch simply didn't — Windows users saw ⌘ hints,
// "Reveal in Finder", and a bash fallback shell. `navigator.platform` is the
// cheapest reliable signal in both WKWebView and WebView2 ("MacIntel" /
// "Win32"); userAgent is the fallback for environments that stub platform.
// The pure `detect` core takes both strings explicitly so tests are
// deterministic regardless of the host running them.

export interface Platform {
  isMac: boolean;
  isWindows: boolean;
}

export function detect(platform: string, userAgent: string): Platform {
  return {
    isMac: /Mac|iPhone|iPad/.test(platform) || /Macintosh/.test(userAgent),
    isWindows: /Win/.test(platform) || /Windows/.test(userAgent),
  };
}

const current: Platform =
  typeof navigator === "undefined"
    ? { isMac: false, isWindows: false }
    : detect(navigator.platform ?? "", navigator.userAgent ?? "");

export const isMac: boolean = current.isMac;
export const isWindows: boolean = current.isWindows;

/** Display glyphs/words for modifier keys in shortcut hints. */
export const MOD = isMac ? "⌘" : "Ctrl";
export const SHIFT = isMac ? "⇧" : "Shift";
export const ALT = isMac ? "⌥" : "Alt";

/** Label for the OS file manager, used by "Reveal in …" menu items. */
export const fileManagerName = isMac ? "Finder" : isWindows ? "File Explorer" : "File Manager";

/**
 * Join a workspace-root path and a git-relative (always "/"-separated) path
 * into the OS-native absolute path shown to / copied for the user. The
 * platform is a parameter (defaulting to the detected one) so the Windows
 * branch is testable on any host.
 */
export function joinRepoPath(root: string, rel: string, windows: boolean = isWindows): string {
  if (windows) return `${root}\\${rel.split("/").join("\\")}`;
  return `${root}/${rel}`;
}

/** Last path component of an OS-native path (handles both separators). */
export function pathBasename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
