// SPDX-License-Identifier: GPL-3.0-or-later
import { toast } from "./toast";

// The one path every "Copy X" action routes through, so a copy is never silent:
// success raises a labelled confirmation ("Copied path"), and a denied write —
// which the bare `.catch(() => {})` used to swallow — surfaces as an error toast
// instead of vanishing. `label` is the noun for the message ("path", "PR URL").
export function copyToClipboard(text: string, label = "to clipboard"): void {
  navigator?.clipboard
    ?.writeText(text)
    .then(() => toast(`Copied ${label}`, "info"))
    .catch(() => toast("Couldn't copy to clipboard", "error"));
}
