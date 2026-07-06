// SPDX-License-Identifier: GPL-3.0-or-later
import { Modal } from "./Modal";
import { ALT, isMac, MOD, SHIFT } from "../lib/platform";

interface Shortcut {
  keys: string[];
  action: string;
}
interface Group {
  title: string;
  items: Shortcut[];
}

// Mirrors the native accelerators in src-tauri/src/lib.rs (`accel(mac, other)`)
// and the README table. On Windows/Linux many chords carry Shift/Alt because a
// bare Ctrl+letter would be translated before the webview and steal the
// terminal's control bytes (Ctrl+C interrupt, Ctrl+D EOF, tmux's Ctrl+B, …) —
// the same reason Windows Terminal and gnome-terminal use Ctrl+Shift chords.
const GROUPS: Group[] = [
  {
    title: "Projects",
    items: [
      { keys: isMac ? [MOD, "N"] : [MOD, SHIFT, "N"], action: "New project" },
      { keys: isMac ? [MOD, SHIFT, "W"] : [MOD, ALT, "W"], action: "Close project" },
      { keys: [MOD, "1–9"], action: "Jump to project 1–9" },
      { keys: [MOD, SHIFT, "]"], action: "Next project" },
      { keys: [MOD, SHIFT, "["], action: "Previous project" },
    ],
  },
  {
    title: "Terminals",
    items: [
      { keys: isMac ? [MOD, "T"] : [MOD, SHIFT, "T"], action: "New terminal" },
      { keys: isMac ? [MOD, "D"] : [MOD, SHIFT, "D"], action: "Split right" },
      { keys: isMac ? [MOD, SHIFT, "D"] : [MOD, ALT, "D"], action: "Split down" },
      { keys: isMac ? [MOD, "W"] : [MOD, SHIFT, "W"], action: "Close terminal" },
      {
        keys: [MOD, "C"],
        action: isMac ? "Copy selection (else SIGINT)" : "Copy selection (else interrupt)",
      },
      ...(isMac
        ? []
        : [
            { keys: [MOD, SHIFT, "C"], action: "Copy selection" },
            { keys: [MOD, SHIFT, "V"], action: "Paste" },
          ]),
    ],
  },
  {
    title: "View",
    items: [
      { keys: [MOD, SHIFT, "P"], action: "Command palette" },
      { keys: isMac ? [MOD, "B"] : [MOD, SHIFT, "B"], action: "Toggle sidebar" },
      { keys: [MOD, SHIFT, "G"], action: "Source Control" },
      { keys: isMac ? [MOD, "I"] : [MOD, SHIFT, "I"], action: "Notifications" },
      { keys: [MOD, ","], action: "Settings" },
      { keys: [MOD, SHIFT, "="], action: "Zoom in" },
      { keys: [MOD, "-"], action: "Zoom out" },
      { keys: [MOD, "0"], action: "Actual size" },
      ...(isMac ? [] : [{ keys: ["F11"], action: "Full screen" }]),
    ],
  },
];

function Key({ children }: { children: string }) {
  return (
    <kbd
      className="nums inline-grid min-w-[22px] place-items-center rounded-[8px] border border-[var(--color-border)] bg-[var(--color-recessed)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-muted)]"
      style={{ boxShadow: "inset 0 0.5px 0 rgba(255,255,255,0.08)" }}
    >
      {children}
    </kbd>
  );
}

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} labelledBy="shortcuts-title">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h2
          id="shortcuts-title"
          className="text-md font-semibold tracking-[-0.01em] text-[var(--color-text)]"
        >
          Keyboard Shortcuts
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="label-caps-dim mb-2">{g.title}</h3>
              <ul className="flex flex-col gap-2">
                {g.items.map((s) => (
                  <li key={s.action} className="flex items-center justify-between gap-3">
                    <span className="text-base text-[var(--color-muted)]">{s.action}</span>
                    <span className="flex flex-none items-center gap-1">
                      {s.keys.map((k, i) => (
                        <Key key={i}>{k}</Key>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
