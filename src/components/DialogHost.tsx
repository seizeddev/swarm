// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { useDialogStore } from "../lib/dialog";

/**
 * Renders the active dialog request (see lib/dialog.ts) over the shared Modal.
 * Mounted once in App. Confirm/cancel settle the request's Promise; closing the
 * Modal (Escape / backdrop) counts as cancel — false for confirm, null for prompt.
 */
export function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const resolveCurrent = useDialogStore((s) => s.resolveCurrent);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the field whenever a new prompt becomes current, and focus it.
  useEffect(() => {
    if (current?.kind === "prompt") {
      setValue(current.opts.defaultValue ?? "");
      // Defer so the input exists and the Modal's mount animation has begun.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [current]);

  if (!current) return null;

  const { opts } = current;
  // Inline validation only applies to prompts with a validator; the message
  // gates submission so a known-bad value can't be confirmed.
  const validationMsg =
    current.kind === "prompt" && current.opts.validate ? current.opts.validate(value) : null;
  const invalid = validationMsg !== null;
  const cancel = () => resolveCurrent(current.kind === "prompt" ? null : false);
  const confirm = () => {
    if (invalid) return;
    resolveCurrent(current.kind === "prompt" ? value : true);
  };

  return (
    <Modal onClose={cancel} labelledBy="dialog-title">
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id="dialog-title" className="text-md font-semibold tracking-[-0.01em]">
            {opts.title}
          </h2>
          {opts.body && <p className="text-sm text-[var(--color-muted)]">{opts.body}</p>}
        </div>

        {current.kind === "prompt" && (
          <div className="flex flex-col gap-1.5">
            <input
              ref={inputRef}
              className="field"
              value={value}
              placeholder={current.opts.placeholder}
              aria-labelledby="dialog-title"
              aria-invalid={invalid}
              aria-describedby={invalid ? "dialog-error" : undefined}
              onChange={(e) => setValue(e.target.value)}
            />
            {invalid && (
              <p id="dialog-error" className="field-error-msg">
                {validationMsg}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={cancel}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="submit"
            disabled={invalid}
            className={opts.destructive ? "btn btn-danger" : "btn btn-accent"}
          >
            {opts.confirmLabel ?? (opts.destructive ? "Delete" : "Confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
