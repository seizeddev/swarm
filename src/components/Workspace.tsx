import { useRef } from "react";
import {
  FolderGit2,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import { useActiveWorkspace, useStore } from "../store";
import { computeLayout, leaves, type DivRect, type LeafRect } from "../lib/layout";
import { Terminal } from "./Terminal";
import { DiffEditor } from "./DiffEditor";
import { PrView } from "./PrView";
import { CommitDetail } from "./CommitDetail";

const ATTN = "var(--color-text)";

export function Workspace() {
  const ws = useActiveWorkspace();
  const allPanes = useStore((s) => s.panes);
  const { selectTab, selectPane, removePane, addPane, splitActive, setRatio, showTerminal } =
    useStore();
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
      {/* Tab strip + split toolbar */}
      <div className="flex h-11 flex-none items-center gap-1 border-b border-[var(--color-border)] px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {ws?.tabs.map((t) => {
            const active = ws.activeTab === t.id && ws.editor.type === "terminal";
            const ids = leaves(t.layout);
            const head = allPanes.find((p) => p.paneId === t.activeLeaf) ?? allPanes.find((p) => p.paneId === ids[0]);
            const attn = allPanes.some((p) => ids.includes(p.paneId) && p.attention);
            return (
              <div
                key={t.id}
                data-active={active}
                onClick={() => selectTab(t.id)}
                className="group row flex h-8 cursor-pointer items-center gap-2 px-3 text-[12.5px]"
              >
                <TerminalSquare size={13} className="text-[var(--color-muted)]" />
                <span className="max-w-[150px] truncate">{head?.title ?? "Shell"}</span>
                {ids.length > 1 && (
                  <span className="text-[10px] text-[var(--color-faint)]">{ids.length}</span>
                )}
                {attn && <span className="h-1.5 w-1.5 rounded-full" style={{ background: ATTN }} />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    ids.forEach((id) => removePane(id));
                  }}
                  title="Close terminal"
                  className="icon-btn h-5 w-5 opacity-0 transition group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>

        {ws && (
          <div className="flex flex-none items-center gap-0.5">
            <button className="icon-btn h-7 w-7" title="New terminal" onClick={() => addPane()}>
              <Plus size={14} />
            </button>
            <button
              className="icon-btn h-7 w-7"
              title="Split right"
              onClick={() => splitActive("row")}
            >
              <SplitSquareHorizontal size={14} />
            </button>
            <button
              className="icon-btn h-7 w-7"
              title="Split down"
              onClick={() => splitActive("col")}
            >
              <SplitSquareVertical size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Editor area */}
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
                  className="icon-btn absolute right-1.5 top-1.5 z-20 h-6 w-6 bg-black/40 opacity-0 group-hover:opacity-100"
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
          <div className="absolute inset-0">
            <DiffEditor
              repoPath={ws.repo.path}
              file={ws.editor.file}
              staged={ws.editor.staged}
              onClose={showTerminal}
            />
          </div>
        )}
        {ws?.editor.type === "pr" && (
          <div className="absolute inset-0">
            <PrView pr={ws.editor.pr} onClose={showTerminal} />
          </div>
        )}

        {ws?.editor.type === "commit" && (
          <div className="absolute inset-0">
            <CommitDetail repoPath={ws.repo.path} oid={ws.editor.oid} onClose={showTerminal} />
          </div>
        )}

        {!ws && (
          <div className="grid h-full place-items-center text-center text-[var(--color-muted)]">
            <div>
              <FolderGit2 size={30} className="mx-auto mb-3 opacity-50" />
              <p className="text-[14px]">Add a project with the + in the sidebar to get started</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
