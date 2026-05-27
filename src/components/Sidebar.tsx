// SPDX-License-Identifier: GPL-3.0-or-later
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpCircle,
  Bell,
  Copy,
  Download,
  FlaskConical,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  History,
  Keyboard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { useActiveWorkspace, useStore, type Panel } from "../store";
import { NotificationsPanel, PullRequestsPanel, SourceControlPanel } from "./panels";
import { GraphPanel } from "./GraphPanel";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "../lib/menu";
import { useShallow } from "zustand/react/shallow";
import { PANEL_DEFAULT, clampPanelWidth } from "../lib/panel";

const ATTN = "var(--color-text)";

export function SwarmMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" aria-hidden>
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

function WorkspaceSquare({
  id,
  name,
  onMenu,
}: {
  id: string;
  name: string;
  onMenu: (e: React.MouseEvent, id: string) => void;
}) {
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
      type="button"
      onClick={() => setActiveWorkspace(id)}
      onContextMenu={(e) => onMenu(e, id)}
      title={name}
      className="relative grid h-8 w-8 place-items-center rounded-[8px] text-xs font-bold transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]"
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
  const { setPanel, toggleSidebar, sidebarVisible } = useStore(
    useShallow((s) => ({
      setPanel: s.setPanel,
      toggleSidebar: s.toggleSidebar,
      sidebarVisible: s.sidebarVisible,
    })),
  );
  // "Active" = this is the selected view; "shown" also requires the panel to be
  // open. Clicking the already-shown view collapses the panel (VS Code-style),
  // so the rail doubles as the hide/show toggle at any window size. The
  // highlight tracks `shown`, so it clears when the panel is hidden.
  const active = ws?.panel === panel;
  const shown = active && sidebarVisible;
  return (
    <button
      type="button"
      className="icon-btn relative h-8 w-8"
      data-active={shown}
      title={shown ? `Hide ${title}` : title}
      onClick={() => (shown ? toggleSidebar() : setPanel(panel))}
    >
      {children}
      {!!badge && (
        <span
          className="nums absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-2xs font-bold"
          // Translucent at rest; on the shown tab it goes solid so it reads as
          // a deliberate count, not a faint overlay.
          style={
            shown
              ? {
                  background: "var(--color-text)",
                  color: "var(--color-bg)",
                  boxShadow: "0 0 0 1.5px var(--color-panel)",
                }
              : {
                  background: "rgba(255,255,255,0.15)",
                  color: "var(--color-text)",
                  boxShadow: "0 0 0 1px rgba(255,255,255,0.1)",
                }
          }
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

// Self-update indicator pinned to the bottom of the *rail* (main sidebar) as a
// compact icon — the full dialog reveals on hover. Monochrome by design —
// brightness, never hue (status colours are reserved for git state). Idle =
// renders nothing. Clicking the icon drives the lifecycle: available →
// download → ready → relaunch.
type UpdateConfig = { icon: ReactNode; title: string; sub: string; onClick?: () => void };

function RailUpdate() {
  // Stable per-field selectors: re-renders only when `update` changes — never
  // on unrelated store churn. Actions are stable refs in zustand.
  const update = useStore((s) => s.update);
  const installUpdate = useStore((s) => s.installUpdate);
  const restartForUpdate = useStore((s) => s.restartForUpdate);
  const checkForUpdate = useStore((s) => s.checkForUpdate);
  if (update.status === "idle") return null;

  const pct = Math.round(update.progress * 100);
  const busy = update.status === "downloading";

  const config: UpdateConfig = {
    available: {
      icon: <Download size={16} />,
      title: "Update available",
      sub: update.version ? `v${update.version}` : "Click to install",
      onClick: installUpdate,
    },
    downloading: {
      icon: <Loader2 size={16} className="spin" />,
      title: "Downloading update…",
      sub: `${pct}%`,
      onClick: undefined,
    },
    ready: {
      icon: <RotateCw size={16} />,
      title: "Restart to update",
      sub: update.version ? `v${update.version} ready` : "Ready",
      onClick: restartForUpdate,
    },
    error: {
      icon: <ArrowUpCircle size={16} />,
      title: "Update failed",
      sub: "Click to retry",
      onClick: checkForUpdate,
    },
  }[update.status];

  return (
    <div className="group relative">
      {/* The rail icon. A pulsing dot flags an available update; while
          downloading, a thin progress arc lives at the icon's foot. */}
      <button
        type="button"
        disabled={busy}
        onClick={config.onClick}
        aria-label={config.title}
        className="icon-btn relative h-8 w-8 overflow-hidden disabled:cursor-default"
        data-active={update.status === "available" || update.status === "ready"}
      >
        {config.icon}
        {update.status === "available" && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text)] ring-2 ring-[var(--color-panel)]" />
        )}
        {busy && (
          <span
            className="absolute inset-x-0 bottom-0 h-0.5 transition-[width] duration-200"
            style={{ width: `${pct}%`, background: "var(--color-text)" }}
          />
        )}
      </button>

      {/* Hover popover — the full dialog, revealed to the right of the rail.
          The pl-2 wrapper is a hover bridge (abuts the icon, no dead gap), so
          the mouse can travel from icon to card without the popover flickering.
          pointer-events flip on so links/buttons inside are clickable. */}
      <div className="pointer-events-none absolute bottom-0 left-full z-50 pl-2 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <div className="surface animate-scale-in w-64 p-3">
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-7 w-7 flex-none place-items-center rounded-[8px] text-[var(--color-text)]"
              style={{ background: "var(--color-accent-soft)" }}
            >
              {config.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold text-[var(--color-text)]">
                {config.title}
              </span>
              <span className="nums block truncate text-xs text-[var(--color-muted)]">
                {config.sub}
              </span>
            </span>
          </div>

          {busy && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
              <div
                className="h-full transition-[width] duration-200"
                style={{ width: `${pct}%`, background: "var(--color-text)" }}
              />
            </div>
          )}

          {update.notes && !busy && (
            <p className="mt-2.5 max-h-32 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-[var(--color-muted)]">
              {update.notes}
            </p>
          )}

          {config.onClick && (
            <button type="button" onClick={config.onClick} className="btn btn-accent mt-3 w-full">
              {config.title}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Dev-only: cycle the update lifecycle so the dialog + hover popover can be
// previewed in `tauri dev` / the Vite server, where no real update ever fires.
// Stripped from production builds (import.meta.env.DEV is false there).
function DevUpdatePreview() {
  if (!import.meta.env.DEV) return null;
  const states = ["idle", "available", "downloading", "ready", "error"] as const;
  const cycle = () => {
    const cur = useStore.getState().update.status;
    const next = states[(states.indexOf(cur) + 1) % states.length];
    useStore.setState({
      update: {
        status: next,
        version: next === "idle" ? undefined : "9.9.9",
        notes:
          next === "idle"
            ? undefined
            : "Dev preview — release notes render here.\n\n• A multi-line body\n• scrolls if it gets long\n• and wraps naturally.",
        progress: next === "downloading" ? 0.42 : next === "ready" ? 1 : 0,
      },
    });
  };
  return (
    <button
      type="button"
      onClick={cycle}
      title="Dev: cycle update state"
      className="icon-btn h-8 w-8 opacity-40 transition hover:opacity-100"
    >
      <FlaskConical size={15} />
    </button>
  );
}

export function Sidebar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const ws = useActiveWorkspace();
  const {
    workspaces,
    addWorkspace,
    closeWorkspaceWithConfirm,
    setActiveWorkspace,
    addPane,
    refreshStatus,
    revealPath,
    renameWorkspace,
    notifications,
    error,
    sidebarVisible,
    compact,
    toggleSidebar,
  } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      addWorkspace: s.addWorkspace,
      closeWorkspaceWithConfirm: s.closeWorkspaceWithConfirm,
      setActiveWorkspace: s.setActiveWorkspace,
      addPane: s.addPane,
      refreshStatus: s.refreshStatus,
      revealPath: s.revealPath,
      renameWorkspace: s.renameWorkspace,
      notifications: s.notifications,
      error: s.error,
      sidebarVisible: s.sidebarVisible,
      compact: s.compact,
      toggleSidebar: s.toggleSidebar,
    })),
  );

  // The workspace currently being renamed (its id), or null. Drives the rename
  // modal below the rail.
  const [renaming, setRenaming] = useState<string | null>(null);

  // Right-click context menu for a workspace square — shared <ContextMenu>. The
  // tear-down item prompts when an agent is running (closeWorkspaceWithConfirm),
  // and is set apart as the only destructive entry.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const workspaceMenu = (id: string): MenuItem[] => {
    const w = workspaces.find((x) => x.id === id);
    if (!w) return [];
    return [
      { kind: "header", label: w.name ?? w.repo.name },
      {
        label: "New Terminal",
        icon: <TerminalSquare size={14} />,
        onClick: () => {
          setActiveWorkspace(id);
          addPane(undefined, id);
        },
      },
      {
        label: "Rename…",
        icon: <Pencil size={14} />,
        onClick: () => setRenaming(id),
      },
      {
        label: "Refresh",
        icon: <RefreshCw size={14} />,
        onClick: () => refreshStatus(id),
      },
      {
        label: "Reveal in Finder",
        icon: <FolderOpen size={14} />,
        onClick: () => revealPath(w.repo.path),
      },
      {
        label: "Copy Path",
        icon: <Copy size={14} />,
        onClick: () => void navigator.clipboard?.writeText(w.repo.path),
      },
      { kind: "separator" },
      {
        label: "Close Project",
        icon: <X size={14} />,
        destructive: true,
        onClick: () => closeWorkspaceWithConfirm(id),
      },
    ];
  };

  // Drag the invisible handle on the panel's right edge to resize it (regular
  // mode only). Writes --panel-w straight to the DOM for a jank-free drag, then
  // persists the final width. Clamping mirrors App's panelMax().
  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const root = document.documentElement;
    const startW =
      parseFloat(getComputedStyle(root).getPropertyValue("--panel-w")) || PANEL_DEFAULT;
    const onMove = (ev: MouseEvent) => {
      const w = clampPanelWidth(startW + (ev.clientX - startX), window.innerWidth);
      root.style.setProperty("--panel-w", `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(
        "panelW",
        String(parseInt(getComputedStyle(root).getPropertyValue("--panel-w"), 10)),
      );
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      {/* Rail: workspaces on top, view nav below */}
      <div className="flex w-14 flex-none flex-col items-center gap-1.5 border-r border-[var(--color-border)] py-3">
        <div className="grid h-8 w-8 place-items-center">
          <SwarmMark />
        </div>
        <div className="divider my-1 w-7" />

        {workspaces.map((w) => (
          <WorkspaceSquare
            key={w.id}
            id={w.id}
            name={w.name ?? w.repo.name}
            onMenu={(e, id) => openMenu(e, workspaceMenu(id))}
          />
        ))}
        <button
          type="button"
          className="icon-btn h-8 w-8"
          title="Add project"
          onClick={() => pickRepo(addWorkspace)}
        >
          <Plus size={16} />
        </button>

        {ws && (
          // Inspector group — set apart from the workspaces by space, not a
          // hairline (the rail reads as two intents: switch project / inspect).
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <RailButton panel="scm" title="Source Control" badge={ws.changes.length}>
              <GitBranch size={16} />
            </RailButton>
            <RailButton panel="history" title="History">
              <History size={16} />
            </RailButton>
            <RailButton panel="prs" title="Pull Requests" badge={ws.prs.length}>
              <GitPullRequest size={16} />
            </RailButton>
            <RailButton
              panel="notifications"
              title="Notifications"
              badge={notifications.filter((n) => !n.read).length}
            >
              <Bell size={16} />
            </RailButton>
          </div>
        )}

        <div className="flex-1" />

        {/* Pinned to the rail's foot: a keyboard-shortcuts cheatsheet, the
            self-update icon (hover for the full dialog), and — in dev only — the
            preview cycler. */}
        <button
          type="button"
          className="icon-btn h-8 w-8"
          title="Keyboard shortcuts"
          onClick={onShowShortcuts}
        >
          <Keyboard size={16} />
        </button>
        <RailUpdate />
        <DevUpdatePreview />
      </div>

      {/* Scrim — only in compact mode, where the panel floats over the
          workspace. Tapping it (or anywhere outside the drawer) dismisses. */}
      {compact && sidebarVisible && (
        <div
          onClick={toggleSidebar}
          aria-hidden
          className="animate-fade-in absolute inset-y-0 left-14 right-0 z-20 bg-black/40"
        />
      )}

      {/* Panel. Regular: in-flow, flex-none, width driven by --panel-w (the
          resize handle below rewrites it). Compact: an absolute drawer over the
          workspace, fixed-width, opaque, sliding in from behind the rail. */}
      <div
        className={
          compact
            ? "animate-slide-in absolute inset-y-0 left-14 z-30 flex-col border-r border-[var(--color-border)] shadow-2xl"
            : "flex-none flex-col border-r border-[var(--color-border)]"
        }
        style={{
          display: sidebarVisible ? "flex" : "none",
          width: compact ? "min(320px, 82vw)" : "var(--panel-w)",
          background: compact ? "var(--color-panel)" : undefined,
        }}
      >
        {ws ? (
          <div key={ws.panel} className="min-h-0 flex-1 animate-fade-in">
            {ws.panel === "scm" && <SourceControlPanel />}
            {ws.panel === "prs" && <PullRequestsPanel />}
            {ws.panel === "history" && <GraphPanel />}
            {ws.panel === "notifications" && <NotificationsPanel />}
          </div>
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center">
            <div className="animate-fade-rise">
              <div className="mx-auto mb-5 grid h-14 w-14 place-items-center text-[var(--color-muted)] opacity-90">
                <SwarmMark size={40} />
              </div>
              <p className="text-md font-semibold tracking-[-0.01em] text-[var(--color-text)]">
                No project open
              </p>
              <p className="mx-auto mb-5 mt-1 max-w-[200px] text-base leading-relaxed text-[var(--color-muted)]">
                Open a git repository to start working with terminals, diffs and pull requests.
              </p>
              <button
                type="button"
                className="btn btn-accent mx-auto"
                onClick={() => pickRepo(addWorkspace)}
              >
                <Plus size={15} /> Add project
              </button>
            </div>
          </div>
        )}

        {error && (
          <div
            className="m-3 rounded-xl border p-3 text-sm"
            style={{
              borderColor: "rgba(224, 122, 114, 0.30)",
              background: "var(--color-danger-soft)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Invisible resize handle straddling the panel's right edge (regular mode
          only). Zero-width in flow so it doesn't shift the layout; the wide hit
          area overflows both ways, and a hairline brightens on hover/drag to
          hint it's grabbable. */}
      {!compact && sidebarVisible && (
        <div
          onMouseDown={startPanelResize}
          className="group relative z-10 w-0 flex-none cursor-col-resize"
          title="Drag to resize"
        >
          <div className="absolute -left-1.5 top-0 h-full w-3" />
          <div className="absolute -left-px top-0 h-full w-px bg-transparent transition-colors duration-[var(--dur-fast)] group-hover:bg-[var(--color-border-strong)]" />
        </div>
      )}

      {/* Workspace context menu (right-click a rail square) — shared surface. */}
      <ContextMenu menu={menu} onClose={closeMenu} />

      {renaming &&
        (() => {
          const w = workspaces.find((x) => x.id === renaming);
          if (!w) return null;
          return (
            <RenameWorkspaceModal
              current={w.name ?? w.repo.name}
              repoName={w.repo.name}
              onClose={() => setRenaming(null)}
              onSubmit={(name) => {
                renameWorkspace(w.id, name);
                setRenaming(null);
              }}
            />
          );
        })()}
    </>
  );
}

// Tiny rename input for a workspace's display name. Submitting an empty value (or
// the repo's own name) clears the override — the store handles that; we just pass
// the raw text through. Esc/backdrop cancels (handled by Modal).
function RenameWorkspaceModal({
  current,
  repoName,
  onClose,
  onSubmit,
}: {
  current: string;
  repoName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(current);
  return (
    <Modal onClose={onClose} labelledBy="rename-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="p-4"
      >
        <h2 id="rename-title" className="mb-1 text-md font-semibold text-[var(--color-text)]">
          Rename Project
        </h2>
        <p className="mb-3 text-sm text-[var(--color-muted)]">
          Display name only — the folder isn't touched. Leave blank to use “{repoName}”.
        </p>
        <input
          aria-labelledby="rename-title"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={repoName}
          spellCheck={false}
          className="w-full rounded-[10px] border border-[var(--color-border)] bg-[var(--color-recessed)] px-3 py-2 text-base text-[var(--color-text)] outline-none focus-visible:border-[var(--color-border-strong)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn h-9 text-base">
            Cancel
          </button>
          <button type="submit" className="btn btn-accent h-9 text-base">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
