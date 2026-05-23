import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  GitCommitHorizontal,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useActiveWorkspace, useStore } from "../store";
import { leaves } from "../lib/layout";
import type { AgentDef, ChangeStatus, FileChange } from "../lib/types";

const ATTN = "#6b9bff"; // attention signal (blue), the one status colour we allow here

// Monochrome chrome: bright neutral for adds, muted for the rest, red for
// deletes, amber for conflicts. No green outside the diff content itself.
const statusMeta: Record<ChangeStatus, { letter: string; color: string }> = {
  added: { letter: "A", color: "#c9c9cf" },
  untracked: { letter: "U", color: "#c9c9cf" },
  modified: { letter: "M", color: "var(--color-muted)" },
  deleted: { letter: "D", color: "#ff6b6b" },
  renamed: { letter: "R", color: "var(--color-muted)" },
  typechange: { letter: "T", color: "var(--color-muted)" },
  conflicted: { letter: "!", color: "#e8c474" },
};

function AgentMenu() {
  const { agents, addPane } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button className="icon-btn h-7 w-7" title="New terminal" onClick={() => setOpen((v) => !v)}>
        <Plus size={15} />
      </button>
      {open && (
        <div className="surface absolute right-0 top-9 z-50 w-52 p-1.5">
          <p className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-[var(--color-faint)]">
            Spawn
          </p>
          {agents.map((a: AgentDef) => (
            <button
              key={a.id}
              onClick={() => {
                addPane(a);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-white/5"
            >
              <span
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: a.installed ? a.accent : "var(--color-faint)" }}
              />
              <span className="flex-1">{a.name}</span>
              {!a.installed && <span className="text-[10px] text-[var(--color-faint)]">missing</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-11 flex-none items-center justify-between px-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {title}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function TerminalsPanel() {
  const ws = useActiveWorkspace();
  const allPanes = useStore((s) => s.panes);
  const { selectTab, removePane } = useStore();
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Terminals">
        <AgentMenu />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {ws?.tabs.map((t) => {
          const ids = leaves(t.layout);
          const head =
            allPanes.find((p) => p.paneId === t.activeLeaf) ??
            allPanes.find((p) => p.paneId === ids[0]);
          const attn = allPanes.some((p) => ids.includes(p.paneId) && p.attention);
          const active = ws.activeTab === t.id && ws.editor.type === "terminal";
          return (
            <div
              key={t.id}
              data-active={active}
              onClick={() => selectTab(t.id)}
              className="group row mb-1.5 flex cursor-pointer items-center gap-2.5 px-3 py-2.5"
            >
              <TerminalSquare size={15} className="text-[var(--color-muted)]" />
              <span className="flex-1 truncate text-[13px]">{head?.title ?? "Shell"}</span>
              {ids.length > 1 && (
                <span className="text-[11px] text-[var(--color-faint)]">{ids.length}</span>
              )}
              {attn && <span className="h-2 w-2 flex-none rounded-full" style={{ background: ATTN }} />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  ids.forEach((id) => removePane(id));
                }}
                className="opacity-0 transition group-hover:opacity-100"
              >
                <X size={13} className="text-[var(--color-muted)] hover:text-[var(--color-text)]" />
              </button>
            </div>
          );
        })}
        {!ws?.tabs.length && (
          <p className="px-3 py-4 text-[13px] text-[var(--color-muted)]">No terminals yet.</p>
        )}
      </div>
    </div>
  );
}

function FileRow({ f, staged }: { f: FileChange; staged: boolean }) {
  const ws = useActiveWorkspace();
  const { openDiff, stage, unstage } = useStore();
  const meta = statusMeta[f.status];
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  const active = ws?.editor.type === "diff" && ws.editor.file === f.path && ws.editor.staged === staged;
  return (
    <div
      data-active={active}
      onClick={() => openDiff(f.path, staged)}
      className="group row mb-1 flex cursor-pointer items-center gap-2 px-2.5 py-1.5"
    >
      <span className="truncate text-[13px]">{f.path.split("/").pop()}</span>
      {dir && <span className="truncate text-[11px] text-[var(--color-faint)]">{dir}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            staged ? unstage(f.path) : stage(f.path);
          }}
          className="opacity-0 transition group-hover:opacity-100"
          title={staged ? "Unstage" : "Stage"}
        >
          {staged ? (
            <Minus size={14} className="text-[var(--color-muted)] hover:text-[var(--color-text)]" />
          ) : (
            <Plus size={14} className="text-[var(--color-muted)] hover:text-[var(--color-text)]" />
          )}
        </button>
        <span className="w-3 text-center font-mono text-[12px] font-bold" style={{ color: meta.color }}>
          {meta.letter}
        </span>
      </span>
    </div>
  );
}

export function SourceControlPanel() {
  const ws = useActiveWorkspace();
  const { setCommitMsg, commit, stageAll, unstageAll, refreshStatus, busy } = useStore();
  if (!ws) return null;
  const staged = ws.changes.filter((c) => c.staged);
  const unstaged = ws.changes.filter((c) => c.unstaged);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={ws.repo.headBranch ? `⎇ ${ws.repo.headBranch}` : "Source Control"}>
        <button className="icon-btn h-7 w-7" title="Refresh" onClick={() => refreshStatus()}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>

      <div className="px-3">
        <textarea
          className="field h-[68px] resize-none"
          placeholder="Message (⌘Enter to commit)"
          value={ws.commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        <button
          className="btn btn-accent mt-2 w-full"
          disabled={busy || !ws.commitMsg.trim() || ws.changes.length === 0}
          onClick={() => commit()}
        >
          <GitCommitHorizontal size={15} /> Commit{staged.length ? ` ${staged.length} staged` : " all"}
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {staged.length > 0 && (
          <>
            <div className="flex items-center justify-between px-1 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                Staged ({staged.length})
              </span>
              <button className="icon-btn h-6 w-6" title="Unstage all" onClick={() => unstageAll()}>
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
            <button className="icon-btn h-6 w-6" title="Stage all" onClick={() => stageAll()}>
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
    ? "#ff6b6b"
    : checks === "pending"
      ? "#e8c474"
      : "var(--color-muted)"; // passing/none stay neutral — monochrome chrome
}

export function PullRequestsPanel() {
  const ws = useActiveWorkspace();
  const { ghAvailable, openPr, loadPrs } = useStore();
  if (!ws) return null;
  const mine = ws.prs.filter((p) => ws.ghLogin && p.author === ws.ghLogin);
  const others = ws.prs.filter((p) => !ws.ghLogin || p.author !== ws.ghLogin);

  const Row = (p: (typeof ws.prs)[number]) => (
    <div
      key={p.number}
      data-active={ws.editor.type === "pr" && ws.editor.pr.number === p.number}
      onClick={() => openPr(p)}
      className="row mb-1.5 flex cursor-pointer items-start gap-2.5 px-3 py-2.5"
    >
      <GitPullRequest size={15} className="mt-0.5 flex-none" style={{ color: checkColor(p.checks) }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{p.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--color-muted)]">
          #{p.number} · {p.author} · {p.headRef}
        </span>
      </span>
      {p.isDraft && <span className="pill pill-muted h-5 px-2 text-[10px]">draft</span>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Pull Requests">
        <button className="icon-btn h-7 w-7" title="Refresh" onClick={() => loadPrs()}>
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
    </div>
  );
}

export function NotificationsPanel() {
  const notifications = useStore((s) => s.notifications);
  const { selectPane, setActiveWorkspace, clearNotifications, dismissNotification, setPanel } =
    useStore();
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Notifications">
        {notifications.length > 0 && (
          <button className="icon-btn h-7 w-7" title="Clear all" onClick={() => clearNotifications()}>
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
                setActiveWorkspace(n.workspaceId);
                selectPane(n.paneId);
                setPanel("terminals");
                dismissNotification(n.id);
              }}
              className="row mb-1.5 flex cursor-pointer flex-col gap-0.5 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: ATTN }} />
                <span className="flex-1 truncate text-[13px] font-medium">{n.title}</span>
                <span className="text-[11px] text-[var(--color-faint)]">
                  {new Date(n.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {n.body && (
                <span className="truncate pl-4 text-[12px] text-[var(--color-muted)]">{n.body}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
