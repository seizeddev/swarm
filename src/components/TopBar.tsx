// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  GitBranch,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import { useActiveWorkspace, useStore } from "../store";
import { leaves } from "../lib/layout";
import { rovingIndex } from "../lib/roving";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "../lib/menu";
import type { AgentDef } from "../lib/types";
import { isMac } from "../lib/platform";

const ATTN = "var(--color-text)";

// Spawn menu — the single place to open a new pane (a plain Shell or an agent).
// Lives in the TopBar's tab toolbar, beside the split controls.
function AgentMenu() {
  const { agents, addPane } = useStore(
    useShallow((s) => ({ agents: s.agents, addPane: s.addPane })),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Shell is index 0, the agents follow — one flat list for roving focus, so
  // ↑/↓/Home/End walk every item (the canonical menu behaviour, same as
  // ContextMenu/CommandPalette; the old bespoke rows had no keyboard nav).
  const spawnAgents = agents.filter((a) => a.name.toLowerCase() !== "shell");
  const itemCount = 1 + spawnAgents.length;
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Focus the first item when the popover opens (rAF so the buttons have
  // mounted), mirroring ContextMenu.
  useEffect(() => {
    if (!open) return;
    setActiveIdx(0);
    const r = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(r);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    const next = rovingIndex(activeIdx, e.key, itemCount);
    if (next === null) return;
    e.preventDefault();
    setActiveIdx(next);
    itemRefs.current[next]?.focus();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="icon-btn h-7 w-7"
        title="New terminal"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onKeyDown}
          className="surface animate-scale-in absolute right-0 top-9 z-50 w-52 p-1.5"
        >
          <p className="label-caps-dim px-2 py-1.5">Spawn</p>
          <button
            type="button"
            role="menuitem"
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            tabIndex={activeIdx === 0 ? 0 : -1}
            onClick={() => {
              addPane();
              setOpen(false);
            }}
            className="menu-item gap-2.5 px-2 py-2 text-base"
          >
            <TerminalSquare size={14} className="text-[var(--color-muted)]" />
            <span className="flex-1">Shell</span>
          </button>
          {spawnAgents.map((a: AgentDef, i) => {
            const idx = i + 1;
            return (
              <button
                type="button"
                role="menuitem"
                key={a.id}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                tabIndex={activeIdx === idx ? 0 : -1}
                onClick={() => {
                  addPane(a);
                  setOpen(false);
                }}
                className="menu-item gap-2.5 px-2 py-2 text-base"
              >
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ background: a.installed ? "var(--color-text)" : "var(--color-faint)" }}
                />
                <span className="flex-1">{a.name}</span>
                {!a.installed && (
                  <span className="text-2xs text-[var(--color-faint)]">missing</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The unified window chrome: one 44px band spanning the whole window, the macOS
// drag region (with the traffic lights overlaid on the rail column). It carries
// the repo identity over the inspector and the terminal tabs over the content —
// folding what used to be three stacked header bands into a single top spine.
export function TopBar() {
  const ws = useActiveWorkspace();
  const wsId = ws?.id;
  const allPanes = useStore(useShallow((s) => s.panes.filter((p) => p.workspaceId === wsId)));
  const {
    selectTab,
    removePane,
    splitActive,
    closeOtherTabs,
    closeTabsToRight,
    sidebarVisible,
    compact,
    fullscreen,
  } = useStore(
    useShallow((s) => ({
      selectTab: s.selectTab,
      removePane: s.removePane,
      splitActive: s.splitActive,
      closeOtherTabs: s.closeOtherTabs,
      closeTabsToRight: s.closeTabsToRight,
      sidebarVisible: s.sidebarVisible,
      compact: s.compact,
      fullscreen: s.fullscreen,
    })),
  );
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // Roving tabindex for the tab strip: exactly one tab is Tab-reachable (the
  // selected one, or the first when the editor is showing something else), and
  // ←/→/Home/End move both selection and focus across the strip.
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tabs = ws?.tabs ?? [];
  const activeTabIndex = tabs.findIndex(
    (t) => ws?.activeTab === t.id && ws?.editor.type === "terminal",
  );
  const rovingTab = activeTabIndex >= 0 ? activeTabIndex : 0;
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const next = rovingIndex(i, e.key, tabs.length);
    if (next === null) return;
    e.preventDefault();
    selectTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  // Build the right-click menu for a tab. Split/close act on this tab; the close
  // variants mirror VS Code (Close, Close Others, Close to the Right). The last
  // remaining tab can't "close others", so that item disables itself.
  const tabMenu = (tabId: string, ids: string[], label: string, tabCount: number): MenuItem[] => [
    { kind: "header", label },
    {
      label: "Split Right",
      icon: <SplitSquareHorizontal size={14} />,
      onClick: () => {
        selectTab(tabId);
        splitActive("row");
      },
    },
    {
      label: "Split Down",
      icon: <SplitSquareVertical size={14} />,
      onClick: () => {
        selectTab(tabId);
        splitActive("col");
      },
    },
    { kind: "separator" },
    {
      label: "Close",
      icon: <X size={14} />,
      onClick: () => ids.forEach((id) => removePane(id)),
    },
    {
      label: "Close Others",
      icon: <X size={14} />,
      disabled: tabCount <= 1,
      onClick: () => closeOtherTabs(tabId),
    },
    {
      label: "Close to the Right",
      icon: <X size={14} />,
      onClick: () => closeTabsToRight(tabId),
    },
  ];

  // The repo-identity block sits over the in-flow inspector panel and must
  // mirror its width. In compact mode the panel floats (no reserved column), so
  // the identity block is dropped and the tabs slide left to fill the band.
  const showIdentity = !!ws && sidebarVisible && !compact;

  return (
    // The whole band is one drag region. `deep` (Tauri ≥2.x) makes *any*
    // descendant click drag the window — unlike a bare attr, which only drags
    // when the click target is literally this element (so the wide tab area,
    // covered by a `flex-1` inner container, was a dead zone). Interactive
    // controls opt out on their own: <button>s are inherently non-draggable,
    // and the tabs carry role="tab" (an INTERACTIVE_ROLE Tauri treats the same
    // way), so click-to-select and the close/split buttons keep working while
    // every gap and empty strip across the bar drags. Intermediate containers
    // must NOT re-declare the attr: a bare value on an inner element returns
    // early and would shadow this `deep` root.
    <div
      data-tauri-drag-region="deep"
      className="flex h-11 flex-none items-center border-b border-[var(--color-border)]"
    >
      {/* Rail column — the macOS traffic lights overlay this strip. Windows/
          Linux have a native title bar (titleBarStyle Overlay is macOS-only),
          so there is nothing to clear on the left and the rail collapses. */}
      {isMac && <div className="h-full w-14 flex-none" />}

      {/* Repo identity — sits over the inspector panel, only while it's open,
          and tracks the panel's resizable width. pl-8 clears the macOS traffic
          lights (which spill ~72px from the left, past the 56px rail column).
          In fullscreen macOS hides the lights, so we drop back to pl-3 — else
          the title floats with dead space on the left. */}
      {showIdentity && (
        <div
          className={`flex h-full flex-none items-center gap-2 overflow-hidden pr-3 ${!isMac || fullscreen ? "pl-3" : "pl-8"}`}
          style={{ width: "var(--panel-w)" }}
        >
          <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.01em] text-[var(--color-text)]">
            {ws.repo.name}
          </h1>
          {ws.repo.headBranch && (
            // Lucide GitBranch instead of the bare ⎇ glyph (U+2387, rasterized by
            // Inter at the wrong weight/optical size). flex-none so the repo name
            // yields first; the inner span caps + truncates a long branch name.
            <span className="flex flex-none items-center gap-1 text-sm text-[var(--color-muted)]">
              <GitBranch size={13} className="flex-none" />
              <span className="max-w-[140px] truncate">{ws.repo.headBranch}</span>
            </span>
          )}
        </div>
      )}

      {/* Content column — terminal tabs + split toolbar, over the editor area.
          When the inspector is hidden there's no identity block, so the tabs
          themselves must clear the traffic lights (pl-8) — unless fullscreen
          hides them, where pl-3 reclaims the dead space. */}
      <div
        className={`flex h-full min-w-0 flex-1 items-center gap-1 pr-3 ${
          showIdentity || fullscreen || !isMac ? "pl-3" : "pl-8"
        }`}
      >
        <div
          role="tablist"
          aria-label="Terminal tabs"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
        >
          {ws?.tabs.map((t, i) => {
            const active = ws.activeTab === t.id && ws.editor.type === "terminal";
            const ids = leaves(t.layout);
            const head =
              allPanes.find((p) => p.paneId === t.activeLeaf) ??
              allPanes.find((p) => p.paneId === ids[0]);
            const attn = allPanes.some((p) => ids.includes(p.paneId) && p.attention);
            return (
              <div
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                aria-selected={active}
                tabIndex={i === rovingTab ? 0 : -1}
                data-active={active}
                onClick={() => selectTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                onContextMenu={(e) =>
                  openMenu(e, tabMenu(t.id, ids, head?.title ?? "Shell", ws.tabs.length))
                }
                className="group row flex h-8 cursor-pointer items-center gap-2 px-3 text-base"
              >
                <TerminalSquare size={13} className="text-[var(--color-muted)]" />
                <span className="max-w-[150px] truncate">{head?.title ?? "Shell"}</span>
                {ids.length > 1 && (
                  <span className="nums text-2xs text-[var(--color-faint)]">{ids.length}</span>
                )}
                {attn && <span className="h-1.5 w-1.5 rounded-full" style={{ background: ATTN }} />}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    ids.forEach((id) => removePane(id));
                  }}
                  title="Close terminal"
                  aria-label="Close terminal"
                  // The active tab keeps its × visible (you can always close the
                  // current terminal at a glance); inactive tabs reveal it on hover.
                  // No bare `transition` here — .icon-btn now animates opacity on
                  // the system curve (it used to override with Tailwind's stock ease).
                  className={`icon-btn h-6 w-6 ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>

        {ws && (
          <div className="flex flex-none items-center gap-0.5">
            <AgentMenu />
            <button
              type="button"
              className="icon-btn h-7 w-7"
              title="Split right"
              onClick={() => splitActive("row")}
            >
              <SplitSquareHorizontal size={14} />
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              title="Split down"
              onClick={() => splitActive("col")}
            >
              <SplitSquareVertical size={14} />
            </button>
          </div>
        )}
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
