// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusablesWithin } from "../lib/focus";

/**
 * A centred modal overlay — the shared surface for the command palette, the
 * shortcuts sheet, agent integrations, and the rename input. Portaled to <body>
 * so it escapes panel overflow/transform ancestors (same reason as ContextMenu),
 * dims the backdrop, and dismisses on Escape or a backdrop click. Monochrome by
 * design: the dim is a plain black scrim, the card is the standard `.surface`.
 */
export function Modal({
  onClose,
  children,
  align = "center",
  labelledBy,
}: {
  onClose: () => void;
  children: ReactNode;
  /** "top" anchors the card near the top (command-palette feel); "center" centres it. */
  align?: "center" | "top";
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Focus trap + restore: remember what was focused, move focus into the dialog,
  // and on close hand it back — so keyboard users aren't dropped at the top of
  // the page. (The Tab/Shift+Tab cycle itself is handled in onKeyDown below.)
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = dialogRef.current ? focusablesWithin(dialogRef.current) : [];
    (focusables[0] ?? dialogRef.current)?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusables = focusablesWithin(dialogRef.current);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className={`animate-fade-in fixed inset-0 z-[80] flex justify-center bg-black/50 ${
        align === "top" ? "items-start pt-[12vh]" : "items-center"
      }`}
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="surface animate-scale-in mx-4 flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden focus:outline-none"
        // Grow from where the surface actually sits: a centered modal from its
        // center, a top-anchored one (command palette) from its top edge — not the
        // CSS default top-right (which is meant for the TopBar/Sidebar popovers).
        style={{ "--origin": align === "top" ? "top center" : "center" } as React.CSSProperties}
        // Clicks inside the card must not fall through to the backdrop's close.
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
