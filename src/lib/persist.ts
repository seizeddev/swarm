// SPDX-License-Identifier: GPL-3.0-or-later
// Session snapshot persisted to a file by the Rust core (~/.swarm/session.json).
// Like cmux, we restore the *layout* + working dirs and re-spawn terminals
// (resuming agent sessions) — live process state is not checkpointed.
import type { Layout } from "./layout";
import { api } from "./ipc";

interface SnapPane {
  paneId: string;
  tabId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  title: string;
  sessionId?: string;
}
interface SnapTab {
  id: string;
  layout: Layout;
  activeLeaf: string;
}
interface SnapWorkspace {
  id: string;
  repoPath: string;
  panel: string;
  activeTab: string | null;
  tabs: SnapTab[];
  panes: SnapPane[];
}
export interface Snap {
  v: 1;
  activeWorkspaceId: string | null;
  workspaces: SnapWorkspace[];
}

export function saveSnap(s: Snap): void {
  api.saveSession(JSON.stringify(s)).catch(() => {});
}

export async function loadSnap(): Promise<Snap | null> {
  try {
    const raw = await api.loadSession();
    return raw ? (JSON.parse(raw) as Snap) : null;
  } catch {
    return null;
  }
}
