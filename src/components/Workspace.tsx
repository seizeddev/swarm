// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { X } from "lucide-react";
import { useActiveWorkspace, useStore } from "../store";
import { SwarmMark } from "./Sidebar";
import { computeLayout, type DivRect, type LeafRect } from "../lib/layout";
import { Terminal } from "./Terminal";
import { DiffEditor } from "./DiffEditor";
import { PrView } from "./PrView";
import { CommitDetail } from "./CommitDetail";

export function Workspace() {
  const ws = useActiveWorkspace();
  // Only the active workspace's panes are mounted; other workspaces' panes
  // unmount, but their PTYs keep running in Rust and reattach on return.
  const wsId = ws?.id;
  const allPanes = useStore(useShallow((s) => s.panes.filter((p) => p.workspaceId === wsId)));
  const { selectPane, removePane, setRatio, showTerminal } = useStore(
    useShallow((s) => ({
      selectPane: s.selectPane,
      removePane: s.removePane,
      setRatio: s.setRatio,
      showTerminal: s.showTerminal,
    })),
  );
  const areaRef = useRef<HTMLDivElement>(null);

  const tab = ws?.tabs.find((t) => t.id === ws.activeTab) ?? null;

  // Rects for the active tab's leaves + dividers (percent units).
  const leafRects: LeafRect[] = [];
  const divs: DivRect[] = [];
  if (tab) computeLayout(tab.layout, { x: 0, y: 0, w: 100, h: 100 }, leafRects, divs);
  const rectFor = new Map(leafRects.map((l) => [l.paneId, l.rect]));

  const startDrag = (d: DivRect) => (e: React.MouseEvent) => {
    e.preventDefault();
    const area = areaRef.current;
    if (!area) return;
    const box = area.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const splitLeft = box.left + (d.rect.x / 100) * box.width;
      const splitTop = box.top + (d.rect.y / 100) * box.height;
      const splitW = (d.rect.w / 100) * box.width;
      const splitH = (d.rect.h / 100) * box.height;
      const ratio =
        d.dir === "row"
          ? (ev.clientX - splitLeft) / splitW
          : (ev.clientY - splitTop) / splitH;
      setRatio(d.id, Math.min(0.9, Math.max(0.1, ratio)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Editor area (the tab strip + split toolbar now live in the TopBar) */}
      <div ref={areaRef} className="relative min-h-0 flex-1">
        {/* All terminals stay mounted; the parent rect controls show/hide + tiling. */}
        {allPanes.map((p) => {
          const r = rectFor.get(p.paneId);
          const shown = !!r && ws?.editor.type === "terminal";
          const focused = !!tab && tab.activeLeaf === p.paneId;
          const split = leafRects.length > 1;
          return (
            <div
              key={p.paneId}
              onMouseDown={() => split && selectPane(p.paneId)}
              className="group absolute overflow-hidden"
              style={
                r
                  ? {
                      left: `${r.x}%`,
                      top: `${r.y}%`,
                      width: `${r.w}%`,
                      height: `${r.h}%`,
                      display: shown ? "block" : "none",
                      boxShadow: split
                        ? focused
                          ? "inset 0 0 0 1px rgba(255,255,255,0.18)"
                          : "inset 0 0 0 0.5px rgba(255,255,255,0.08)"
                        : "none",
                    }
                  : { inset: 0, display: "none" }
              }
            >
              <Terminal pane={p} visible={shown && focused} />
              {split && shown && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removePane(p.paneId);
                  }}
                  title="Close terminal"
                  className="icon-btn absolute right-1.5 top-1.5 z-20 h-6 w-6 opacity-0 group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}

        {/* Divider handles for the active tab */}
        {ws?.editor.type === "terminal" &&
          divs.map((d) => {
            const left = d.dir === "row" ? d.rect.x + d.rect.w * d.ratio : d.rect.x;
            const top = d.dir === "col" ? d.rect.y + d.rect.h * d.ratio : d.rect.y;
            return (
              <div
                key={d.id}
                onMouseDown={startDrag(d)}
                className="group absolute z-10"
                style={
                  d.dir === "row"
                    ? {
                        left: `${left}%`,
                        top: `${d.rect.y}%`,
                        height: `${d.rect.h}%`,
                        width: 9,
                        transform: "translateX(-50%)",
                        cursor: "col-resize",
                      }
                    : {
                        top: `${top}%`,
                        left: `${d.rect.x}%`,
                        width: `${d.rect.w}%`,
                        height: 9,
                        transform: "translateY(-50%)",
                        cursor: "row-resize",
                      }
                }
              >
                <div
                  className="absolute bg-[var(--color-border)] transition group-hover:bg-[var(--color-border-strong)]"
                  style={
                    d.dir === "row"
                      ? { left: "50%", top: 0, bottom: 0, width: 1, transform: "translateX(-50%)" }
                      : { top: "50%", left: 0, right: 0, height: 1, transform: "translateY(-50%)" }
                  }
                />
              </div>
            );
          })}

        {ws?.editor.type === "diff" && (
          <div className="animate-fade-rise absolute inset-0">
            <DiffEditor
              repoPath={ws.repo.path}
              file={ws.editor.file}
              staged={ws.editor.staged}
              onClose={showTerminal}
            />
          </div>
        )}
        {ws?.editor.type === "pr" && (
          <div className="animate-fade-rise absolute inset-0">
            <PrView repoPath={ws.repo.path} pr={ws.editor.pr} onClose={showTerminal} />
          </div>
        )}

        {ws?.editor.type === "commit" && (
          <div className="animate-fade-rise absolute inset-0">
            <CommitDetail repoPath={ws.repo.path} oid={ws.editor.oid} onClose={showTerminal} />
          </div>
        )}

        {!ws && (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="animate-fade-rise">
              <div className="mx-auto mb-6 grid h-20 w-20 place-items-center text-[var(--color-muted)] opacity-80">
                <SwarmMark size={60} />
              </div>
              <p className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--color-text)]">
                Welcome to swarm
              </p>
              <p className="mx-auto mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-[var(--color-muted)]">
                Add a project with the <span className="text-[var(--color-text)]">+</span> in the
                sidebar to spin up terminals, review diffs and ship pull requests.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
