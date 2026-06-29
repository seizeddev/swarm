// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert } from "lucide-react";
import { useToastStore, type Toast } from "../lib/toast";

// How long a toast rests before it animates out, and the exit animation's length.
const REST_MS = 2600;
const EXIT_MS = 180;

// Status hue only on the leading icon (the surface stays monochrome): sage for a
// success, the AA-safe clay for an error, neutral muted for a plain confirmation.
const TONE: Record<Toast["kind"], { color: string; Icon: typeof Check }> = {
  success: { color: "var(--color-success)", Icon: Check },
  info: { color: "var(--color-muted)", Icon: Check },
  error: { color: "var(--color-danger-text)", Icon: CircleAlert },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  // enter (off-position, transparent) → shown (animated into place) → leave
  // (animated out) → removed. A pure transition (not the fade-rise keyframe) so
  // the same property can drive both directions; prefers-reduced-motion collapses
  // both to ~instant via the global rule.
  const [phase, setPhase] = useState<"enter" | "shown" | "leave">("enter");

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase("shown"));
    const rest = setTimeout(() => setPhase("leave"), REST_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(rest);
    };
  }, []);

  useEffect(() => {
    if (phase !== "leave") return;
    const t = setTimeout(() => onDismiss(toast.id), EXIT_MS);
    return () => clearTimeout(t);
  }, [phase, toast.id, onDismiss]);

  const { color, Icon } = TONE[toast.kind];
  const off = phase !== "shown";
  return (
    <div
      role="status"
      // Click to dismiss early — the only interactive part (the wrapper is
      // click-through so toasts never block the UI underneath).
      onClick={() => setPhase("leave")}
      className="surface pointer-events-auto flex max-w-sm cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-base text-[var(--color-text)] shadow-[0_8px_24px_-6px_rgba(0,0,0,0.55)] transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-out)]"
      style={{ opacity: off ? 0 : 1, transform: off ? "translateY(8px)" : "none" }}
    >
      <Icon size={15} className="flex-none" style={{ color }} />
      <span className="min-w-0 truncate">{toast.message}</span>
    </div>
  );
}

/**
 * Renders the transient confirmation toasts (see lib/toast.ts). Mounted once in
 * App, portaled to <body>, stacked in the bottom-right above the modals. The
 * wrapper is click-through (pointer-events-none); only a toast itself is clickable.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (!toasts.length) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
