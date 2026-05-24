// SPDX-License-Identifier: GPL-3.0-or-later
import { ExternalLink, GitPullRequest, X } from "lucide-react";
import { openExternal } from "../lib/external";
import type { PrSummary } from "../lib/types";

function checkColor(checks: string | null) {
  return checks === "passing"
    ? "var(--color-success)"
    : checks === "failing"
      ? "var(--color-danger)"
      : checks === "pending"
        ? "var(--color-warning)"
        : "var(--color-faint)";
}

export function PrView({ pr, onClose }: { pr: PrSummary; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <GitPullRequest size={15} style={{ color: checkColor(pr.checks) }} />
        <span className="text-[12.5px] text-[var(--color-muted)]">#{pr.number}</span>
        <button className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-8">
        <h1 className="text-[24px] font-bold leading-tight">{pr.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="pill pill-muted">{pr.state.toLowerCase()}</span>
          {pr.isDraft && <span className="pill pill-muted">draft</span>}
          {pr.checks && (
            <span className="pill" style={{ background: "rgba(255,255,255,0.06)", color: checkColor(pr.checks) }}>
              checks {pr.checks}
            </span>
          )}
          {pr.reviewDecision && (
            <span className="pill pill-muted">{pr.reviewDecision.toLowerCase().replace(/_/g, " ")}</span>
          )}
        </div>

        <div className="surface mt-6 p-5 text-[14px]">
          <Row label="Author" value={pr.author} />
          <div className="divider my-3" />
          <Row label="Branch" value={pr.headRef} mono />
          <div className="divider my-3" />
          <Row label="Number" value={`#${pr.number}`} />
        </div>

        <button className="btn btn-accent mt-6" onClick={() => openExternal(pr.url).catch(() => {})}>
          <ExternalLink size={15} /> Open on GitHub
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className={mono ? "font-mono text-[13px]" : ""}>{value}</span>
    </div>
  );
}
