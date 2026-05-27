// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from "react";
import {
  Bell,
  Check,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useActiveWorkspace, useStore } from "../store";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "../lib/menu";
import { openExternal } from "../lib/external";
import type { ChangeStatus, FileChange } from "../lib/types";

/** Best-effort clipboard write — clipboard may be denied; failure is a no-op. */
function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

// Monochrome chrome: bright neutral for adds, muted for the rest, red for
// deletes, amber for conflicts. No green outside the diff content itself.
const statusMeta: Record<ChangeStatus, { letter: string; color: string }> = {
  added: { letter: "A", color: "#c9c6c0" },
  untracked: { letter: "U", color: "#c9c6c0" },
  modified: { letter: "M", color: "var(--color-muted)" },
  deleted: { letter: "D", color: "var(--color-danger)" },
  renamed: { letter: "R", color: "var(--color-muted)" },
  typechange: { letter: "T", color: "var(--color-muted)" },
  conflicted: { letter: "!", color: "var(--color-warning)" },
};

function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-11 flex-none items-center justify-between px-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {title}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function FileRow({ f, staged }: { f: FileChange; staged: boolean }) {
  const ws = useActiveWorkspace();
  const { openDiff, stage, unstage, discardFiles, revealPath } = useStore(
    useShallow((s) => ({
      openDiff: s.openDiff,
      stage: s.stage,
      unstage: s.unstage,
      discardFiles: s.discardFiles,
      revealPath: s.revealPath,
    })),
  );
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const meta = statusMeta[f.status];
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  const active =
    ws?.editor.type === "diff" && ws.editor.file === f.path && ws.editor.staged === staged;

  // Absolute path for reveal/copy — repo.path is the canonical workdir.
  const abs = ws ? `${ws.repo.path}/${f.path}` : f.path;
  const items: MenuItem[] = [
    { kind: "header", label: f.path.split("/").pop() ?? f.path },
    { label: "Open Diff", icon: <FileText size={14} />, onClick: () => openDiff(f.path, staged) },
    staged
      ? { label: "Unstage", icon: <Minus size={14} />, onClick: () => unstage(f.path) }
      : { label: "Stage", icon: <Plus size={14} />, onClick: () => stage(f.path) },
    {
      label: "Discard Changes",
      icon: <Undo2 size={14} />,
      destructive: true,
      onClick: () => {
        if (globalThis.confirm(`Discard changes to “${f.path}”?\n\nThis cannot be undone.`))
          discardFiles([f.path]);
      },
    },
    { kind: "separator" },
    { label: "Reveal in Finder", icon: <FolderOpen size={14} />, onClick: () => revealPath(abs) },
    { label: "Copy Path", icon: <Copy size={14} />, onClick: () => copy(abs) },
    { label: "Copy Relative Path", icon: <Copy size={14} />, onClick: () => copy(f.path) },
  ];

  return (
    <div
      data-active={active}
      onClick={() => openDiff(f.path, staged)}
      onContextMenu={(e) => openMenu(e, items)}
      className="group row cv-row mb-1 flex cursor-pointer items-center gap-2 px-2.5 py-1.5"
    >
      <span className="truncate text-[13px]">{f.path.split("/").pop()}</span>
      {dir && <span className="truncate text-[11px] text-[var(--color-faint)]">{dir}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            staged ? unstage(f.path) : stage(f.path);
          }}
          className="icon-btn h-5 w-5 opacity-0 transition group-hover:opacity-100"
          title={staged ? "Unstage" : "Stage"}
        >
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        <span
          className="w-3 text-center font-mono text-[12px] font-bold"
          style={{ color: meta.color }}
        >
          {meta.letter}
        </span>
      </span>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}

export function SourceControlPanel() {
  const ws = useActiveWorkspace();
  const { setCommitMsg, commit, stageAll, unstageAll, refreshStatus, initRepo, busy } = useStore(
    useShallow((s) => ({
      setCommitMsg: s.setCommitMsg,
      commit: s.commit,
      stageAll: s.stageAll,
      unstageAll: s.unstageAll,
      refreshStatus: s.refreshStatus,
      initRepo: s.initRepo,
      busy: s.busy,
    })),
  );
  if (!ws) return null;

  // A plain folder (no git repo yet) — offer to initialize one. Terminals/agents
  // already work; this just turns on source control.
  if (!ws.repo.isRepo) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Source Control" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitBranch size={22} className="text-[var(--color-muted)]" />
          <p className="text-[13px] text-[var(--color-muted)]">
            This folder isn’t a Git repository yet.
          </p>
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => initRepo()}
          >
            <GitBranch size={15} /> Initialize Repository
          </button>
        </div>
      </div>
    );
  }

  const staged = ws.changes.filter((c) => c.staged);
  const unstaged = ws.changes.filter((c) => c.unstaged);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Source Control">
        <button
          type="button"
          className="icon-btn h-7 w-7"
          title="Refresh"
          onClick={() => refreshStatus()}
        >
          <RefreshCw size={14} />
        </button>
      </PanelHeader>

      <div className="px-3">
        <textarea
          aria-label="Commit message"
          className="field h-[68px] resize-none"
          placeholder="Message (⌘Enter to commit)"
          value={ws.commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        <button
          type="button"
          className="btn btn-accent mt-2 w-full"
          disabled={busy || !ws.commitMsg.trim() || ws.changes.length === 0}
          onClick={() => commit()}
        >
          <GitCommitHorizontal size={15} /> Commit
          {staged.length ? ` ${staged.length} staged` : " all"}
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {staged.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Staged ({staged.length})
              </span>
              <button
                type="button"
                className="icon-btn h-6 w-6"
                title="Unstage all"
                onClick={() => unstageAll()}
              >
                <Minus size={13} />
              </button>
            </div>
            {staged.map((f) => (
              <FileRow key={"s-" + f.path} f={f} staged />
            ))}
          </>
        )}

        <div className="flex items-center justify-between px-1 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Changes ({unstaged.length})
          </span>
          {unstaged.length > 0 && (
            <button
              type="button"
              className="icon-btn h-6 w-6"
              title="Stage all"
              onClick={() => stageAll()}
            >
              <Plus size={13} />
            </button>
          )}
        </div>
        {unstaged.map((f) => (
          <FileRow key={"u-" + f.path} f={f} staged={false} />
        ))}

        {ws.changes.length === 0 && (
          <p className="flex items-center gap-2 px-1 py-4 text-[13px] text-[var(--color-muted)]">
            <Check size={14} /> No local changes
          </p>
        )}
      </div>
    </div>
  );
}

function checkColor(checks: string | null) {
  return checks === "failing"
    ? "var(--color-danger)"
    : checks === "pending"
      ? "var(--color-warning)"
      : "var(--color-muted)"; // passing/none stay neutral — monochrome chrome
}

export function PullRequestsPanel() {
  const ws = useActiveWorkspace();
  const { ghAvailable, openPr, loadPrs, prCheckout } = useStore(
    useShallow((s) => ({
      ghAvailable: s.ghAvailable,
      openPr: s.openPr,
      loadPrs: s.loadPrs,
      prCheckout: s.prCheckout,
    })),
  );
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  if (!ws) return null;
  const mine = ws.prs.filter((p) => ws.ghLogin && p.author === ws.ghLogin);
  const others = ws.prs.filter((p) => !ws.ghLogin || p.author !== ws.ghLogin);

  const prMenu = (p: (typeof ws.prs)[number]): MenuItem[] => [
    { kind: "header", label: `#${p.number}` },
    { label: "Open", icon: <GitPullRequest size={14} />, onClick: () => openPr(p) },
    { label: "Checkout Branch", icon: <GitBranch size={14} />, onClick: () => prCheckout(p) },
    { kind: "separator" },
    {
      label: "Open on GitHub",
      icon: <ExternalLink size={14} />,
      onClick: () => void openExternal(p.url).catch(() => {}),
    },
    { label: "Copy PR URL", icon: <Copy size={14} />, onClick: () => copy(p.url) },
    { label: "Copy Branch Name", icon: <Copy size={14} />, onClick: () => copy(p.headRef) },
    { label: "Copy Number", icon: <Copy size={14} />, onClick: () => copy(`#${p.number}`) },
  ];

  const Row = (p: (typeof ws.prs)[number]) => (
    <div
      key={p.number}
      data-active={ws.editor.type === "pr" && ws.editor.pr.number === p.number}
      onClick={() => openPr(p)}
      onContextMenu={(e) => openMenu(e, prMenu(p))}
      className="row mb-1.5 flex cursor-pointer items-start gap-2.5 px-3 py-2.5"
    >
      <GitPullRequest
        size={15}
        className="mt-0.5 flex-none"
        style={{ color: checkColor(p.checks) }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{p.title}</span>
        <span className="nums mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
          #{p.number} · {p.author} · {p.headRef}
        </span>
      </span>
      {p.isDraft && <span className="pill pill-muted h-5 px-2 text-[10px]">draft</span>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Pull Requests">
        <button
          type="button"
          className="icon-btn h-7 w-7"
          title="Refresh"
          onClick={() => loadPrs(undefined, true)}
        >
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!ghAvailable ? (
          <p className="px-1 py-4 text-[13px] text-[var(--color-muted)]">
            GitHub CLI (<code>gh</code>) not found. Install it and run <code>gh auth login</code>.
          </p>
        ) : ws.prs.length === 0 ? (
          <p className="px-1 py-4 text-[13px] text-[var(--color-muted)]">No open pull requests.</p>
        ) : (
          <>
            {mine.length > 0 && (
              <>
                <p className="px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Created by me
                </p>
                {mine.map(Row)}
              </>
            )}
            <p className="px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {mine.length ? "All open" : "Open"}
            </p>
            {others.map(Row)}
          </>
        )}
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}

export function NotificationsPanel() {
  const notifications = useStore((s) => s.notifications);
  const {
    selectPane,
    setActiveWorkspace,
    clearNotifications,
    dismissNotification,
    setNotificationRead,
  } = useStore(
    useShallow((s) => ({
      selectPane: s.selectPane,
      setActiveWorkspace: s.setActiveWorkspace,
      clearNotifications: s.clearNotifications,
      dismissNotification: s.dismissNotification,
      setNotificationRead: s.setNotificationRead,
    })),
  );
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const goToPane = (n: (typeof notifications)[number]) => {
    setActiveWorkspace(n.workspaceId);
    selectPane(n.paneId);
  };
  const notifMenu = (n: (typeof notifications)[number]): MenuItem[] => [
    { kind: "header", label: n.title },
    { label: "Go to Pane", icon: <Eye size={14} />, onClick: () => goToPane(n) },
    {
      label: n.read ? "Mark as Unread" : "Mark as Read",
      icon: <Check size={14} />,
      onClick: () => setNotificationRead(n.id, !n.read),
    },
    {
      label: "Copy Message",
      icon: <Copy size={14} />,
      onClick: () => copy([n.title, n.body].filter(Boolean).join("\n")),
    },
    { kind: "separator" },
    {
      label: "Dismiss",
      icon: <X size={14} />,
      destructive: true,
      onClick: () => dismissNotification(n.id),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Notifications">
        {notifications.length > 0 && (
          <button
            type="button"
            className="icon-btn h-7 w-7"
            title="Clear all"
            onClick={() => clearNotifications()}
          >
            <Trash2 size={14} />
          </button>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {notifications.length === 0 ? (
          <p className="flex items-center gap-2 px-1 py-4 text-[13px] text-[var(--color-muted)]">
            <Bell size={14} /> No notifications
          </p>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              onClick={() => {
                // Navigate to the source terminal (selectPane restores the
                // terminal editor even if you're on a PR/diff) and mark it read
                // — but keep it in the history list rather than dismissing it.
                goToPane(n);
              }}
              onContextMenu={(e) => openMenu(e, notifMenu(n))}
              // Read entries stay in the list but recede — the unread ones carry
              // the solid leading dot and full contrast.
              style={{ opacity: n.read ? 0.55 : 1 }}
              className="group row animate-fade-rise mb-1.5 flex cursor-pointer flex-col gap-0.5 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={
                    n.read
                      ? { boxShadow: "inset 0 0 0 1px var(--color-faint)" }
                      : { background: "var(--color-text)" }
                  }
                />
                <span className="flex-1 truncate text-[13px] font-medium">{n.title}</span>
                {n.source === "terminal" && (
                  // Untrusted origin: this text came from a program in the
                  // terminal, so mark it plainly and never act on its content.
                  <span
                    className="flex-none rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-faint)]"
                    style={{ background: "rgba(255,255,255,0.06)" }}
                    title="Reported by a program running in the terminal"
                  >
                    terminal
                  </span>
                )}
                <span className="nums text-[11px] text-[var(--color-faint)]">
                  {new Date(n.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissNotification(n.id);
                  }}
                  title="Remove from history"
                  className="icon-btn h-5 w-5 flex-none opacity-0 transition group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
              {n.body && (
                <span className="truncate pl-4 text-[12px] text-[var(--color-muted)]">
                  {n.body}
                </span>
              )}
            </div>
          ))
        )}
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
