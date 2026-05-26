// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "./Modal";
import { buildCommands, filterCommands, type Command, type CommandHandlers } from "../lib/commands";

/**
 * Command palette (⌘⇧P). A centred search field over a filtered, grouped command
 * list with ↑/↓/Enter/Esc navigation. Commands come from the shared registry
 * (`lib/commands.ts`) so every entry runs the exact same path as its native-menu
 * counterpart. Rebuilt each open so dynamic entries (Switch to <project>) are live.
 */
export function CommandPalette({
  handlers,
  onClose,
}: {
  handlers: CommandHandlers;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Snapshot the registry once per open (handlers are stable for the dialog's
  // lifetime; the store snapshot is read at build time).
  const all = useMemo(() => buildCommands(handlers), [handlers]);
  const results = useMemo(() => filterCommands(all, query), [all, query]);

  // Keep the highlighted index in range as the filtered list shrinks/grows.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll the active row into view on arrow navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [active]);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  };

  return (
    <Modal onClose={onClose} align="top">
      <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3.5 py-3">
        <Search size={16} className="flex-none text-[var(--color-faint)]" />
        <input
          ref={inputRef}
          aria-label="Command search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)]"
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {results.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[13px] text-[var(--color-muted)]">
            No matching commands
          </p>
        ) : (
          results.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              data-active={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => run(cmd)}
              className="row flex w-full items-center justify-between gap-3 border-transparent bg-transparent px-2.5 py-2 text-left text-[13px] text-[var(--color-text)]"
            >
              <span className="truncate">{cmd.label}</span>
              <span className="flex-none text-[11px] uppercase tracking-wide text-[var(--color-faint)]">
                {cmd.group}
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
