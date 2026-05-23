import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";

let zoom = 1;
async function handleMenu(id: string) {
  const s = useStore.getState();
  switch (id) {
    case "toggle_sidebar": return s.toggleSidebar();
    case "panel_scm": return s.setPanel("scm");
    case "panel_prs": return s.setPanel("prs");
    case "panel_notifications": return s.setPanel("notifications");
    case "new_terminal": return s.addPane();
    case "split_right": return s.splitActive("row");
    case "split_down": return s.splitActive("col");
    case "close_pane": return s.closeActivePane();
    case "ws_next": return s.cycleWorkspace(1);
    case "ws_prev": return s.cycleWorkspace(-1);
    case "zoom_in":
      zoom = Math.min(1.8, zoom + 0.1);
      document.documentElement.style.zoom = String(zoom);
      return;
    case "zoom_out":
      zoom = Math.max(0.6, zoom - 0.1);
      document.documentElement.style.zoom = String(zoom);
      return;
    case "zoom_reset":
      zoom = 1;
      document.documentElement.style.zoom = "1";
      return;
    case "new_workspace": {
      const dir = await open({ directory: true, multiple: false, title: "Open a git repository" });
      if (typeof dir === "string") s.addWorkspace(dir);
      return;
    }
    default:
      if (id.startsWith("ws_")) {
        const n = parseInt(id.slice(3), 10);
        if (n) s.focusWorkspaceIndex(n);
      }
  }
}

export default function App() {
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

    const events = Promise.all([
      listen<{ id: string }>("term:attention", (e) => useStore.getState().onAttention(e.payload.id)),
      listen<{ id: string; title: string; body: string }>("term:notify", (e) =>
        useStore.getState().onNotify(e.payload.id, e.payload.title, e.payload.body),
      ),
      listen<{ id: string; title: string }>("term:title", (e) =>
        useStore.getState().onTitle(e.payload.id, e.payload.title),
      ),
      listen<string>("menu", (e) => handleMenu(e.payload)),
      listen<{ paneId: string; body: string }>("pane:notify", (e) =>
        useStore.getState().onPaneNotify(e.payload.paneId, e.payload.body),
      ),
    ]);

    return () => {
      unsub();
      events.then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <Workspace />
    </div>
  );
}
