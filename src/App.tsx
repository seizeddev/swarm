// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { TopBar } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { Shortcuts } from "./components/Shortcuts";
import { AgentIntegrations } from "./components/AgentIntegrations";
import { DialogHost } from "./components/DialogHost";
import { buildCommands, type CommandHandlers } from "./lib/commands";
import { dispatchDrop } from "./lib/drop";
import { applyPanelWidth, currentPanelWidth } from "./lib/panel";

// Zoom is a document-level CSS mutation with no React state — kept module-level so
// the command handlers stay stable references.
let zoom = 1;
const setZoom = (v: number) => {
  zoom = Math.min(1.8, Math.max(0.6, v));
  document.documentElement.style.zoom = String(zoom);
};

// The native folder picker runs in Rust (so the workspace registry stays a real
// security boundary — see `pick_workspace`), and `addWorkspace` adopts the
// chosen path. A no-op when the user cancels the dialog.
function pickAndAddWorkspace() {
  return useStore.getState().addWorkspace();
}

export default function App() {
  // Overlay modals. Palette is also opened from the native menu (⌘⇧P); shortcuts
  // from the rail's `?` icon (and the menu); integrations from the palette/menu.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);

  // The injected (DOM/dialog/modal) handlers the shared command registry needs.
  // Stable for the app's lifetime — store actions are read fresh inside each run.
  const handlers = useMemo<CommandHandlers>(
    () => ({
      newWorkspace: pickAndAddWorkspace,
      closeWorkspace: () => {
        const s = useStore.getState();
        if (s.activeWorkspaceId) s.closeWorkspaceWithConfirm(s.activeWorkspaceId);
      },
      zoomIn: () => setZoom(zoom + 0.1),
      zoomOut: () => setZoom(zoom - 0.1),
      zoomReset: () => setZoom(1),
      openShortcuts: () => setShortcutsOpen(true),
      openIntegrations: () => setIntegrationsOpen(true),
    }),
    [],
  );

  // Native-menu dispatch shares the command registry, so a menu item and its
  // palette twin run the exact same path (one behaviour, one path). A few ids
  // aren't registry commands: the palette toggle and the numbered project jumps.
  // Held in a ref so the (single, mount-time) event listener never re-subscribes.
  const handleMenuRef = useRef<(id: string) => void>(() => {});
  handleMenuRef.current = (id: string) => {
    if (id === "command_palette") {
      setPaletteOpen(true);
      return;
    }
    const cmd = buildCommands(handlers).find((c) => c.id === id);
    if (cmd) {
      cmd.run();
      return;
    }
    if (id.startsWith("ws_")) {
      const n = parseInt(id.slice(3), 10);
      if (n) useStore.getState().focusWorkspaceIndex(n);
    }
  };

  // App-shortcut keys, owned in JS rather than as native-menu accelerators. The
  // native menu items (Command Palette / Keyboard Shortcuts) deliberately carry
  // NO accelerator: a macOS Shift+letter key-equivalent is consumed by AppKit
  // before the webview *and* matches unreliably in tao/muda, so the keystroke
  // could be eaten with nothing opening. Here the keystroke always reaches the
  // webview. Matched on `event.code` (the physical key — layout/Shift independent,
  // unlike `key`), captured at the window so it beats the terminal's handler
  // (which ignores ⌘ combos anyway). Toggles, so the same chord closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.code === "KeyP" && e.shiftKey) {
        // P sits in the same place on every Latin layout, so the physical code is
        // the reliable match (Shift-independent).
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "/" || e.key === "?") {
        // Slash is layout-dependent — US ⌘/ vs German ⌘⇧7 are different physical
        // keys — so match the produced *character*, not `code`. `?` is accepted
        // as a friendly alias (Shift+/ on US).
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Compact breakpoint + persisted/clamped panel width. Kept out of the main
  // effect so it owns its own listeners and runs before first paint matters.
  useEffect(() => {
    const saved = parseInt(localStorage.getItem("panelW") ?? "", 10);
    if (Number.isFinite(saved)) applyPanelWidth(saved);

    const mq = window.matchMedia("(max-width: 767px)");
    const onMq = () => useStore.getState().setCompact(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);

    // On window resize, re-clamp the panel so a shrinking window can't leave the
    // workspace starved (panelMax() shrinks with innerWidth).
    const onResize = () => applyPanelWidth(currentPanelWidth());
    window.addEventListener("resize", onResize);
    return () => {
      mq.removeEventListener("change", onMq);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const s = useStore.getState();

    // Restore the previous session, then persist (debounced) on every change.
    let unsub = () => {};
    s.hydrate().then(() => {
      let t: ReturnType<typeof setTimeout>;
      unsub = useStore.subscribe(() => {
        clearTimeout(t);
        t = setTimeout(() => useStore.getState().persist(), 400);
      });
    });

    // Self-update: poll latest.json at launch, every 15 minutes, and whenever
    // the window regains focus (throttled to 60s). A release published at 18:00
    // surfaces in the banner within minutes of use — the on-focus check makes it
    // feel instant when you return to the app. Standard production cadence.
    let lastCheck = 0;
    const checkUpdate = () => {
      // No real update endpoint in dev — skip the check so the DevUpdatePreview
      // cycler's state isn't wiped by a background "no update" result.
      if (import.meta.env.DEV) return;
      const now = Date.now();
      if (now - lastCheck < 60 * 1000) return;
      lastCheck = now;
      useStore.getState().checkForUpdate();
    };
    checkUpdate();
    const updateTimer = setInterval(checkUpdate, 15 * 60 * 1000);
    const onFocus = () => {
      if (document.visibilityState === "visible") checkUpdate();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    // Window-focus tracking drives whether a background agent notification
    // escalates to an OS banner (see store.onNotify). onFocusChanged is the
    // authoritative OS-level signal (covers other-app focus, minimize, and
    // window hide); visibilitychange catches occlusion the same way. Seed from
    // the live state so we don't assume "focused" on launch.
    const win = getCurrentWindow();
    const setFocused = (v: boolean) => useStore.getState().setWindowFocused(v);
    win
      .isFocused()
      .then(setFocused)
      .catch(() => {});
    const unlistenFocus = win.onFocusChanged(({ payload }) => setFocused(payload));
    const onVisibility = () => {
      if (document.visibilityState === "hidden") setFocused(false);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Fullscreen tracking: macOS hides the traffic lights in fullscreen, so the
    // TopBar must drop the left padding that clears them (else the title floats
    // over dead space). Tauri has no dedicated fullscreen event — entering or
    // leaving fullscreen fires a resize, so re-query isFullscreen() on each.
    const syncFullscreen = () =>
      win
        .isFullscreen()
        .then((v) => useStore.getState().setFullscreen(v))
        .catch(() => {});
    syncFullscreen();
    const unlistenResize = win.onResized(syncFullscreen);

    // Suppress the WKWebView's native right-click menu (its only items are
    // "Reload" / "Inspect Element" — useless and off-brand for a desktop app).
    // Components that want a context menu (e.g. the Sidebar workspace menu) call
    // preventDefault in their own React handler, which fires first; a second
    // preventDefault here is a harmless no-op. We keep the native menu over
    // editable fields so copy/paste/spell-check still work where it's wanted.
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);

    // OS file drag-and-drop. Tauri's webview event is global and carries real
    // absolute paths + a physical-pixel drop position; hit-test that point to the
    // pane under it and hand its handler the paths (Terminal pastes them as one
    // bracketed paste). A real file already has a path, so — unlike a clipboard
    // image — no temp-file write is needed.
    const dnd = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      const { paths, position } = e.payload;
      if (!paths?.length) return;
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(
        position.x / dpr,
        position.y / dpr,
      ) as HTMLElement | null;
      const paneId = el?.closest<HTMLElement>("[data-pane-id]")?.getAttribute("data-pane-id");
      if (paneId) dispatchDrop(paneId, paths);
    });

    // Live git status: the backend's per-worktree notify watcher fires
    // `fs:changed`; coalesce bursts per workspace before refreshing.
    const fsTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const events = Promise.all([
      listen<{ id: string }>("term:attention", (e) =>
        useStore.getState().onAttention(e.payload.id),
      ),
      listen<{ id: string; title: string; body: string }>("term:notify", (e) =>
        useStore.getState().onNotify(e.payload.id, e.payload.title, e.payload.body),
      ),
      listen<{ id: string; title: string }>("term:title", (e) =>
        useStore.getState().onTitle(e.payload.id, e.payload.title),
      ),
      listen<string>("menu", (e) => handleMenuRef.current(e.payload)),
      listen<{ paneId: string; body: string }>("pane:notify", (e) =>
        useStore.getState().onPaneNotify(e.payload.paneId, e.payload.body),
      ),
      // Clicking a native OS notification (Rust focuses the window) — open the
      // pane it came from, restoring the terminal view even from a PR/diff.
      listen<{ paneId: string; workspaceId: string }>("notif:activate", (e) => {
        const s = useStore.getState();
        s.setActiveWorkspace(e.payload.workspaceId);
        s.selectPane(e.payload.paneId);
      }),
      listen<{ workspaceId: string }>("fs:changed", (e) => {
        const id = e.payload.workspaceId;
        clearTimeout(fsTimers.get(id));
        fsTimers.set(
          id,
          setTimeout(() => {
            fsTimers.delete(id);
            useStore.getState().refreshStatus(id);
          }, 200),
        );
      }),
    ]);

    return () => {
      unsub();
      clearInterval(updateTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("contextmenu", onContextMenu);
      unlistenFocus.then((f) => f()).catch(() => {});
      unlistenResize.then((f) => f()).catch(() => {});
      dnd.then((f) => f()).catch(() => {});
      fsTimers.forEach((t) => clearTimeout(t));
      events.then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar onShowShortcuts={() => setShortcutsOpen(true)} />
        <Workspace />
      </div>
      {paletteOpen && <CommandPalette handlers={handlers} onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
      {integrationsOpen && <AgentIntegrations onClose={() => setIntegrationsOpen(false)} />}
      <DialogHost />
    </div>
  );
}
