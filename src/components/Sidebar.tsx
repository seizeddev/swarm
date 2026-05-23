// SPDX-License-Identifier: GPL-3.0-or-later
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpCircle,
  Bell,
  Download,
  GitBranch,
  GitPullRequest,
  History,
  Loader2,
  Plus,
  RotateCw,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { useActiveWorkspace, useStore, type Panel } from "../store";
import {
  NotificationsPanel,
  PullRequestsPanel,
  SourceControlPanel,
  TerminalsPanel,
} from "./panels";
import { GraphPanel } from "./GraphPanel";
import { useShallow } from "zustand/react/shallow";

const ATTN = "var(--color-text)";

function SwarmMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <polygon points="45.97,42.0 47.97,14.68 57.03,16.94" />
      <circle cx="52.5" cy="15.81" r="4.67" />
      <polygon points="52.8,41.5 73.54,23.59 78.35,31.59" />
      <circle cx="75.95" cy="27.59" r="4.67" />
      <polygon points="58.0,45.97 85.32,47.97 83.06,57.03" />
      <circle cx="84.19" cy="52.5" r="4.67" />
      <polygon points="58.5,52.8 76.41,73.54 68.41,78.35" />
      <circle cx="72.41" cy="75.95" r="4.67" />
      <polygon points="54.03,58.0 52.03,85.32 42.97,83.06" />
      <circle cx="47.5" cy="84.19" r="4.67" />
      <polygon points="47.2,58.5 26.46,76.41 21.65,68.41" />
      <circle cx="24.05" cy="72.41" r="4.67" />
      <polygon points="42.0,54.03 14.68,52.03 16.94,42.97" />
      <circle cx="15.81" cy="47.5" r="4.67" />
      <polygon points="41.5,47.2 23.59,26.46 31.59,21.65" />
      <circle cx="27.59" cy="24.05" r="4.67" />
    </svg>
  );
}

async function pickRepo(addWorkspace: (p: string) => void) {
  const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
  if (typeof dir === "string") addWorkspace(dir);
}

function WorkspaceSquare({ id, name }: { id: string; name: string }) {
  const { activeWorkspaceId, setActiveWorkspace } = useStore(
    useShallow((s) => ({
      activeWorkspaceId: s.activeWorkspaceId,
      setActiveWorkspace: s.setActiveWorkspace,
    })),
  );
  const attention = useStore((s) => s.panes.some((p) => p.workspaceId === id && p.attention));
  const active = activeWorkspaceId === id;
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <button
      onClick={() => setActiveWorkspace(id)}
      title={name}
      className="relative grid h-9 w-9 place-items-center rounded-[10px] text-[11px] font-bold transition"
      style={{
        background: active ? "var(--color-surface-2)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-muted)",
        boxShadow: active ? "inset 0 0.5px 0 rgba(255,255,255,0.14)" : "none",
        border: active ? "0.5px solid rgba(255,255,255,0.12)" : "0.5px solid transparent",
      }}
    >
      {initials}
      {attention && (
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-panel)]"
          style={{ background: ATTN }}
        />
      )}
    </button>
  );
}

function RailButton({
  panel,
  title,
  badge,
  children,
}: {
  panel: Panel;
  title: string;
  badge?: number;
  children: React.ReactNode;
}) {
  const ws = useActiveWorkspace();
  const setPanel = useStore((s) => s.setPanel);
  return (
    <button
      className="icon-btn relative h-9 w-9"
      data-active={ws?.panel === panel}
      title={title}
      onClick={() => setPanel(panel)}
    >
      {children}
      {!!badge && (
        <span
          className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold text-[var(--color-text)] ring-1 ring-white/10"
          style={{ background: "rgba(255,255,255,0.15)" }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

// Self-update indicator pinned to the bottom of the panel. Monochrome by design
// — brightness, never hue (status colours are reserved for git state). Idle =
// renders nothing. Clicking it drives the lifecycle: available → download →
// ready → relaunch.
function UpdateBanner() {
  // Stable per-field selectors: the banner re-renders only when `update`
  // changes — never on unrelated store churn (panes, git status, …). Actions
  // are stable refs in zustand, so selecting them costs no extra renders.
  const update = useStore((s) => s.update);
  const installUpdate = useStore((s) => s.installUpdate);
  const restartForUpdate = useStore((s) => s.restartForUpdate);
  const checkForUpdate = useStore((s) => s.checkForUpdate);
  if (update.status === "idle") return null;

  const pct = Math.round(update.progress * 100);
  const busy = update.status === "downloading";

  const config = {
    available: {
      icon: <Download size={15} />,
      title: "Update available",
      sub: update.version ? `v${update.version}` : "Click to install",
      onClick: installUpdate,
    },
    downloading: {
      icon: <Loader2 size={15} className="spin" />,
      title: "Downloading update…",
      sub: `${pct}%`,
      onClick: undefined,
    },
    ready: {
      icon: <RotateCw size={15} />,
      title: "Restart to update",
      sub: update.version ? `v${update.version} ready` : "Ready",
      onClick: restartForUpdate,
    },
    error: {
      icon: <ArrowUpCircle size={15} />,
      title: "Update failed",
      sub: "Click to retry",
      onClick: checkForUpdate,
    },
  }[update.status];

  return (
    <button
      type="button"
      disabled={busy}
      onClick={config.onClick}
      title={update.notes || config.title}
      className="relative m-3 flex items-center gap-2.5 overflow-hidden rounded-xl px-3 py-2.5 text-left transition disabled:cursor-default"
      style={{
        background: "var(--color-surface-2)",
        border: "0.5px solid rgba(255,255,255,0.12)",
        boxShadow: "inset 0 0.5px 0 rgba(255,255,255,0.12)",
      }}
    >
      <span
        className="grid h-7 w-7 flex-none place-items-center rounded-full text-[var(--color-text)]"
        style={{ background: "var(--color-accent-soft)" }}
      >
        {config.icon}
        {update.status === "available" && (
          <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text)]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-[var(--color-text)]">
          {config.title}
        </span>
        <span className="block truncate text-[11px] text-[var(--color-muted)]">{config.sub}</span>
      </span>
      {busy && (
        <span
          className="absolute inset-x-0 bottom-0 h-0.5 transition-[width] duration-200"
          style={{ width: `${pct}%`, background: "var(--color-text)" }}
        />
      )}
    </button>
  );
}

export function Sidebar() {
  const ws = useActiveWorkspace();
  const { workspaces, addWorkspace, notifications, error, sidebarVisible } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      addWorkspace: s.addWorkspace,
      notifications: s.notifications,
      error: s.error,
      sidebarVisible: s.sidebarVisible,
    })),
  );

  return (
    <>
      {/* Rail: workspaces on top, view nav below */}
      <div className="flex w-14 flex-none flex-col items-center gap-1.5 border-r border-[var(--color-border)] py-3">
        <div className="grid h-9 w-9 place-items-center">
          <SwarmMark />
        </div>
        <div className="divider my-1 w-7" />

        {workspaces.map((w) => (
          <WorkspaceSquare key={w.id} id={w.id} name={w.repo.name} />
        ))}
        <button
          className="icon-btn h-9 w-9"
          title="Add project"
          onClick={() => pickRepo(addWorkspace)}
        >
          <Plus size={18} />
        </button>

        {ws && (
          <>
            <div className="divider my-1 w-7" />
            <RailButton panel="terminals" title="Terminals">
              <TerminalSquare size={18} />
            </RailButton>
            <RailButton
              panel="notifications"
              title="Notifications"
              badge={notifications.length}
            >
              <Bell size={18} />
            </RailButton>
            <div className="divider my-1 w-7" />
            <RailButton panel="scm" title="Source Control" badge={ws.changes.length}>
              <GitBranch size={18} />
            </RailButton>
            <RailButton panel="history" title="History">
              <History size={18} />
            </RailButton>
            <RailButton panel="prs" title="Pull Requests" badge={ws.prs.length}>
              <GitPullRequest size={18} />
            </RailButton>
          </>
        )}

        <div className="flex-1" />
        <button className="icon-btn h-9 w-9" title="Settings">
          <Settings size={18} />
        </button>
      </div>

      {/* Panel */}
      <div
        className="w-[300px] flex-none flex-col border-r border-[var(--color-border)]"
        style={{ display: sidebarVisible ? "flex" : "none" }}
      >
        {ws ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-1 pt-4">
              <h1 className="truncate text-[16px] font-bold tracking-tight">{ws.repo.name}</h1>
              {ws.repo.headBranch && (
                <span className="truncate text-[12px] text-[var(--color-muted)]">
                  ⎇ {ws.repo.headBranch}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {ws.panel === "terminals" && <TerminalsPanel />}
              {ws.panel === "scm" && <SourceControlPanel />}
              {ws.panel === "prs" && <PullRequestsPanel />}
              {ws.panel === "history" && <GraphPanel />}
              {ws.panel === "notifications" && <NotificationsPanel />}
            </div>
          </>
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center">
            <div>
              <p className="mb-3 text-[14px] text-[var(--color-muted)]">No project open</p>
              <button className="btn btn-accent mx-auto" onClick={() => pickRepo(addWorkspace)}>
                <Plus size={15} /> Add project
              </button>
            </div>
          </div>
        )}

        {error && (
          <div
            className="m-3 rounded-xl border p-3 text-[12px]"
            style={{
              borderColor: "rgba(255, 107, 107, 0.30)",
              background: "var(--color-danger-soft)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        <div className="flex-none">
          <UpdateBanner />
        </div>
      </div>
    </>
  );
}
