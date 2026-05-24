// SPDX-License-Identifier: GPL-3.0-or-later
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Check, CircleDot, ExternalLink, FileText, GitPullRequest, X } from "lucide-react";
import { api } from "../lib/ipc";
import { openExternal } from "../lib/external";
import type { PrDetail, PrSummary } from "../lib/types";

// The markdown renderer (react-markdown + remark/rehype) is heavy and only used
// here — split it into its own chunk, loaded the first time a PR body renders.
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

function checkColor(checks: string | null) {
  return checks === "passing"
    ? "var(--color-success)"
    : checks === "failing"
      ? "var(--color-danger)"
      : checks === "pending"
        ? "var(--color-warning)"
        : "var(--color-faint)";
}

function reviewColor(decision: string | null) {
  return decision === "APPROVED"
    ? "var(--color-success)"
    : decision === "CHANGES_REQUESTED"
      ? "var(--color-danger)"
      : "var(--color-muted)";
}

export function PrView({
  repoPath,
  pr,
  onClose,
}: {
  repoPath: string;
  pr: PrSummary;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PrDetail | null>(null);
  useEffect(() => {
    setDetail(null);
    api.prDetail(repoPath, pr.number).then(setDetail).catch(() => setDetail(null));
  }, [repoPath, pr.number]);

  const checks = pr.checks ? `Checks ${pr.checks}` : "No checks";
  const review = pr.reviewDecision
    ? pr.reviewDecision.toLowerCase().replace(/_/g, " ")
    : "No review yet";

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-[var(--color-border)] px-4">
        <GitPullRequest size={15} style={{ color: checkColor(pr.checks) }} />
        <span className="nums text-[12.5px] text-[var(--color-muted)]">#{pr.number}</span>
        <button className="icon-btn ml-auto h-7 w-7" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="animate-fade-rise mx-auto w-full max-w-2xl px-5 py-8 md:px-8 md:py-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill pill-muted">{pr.state.toLowerCase()}</span>
            {pr.isDraft && <span className="pill pill-muted">draft</span>}
          </div>

          <h1 className="selectable mt-3 text-[26px] font-bold leading-tight tracking-[-0.02em]">
            {pr.title}
          </h1>
          <p className="mt-2.5 text-[13px] text-[var(--color-muted)]">
            <span className="text-[var(--color-text)]">{pr.author}</span> wants to merge{" "}
            <code className="selectable rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-text)]">
              {pr.headRef}
            </code>
          </p>

          <div className="surface mt-7 divide-y divide-[var(--color-border)] px-5">
            <StatusRow
              icon={<CircleDot size={15} style={{ color: checkColor(pr.checks) }} />}
              label="Checks"
              value={checks}
              tone={checkColor(pr.checks)}
            />
            <StatusRow
              icon={<Check size={15} style={{ color: reviewColor(pr.reviewDecision) }} />}
              label="Review"
              value={review}
              tone={reviewColor(pr.reviewDecision)}
            />
          </div>

          {detail && detail.body.trim() && (
            <section className="mt-8">
              <SectionLabel>Description</SectionLabel>
              <div className="mt-3">
                <Suspense
                  fallback={<p className="text-[13px] text-[var(--color-faint)]">Rendering…</p>}
                >
                  <Markdown>{detail.body.trim()}</Markdown>
                </Suspense>
              </div>
            </section>
          )}

          {detail && detail.files.length > 0 && (
            <section className="mt-8">
              <SectionLabel>
                {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
                <span className="nums ml-2 font-mono text-[11px]">
                  <span style={{ color: "var(--color-success)" }}>+{detail.additions}</span>{" "}
                  <span style={{ color: "var(--color-danger)" }}>−{detail.deletions}</span>
                </span>
              </SectionLabel>
              <div className="surface mt-2 divide-y divide-[var(--color-border)] overflow-hidden">
                {detail.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                    <FileText size={14} className="flex-none text-[var(--color-faint)]" />
                    <span className="selectable min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {f.path}
                    </span>
                    <span className="nums flex-none font-mono text-[11px]">
                      <span style={{ color: "var(--color-success)" }}>+{f.additions}</span>{" "}
                      <span style={{ color: "var(--color-danger)" }}>−{f.deletions}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <button
            className="btn btn-accent mt-8"
            onClick={() => openExternal(pr.url).catch(() => {})}
          >
            <ExternalLink size={15} /> Open on GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
      {children}
    </p>
  );
}

function StatusRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <span className="flex-none">{icon}</span>
      <span className="w-20 flex-none text-[13px] text-[var(--color-muted)]">{label}</span>
      <span className="flex-1 text-[13px] capitalize" style={{ color: tone }}>
        {value}
      </span>
    </div>
  );
}
