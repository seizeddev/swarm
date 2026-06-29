// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { Check, FileCode2, Loader2, Plus, Trash2, X } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/ipc";
import { lineDiff } from "../lib/diff";
import type { IntegrationPreview, IntegrationStatus } from "../lib/types";

/**
 * Agent Integrations — a transparent, manual control surface for the hooks swarm
 * installs into agents' real configs (so even a shell-typed agent gets captured;
 * see CLAUDE.md). The best-effort silent install still runs on launch; this modal
 * just makes it visible and reversible: per-agent status, a real before→after
 * diff of the config file, and Apply / Remove buttons that never clobber unrelated
 * hooks (the Rust side strips only swarm's `--notify-helper` entries).
 */
export function AgentIntegrations({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<IntegrationStatus[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<IntegrationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await api.agentIntegrationsStatus();
      setRows(status);
      return status;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRows([]);
      return [];
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load the diff whenever the selected agent (or its installed state) changes.
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .agentIntegrationPreview(selected)
      .then((p) => !cancelled && setPreview(p))
      .catch((e: any) => !cancelled && setError(e?.message ?? String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected, rows]);

  const act = async (agent: string, apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (apply) await api.agentIntegrationApply(agent);
      else await api.agentIntegrationRemove(agent);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="integrations-title">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <h2
          id="integrations-title"
          className="text-md font-semibold tracking-[-0.01em] text-[var(--color-text)]"
        >
          Agent Integrations
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--color-muted)]">
          swarm installs a small hook into each agent's config so turn-completion notifications and
          session restore work — even for an agent you start by hand in a shell. Review and toggle
          each one here.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {rows === null ? (
          <p className="flex items-center gap-2 px-1 py-6 text-base text-[var(--color-muted)]">
            <Loader2 size={14} className="spin" /> Loading…
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.id} className="surface overflow-hidden">
                <button
                  type="button"
                  onClick={() => setSelected((s) => (s === r.id ? null : r.id))}
                  aria-expanded={selected === r.id}
                  aria-controls={`agent-int-panel-${r.id}`}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--tint-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
                >
                  <span className="flex-1 truncate text-base font-medium text-[var(--color-text)]">
                    {r.name}
                  </span>
                  <StatusBadge row={r} />
                </button>

                {selected === r.id && (
                  <div
                    id={`agent-int-panel-${r.id}`}
                    className="border-t border-[var(--color-border)] p-3"
                  >
                    {!r.onPath && (
                      <p className="mb-2 text-sm text-[var(--color-muted)]">
                        Not found on your PATH — the hook is harmless if installed, but the agent
                        isn't available to launch.
                      </p>
                    )}
                    <p
                      className="mb-2 truncate text-sm text-[var(--color-muted)]"
                      title={r.configPath}
                    >
                      {r.isPlugin ? "Plugin file: " : "Config: "}
                      {r.configPath}
                    </p>

                    <DiffView preview={selected === r.id ? preview : null} row={r} />

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act(r.id, true)}
                        className="btn btn-accent h-8 flex-1 text-base"
                      >
                        {busy ? (
                          <Loader2 size={13} className="spin" />
                        ) : r.isPlugin ? (
                          <FileCode2 size={13} />
                        ) : (
                          <Plus size={13} />
                        )}
                        {r.installed ? "Re-apply" : r.isPlugin ? "Create file" : "Apply"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !r.installed}
                        onClick={() => act(r.id, false)}
                        className="btn h-8 flex-1 text-base"
                        style={r.installed ? { color: "var(--color-danger)" } : undefined}
                      >
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            className="mt-2 flex items-start gap-2 rounded-xl border p-2.5 text-sm"
            style={{
              borderColor: "var(--color-danger-border)",
              background: "var(--color-danger-soft)",
              color: "var(--color-danger-text)",
            }}
          >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
              className="icon-btn h-5 w-5 flex-none"
              style={{ color: "var(--color-danger)" }}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function StatusBadge({ row }: { row: IntegrationStatus }) {
  if (row.installed) {
    return (
      <span
        className="pill-sm flex-none"
        style={{ background: "var(--color-success-soft)", color: "var(--color-success)" }}
      >
        <Check size={11} /> Installed
      </span>
    );
  }
  // ring-1 sets box-shadow, overriding pill-sm's top-sheen — so this reads as a
  // hairline-outlined chip. Muted (not faint) text for AA on the surface.
  return (
    <span
      className="pill-sm flex-none ring-1 ring-inset ring-[var(--color-border)]"
      style={{ background: "transparent", color: "var(--color-muted)" }}
    >
      {row.onPath ? "Not installed" : "Not on PATH"}
    </span>
  );
}

// The before→after diff for the action the user is most likely to take: if it's
// installed, show what Remove would do; otherwise what Apply would do.
function DiffView({
  preview,
  row,
}: {
  preview: IntegrationPreview | null;
  row: IntegrationStatus;
}) {
  if (!preview) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Loader2 size={13} className="spin" /> Loading diff…
      </p>
    );
  }
  const after = row.installed ? preview.removed : preview.applied;
  const lines = lineDiff(preview.current, after);
  const changed = lines.some((l) => l.kind !== "ctx");
  if (!changed) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        {row.installed
          ? "swarm's hook is present; removing it makes no other change."
          : "No change — already up to date."}
      </p>
    );
  }
  return (
    <pre className="max-h-56 overflow-auto rounded-lg bg-[var(--color-recessed)] p-2.5 text-sm leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={i}
          className="whitespace-pre-wrap break-all"
          style={{
            color:
              l.kind === "add"
                ? "var(--color-success)"
                : l.kind === "del"
                  ? "var(--color-danger)"
                  : "var(--color-muted)",
            background:
              l.kind === "add"
                ? "var(--color-success-soft)"
                : l.kind === "del"
                  ? "var(--color-danger-soft)"
                  : undefined,
          }}
        >
          <span className="select-none opacity-60">
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
          </span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}
