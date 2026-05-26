// SPDX-License-Identifier: GPL-3.0-or-later
// Shared command registry — the single source of truth for actions reachable
// from both the native menu (App.handleMenu dispatches by id) and the Command
// Palette (⌘⇧P). One behaviour, one path: a command's `run` calls a store action
// (or an injected handler for the few DOM/dialog-bound actions), so neither
// surface re-implements the logic. Pure & unit-testable — no DOM/Tauri imports
// here; anything that needs the document/dialog is passed in via `handlers`.
import { useStore } from "../store";

export type CommandGroup = "Projects" | "Terminals" | "View" | "Agents";

export interface Command {
  /** Matches the native-menu item id where one exists (so menu dispatch and the
   *  palette share an entry); synthetic ids (e.g. `switch_ws_<id>`) for the rest. */
  id: string;
  label: string;
  group: CommandGroup;
  run: () => void;
}

/** Actions that can't live in the pure store (a dialog, the zoom DOM mutation,
 *  opening a modal) — App wires these in so the registry stays testable. */
export interface CommandHandlers {
  newWorkspace: () => void;
  closeWorkspace: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  openShortcuts: () => void;
  openIntegrations: () => void;
}

/**
 * Build the live command list against the current store snapshot. Dynamic
 * entries (one "Switch to <project>" per workspace) reflect the open workspaces
 * at call time, so the palette rebuilds this each time it opens.
 */
export function buildCommands(h: CommandHandlers): Command[] {
  const s = useStore.getState();
  const cmds: Command[] = [
    // ── Projects ──────────────────────────────────────────────────────────────
    { id: "new_workspace", label: "New Project…", group: "Projects", run: h.newWorkspace },
    {
      id: "ws_next",
      label: "Next Project",
      group: "Projects",
      run: () => useStore.getState().cycleWorkspace(1),
    },
    {
      id: "ws_prev",
      label: "Previous Project",
      group: "Projects",
      run: () => useStore.getState().cycleWorkspace(-1),
    },
    // ── Terminals ─────────────────────────────────────────────────────────────
    {
      id: "new_terminal",
      label: "New Terminal",
      group: "Terminals",
      run: () => useStore.getState().addPane(),
    },
    {
      id: "split_right",
      label: "Split Right",
      group: "Terminals",
      run: () => useStore.getState().splitActive("row"),
    },
    {
      id: "split_down",
      label: "Split Down",
      group: "Terminals",
      run: () => useStore.getState().splitActive("col"),
    },
    {
      id: "close_pane",
      label: "Close Terminal",
      group: "Terminals",
      run: () => useStore.getState().closeActivePane(),
    },
    // ── View ──────────────────────────────────────────────────────────────────
    {
      id: "toggle_sidebar",
      label: "Toggle Sidebar",
      group: "View",
      run: () => useStore.getState().toggleSidebar(),
    },
    {
      id: "panel_scm",
      label: "Source Control",
      group: "View",
      run: () => useStore.getState().setPanel("scm"),
    },
    {
      id: "panel_history",
      label: "History",
      group: "View",
      run: () => useStore.getState().setPanel("history"),
    },
    {
      id: "panel_prs",
      label: "Pull Requests",
      group: "View",
      run: () => useStore.getState().setPanel("prs"),
    },
    {
      id: "panel_notifications",
      label: "Notifications",
      group: "View",
      run: () => useStore.getState().setPanel("notifications"),
    },
    { id: "zoom_in", label: "Zoom In", group: "View", run: h.zoomIn },
    { id: "zoom_out", label: "Zoom Out", group: "View", run: h.zoomOut },
    { id: "zoom_reset", label: "Actual Size", group: "View", run: h.zoomReset },
    { id: "shortcuts", label: "Keyboard Shortcuts", group: "View", run: h.openShortcuts },
    // ── Agents ────────────────────────────────────────────────────────────────
    {
      id: "agent_integrations",
      label: "Agent Integrations…",
      group: "Agents",
      run: h.openIntegrations,
    },
  ];

  // "Close Project" only when one is open (it acts on the active workspace).
  if (s.activeWorkspaceId) {
    cmds.splice(1, 0, {
      id: "close_workspace",
      label: "Close Project",
      group: "Projects",
      run: h.closeWorkspace,
    });
  }

  // One "Switch to <project>" per open workspace (skip the active one).
  for (const w of s.workspaces) {
    if (w.id === s.activeWorkspaceId) continue;
    cmds.push({
      id: `switch_ws_${w.id}`,
      label: `Switch to ${w.name ?? w.repo.name}`,
      group: "Projects",
      run: () => useStore.getState().setActiveWorkspace(w.id),
    });
  }

  return cmds;
}

/** Case-insensitive subsequence/substring filter for the palette input. Empty
 *  query returns the list unchanged. Matches if every query char appears in
 *  order in the label (fuzzy) — falling back to a plain substring is implied. */
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds.filter((c) => fuzzyMatch(c.label.toLowerCase(), q));
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
