// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState, type ReactNode } from "react";
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
  Loader2,
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
import { checkGlyph } from "../lib/checks";
import { confirmDialog } from "../lib/dialog";
import { openExternal } from "../lib/external";
import type { ChangeStatus, FileChange } from "../lib/types";

/** Best-effort clipboard write — clipboard may be denied; failure is a no-op. */
function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

// Monochrome chrome: bright neutral for adds, muted for the rest, red for
// deletes, amber for conflicts. No green outside the diff content itself.
const statusMeta: Record<ChangeStatus, { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--color-text)" },
  untracked: { letter: "U", color: "var(--color-text)" },
  modified: { letter: "M", color: "var(--color-muted)" },
  deleted: { letter: "D", color: "var(--color-danger)" },
  renamed: { letter: "R", color: "var(--color-muted)" },
  typechange: { letter: "T", color: "var(--color-muted)" },
  conflicted: { letter: "!", color: "var(--color-warning)" },
};

export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-11 flex-none items-center justify-between px-4">
      <span className="label-caps font-semibold">{title}</span>
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
      onClick: async () => {
        if (
          await confirmDialog({
            title: `Discard changes to “${f.path}”?`,
            body: "This cannot be undone.",
            confirmLabel: "Discard",
            destructive: true,
          })
        )
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
      <span className="truncate text-base">{f.path.split("/").pop()}</span>
      {dir && <span className="truncate text-xs text-[var(--color-faint)]">{dir}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            staged ? unstage(f.path) : stage(f.path);
          }}
          className="icon-btn h-6 w-6 opacity-0 transition group-hover:opacity-100"
          title={staged ? "Unstage" : "Stage"}
        >
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        <span className="w-3 text-center font-mono text-sm font-bold" style={{ color: meta.color }}>
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
  // Scoped in-flight flags for the two awaited actions, so the button shows a
  // spinner for *its own* work — `busy` is global (any git op on any workspace),
  // so keying the affordance off it would spin these for unrelated operations.
  const [committing, setCommitting] = useState(false);
  const [initing, setIniting] = useState(false);
  if (!ws) return null;

  // A plain folder (no git repo yet) — offer to initialize one. Terminals/agents
  // already work; this just turns on source control.
  if (!ws.repo.isRepo) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Source Control" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitBranch size={22} className="text-[var(--color-muted)]" />
          <p className="text-base text-[var(--color-muted)]">
            This folder isn’t a Git repository yet.
          </p>
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || initing}
            onClick={async () => {
              setIniting(true);
              try {
                await initRepo();
              } finally {
                setIniting(false);
              }
            }}
          >
            {initing ? <Loader2 size={15} className="spin" /> : <GitBranch size={15} />} Initialize
            Repository
          </button>
        </div>
      </div>
    );
  }

  const staged = ws.changes.filter((c) => c.staged);
  const unstaged = ws.changes.filter((c) => c.unstaged);

  // One commit path for both entrypoints (the button and the textarea's ⌘Enter),
  // each wrapping the spinner so the affordance shows regardless of how it fired.
  const canCommit = !busy && !committing && !!ws.commitMsg.trim() && ws.changes.length > 0;
  const doCommit = async () => {
    if (!canCommit) return;
    setCommitting(true);
    try {
      await commit();
    } finally {
      setCommitting(false);
    }
  };

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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit();
          }}
        />
        <button
          type="button"
          className="btn btn-accent mt-2 w-full"
          disabled={!canCommit}
          onClick={doCommit}
        >
          {committing ? <Loader2 size={15} className="spin" /> : <GitCommitHorizontal size={15} />}{" "}
          Commit
          {staged.length ? ` ${staged.length} staged` : " all"}
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {staged.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 py-1.5">
              <span className="label-caps font-semibold">Staged ({staged.length})</span>
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
          <span className="label-caps font-semibold">Changes ({unstaged.length})</span>
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
          <p className="flex items-center gap-2 px-1 py-4 text-base text-[var(--color-muted)]">
            <Check size={14} /> No local changes
          </p>
        )}
      </div>
    </div>
  );
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
  // Memoize the split so .filter() doesn't allocate new arrays each render —
  // downstream components key off referential identity.
  const prs = ws?.prs;
  const ghLogin = ws?.ghLogin;
  const { mine, others } = useMemo(() => {
    if (!prs) return { mine: [], others: [] };
    return {
      mine: prs.filter((p) => ghLogin && p.author === ghLogin),
      others: prs.filter((p) => !ghLogin || p.author !== ghLogin),
    };
  }, [prs, ghLogin]);
  if (!ws) return null;

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

  const Row = (p: (typeof ws.prs)[number]) => {
    const glyph = checkGlyph(p.checks);
    const Glyph = glyph.Icon;
    return (
      <div
        key={p.number}
        data-active={ws.editor.type === "pr" && ws.editor.pr.number === p.number}
        onClick={() => openPr(p)}
        onContextMenu={(e) => openMenu(e, prMenu(p))}
        className="row mb-1.5 flex cursor-pointer items-start gap-2.5 px-3 py-2.5"
      >
        <span className="mt-0.5 flex-none" title={glyph.label}>
          <Glyph size={15} role="img" aria-label={glyph.label} style={{ color: glyph.color }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">{p.title}</span>
          <span className="nums mt-0.5 block truncate text-xs text-[var(--color-muted)]">
            #{p.number} · {p.author} · {p.headRef}
          </span>
        </span>
        {p.isDraft && <span className="pill pill-muted h-5 px-2 text-2xs">draft</span>}
      </div>
    );
  };

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
          <p className="px-1 py-4 text-base text-[var(--color-muted)]">
            GitHub CLI (<code>gh</code>) not found. Install it and run <code>gh auth login</code>.
          </p>
        ) : !ws.repo.isRepo ? (
          <p className="px-1 py-4 text-base text-[var(--color-muted)]">
            Not a git repository yet. Initialize it from the Changes panel, then push to GitHub.
          </p>
        ) : !ws.repo.originUrl ? (
          <p className="px-1 py-4 text-base text-[var(--color-muted)]">
            No GitHub remote yet. Run <code>gh repo create</code> in a terminal to publish — the
            panel updates automatically when an <code>origin</code> appears.
          </p>
        ) : ws.prs.length === 0 ? (
          <p className="px-1 py-4 text-base text-[var(--color-muted)]">No open pull requests.</p>
        ) : (
          <>
            {mine.length > 0 && (
              <>
                <p className="px-1 py-1.5 label-caps font-semibold">Created by me</p>
                {mine.map(Row)}
              </>
            )}
            <p className="px-1 py-1.5 label-caps font-semibold">
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
          <p className="flex items-center gap-2 px-1 py-4 text-base text-[var(--color-muted)]">
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
                <span className="flex-1 truncate text-base font-medium">{n.title}</span>
                {n.source === "terminal" && (
                  // Untrusted origin: this text came from a program in the
                  // terminal, so mark it plainly and never act on its content.
                  <span
                    className="flex-none rounded px-1.5 py-0.5 text-2xs uppercase tracking-wide text-[var(--color-faint)]"
                    style={{ background: "rgba(255,255,255,0.06)" }}
                    title="Reported by a program running in the terminal"
                  >
                    terminal
                  </span>
                )}
                <span className="nums text-xs text-[var(--color-faint)]">
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
                <span className="truncate pl-4 text-sm text-[var(--color-muted)]">{n.body}</span>
              )}
            </div>
          ))
        )}
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
