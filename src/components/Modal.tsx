// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

  return createPortal(
    <div
      className={`animate-fade-in fixed inset-0 z-[80] flex justify-center bg-black/50 ${
        align === "top" ? "items-start pt-[12vh]" : "items-center"
      }`}
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="surface animate-scale-in mx-4 flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden"
        // Clicks inside the card must not fall through to the backdrop's close.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
