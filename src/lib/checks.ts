// SPDX-License-Identifier: GPL-3.0-or-later
import { CheckCircle2, Clock, Dot, XCircle, type LucideIcon } from "lucide-react";

export interface CheckGlyph {
  Icon: LucideIcon;
  /** CSS colour token; passing/none stay neutral — monochrome chrome, only
      failing (red) and pending (amber) earn a hue, the one git-status exception. */
  color: string;
  label: string;
}

/** Map a GitHub PR's aggregate check rollup to a SHAPE (not just a colour), so
    the status is legible without relying on colour perception. */
export function checkGlyph(checks: string | null): CheckGlyph {
  switch (checks) {
    case "passing":
      return { Icon: CheckCircle2, color: "var(--color-muted)", label: "Checks passing" };
    case "failing":
      return { Icon: XCircle, color: "var(--color-danger)", label: "Checks failing" };
    case "pending":
      return { Icon: Clock, color: "var(--color-warning)", label: "Checks pending" };
    default:
      return { Icon: Dot, color: "var(--color-muted)", label: "No checks" };
  }
}
