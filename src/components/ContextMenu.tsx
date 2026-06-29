// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition, type MenuItem, type MenuState } from "../lib/menu";
import { rovingIndex } from "../lib/roving";

/**
 * Tiny hook that owns one menu's open/closed state. `open(e, items)` summons it
 * at the cursor (suppressing the native menu); `close()` dismisses it. A
 * component renders the matching <ContextMenu menu={menu} onClose={close} />.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState>(null);
  const open = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

/**
 * The shared right-click menu surface. Fixed at the cursor, measured and clamped
 * so it never spills off-screen, and dismissed on outside-click / Escape / blur /
 * resize / scroll. Monochrome by design — destructive intent reads through the
 * danger hue on the row, not a coloured chrome. Extracted from the original
 * inline Sidebar workspace menu so every component shares one behaviour.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Render off-screen for one frame, measure, then place clamped — avoids a
  // flash at the raw cursor point when the menu would overflow an edge.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Keyboard nav: the index of the focused actionable item. Refs to each
  // actionable button let ↑/↓/Home/End move focus across them.
  const [activeIdx, setActiveIdx] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus the first item when the menu opens (so it's keyboard-operable
  // immediately); rAF lets the buttons mount + the clamped position settle first.
  useEffect(() => {
    if (!menu) return;
    setActiveIdx(0);
    const r = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(r);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el?.offsetWidth ?? 208;
    const h = el?.offsetHeight ?? 0;
    setPos(clampMenuPosition(menu.x, menu.y, w, h, window.innerWidth, window.innerHeight));
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    // capture: catch scrolls in any nested container, not just the window.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Map each entry to its actionable-item index (-1 for separators, headers, and
  // disabled items — none of which take focus), so roving navigation skips them.
  let actionCount = 0;
  const actionIndex = menu.items.map((item) =>
    item.kind === "separator" || item.kind === "header" || item.disabled ? -1 : actionCount++,
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = rovingIndex(activeIdx, e.key, actionCount);
    if (next === null) return;
    e.preventDefault();
    setActiveIdx(next);
    itemRefs.current[next]?.focus();
  };

  // Portal to <body> so the menu escapes every overflow/transform ancestor — a
  // panel's `overflow-auto` plus the `transform`-based entrance animations would
  // otherwise clip a fixed-positioned child (the menu was cut off at the panel
  // edge). At the body root, the viewport-clamped fixed coords are exact.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="surface animate-scale-in fixed z-[70] min-w-[200px] max-w-[280px] p-1.5"
      style={
        {
          left: pos?.left ?? menu.x,
          top: pos?.top ?? menu.y,
          // Hide the unmeasured first paint to avoid a one-frame jump.
          visibility: pos ? "visible" : "hidden",
          // The menu is positioned by its top-left at the cursor, so grow from
          // there (the default top-right would expand away from the click point).
          "--origin": "top left",
        } as React.CSSProperties
      }
      // Stop a click inside from bubbling to row/pane handlers underneath.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {menu.items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="divider my-1" />;
        if (item.kind === "header")
          return (
            <p key={i} className="label-caps-dim truncate px-2 py-1.5">
              {item.label}
            </p>
          );
        const ai = actionIndex[i];
        return (
          <button
            type="button"
            key={i}
            ref={(el) => {
              if (ai >= 0) itemRefs.current[ai] = el;
            }}
            role="menuitem"
            disabled={item.disabled}
            tabIndex={ai === activeIdx ? 0 : -1}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className="menu-item gap-2.5 px-2 py-2 text-base"
            style={item.destructive ? { color: "var(--color-danger)" } : undefined}
          >
            {item.icon && (
              <span
                className="flex-none"
                style={{ color: item.destructive ? "var(--color-danger)" : "var(--color-muted)" }}
              >
                {item.icon}
              </span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
