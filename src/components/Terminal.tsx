import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/ipc";
import { encodeKey } from "../lib/keys";
import {
  F_BOLD,
  F_DIM,
  F_HIDDEN,
  F_INVERSE,
  F_ITALIC,
  F_STRIKE,
  F_UNDERLINE,
  resolveColor,
  TERM_BG,
} from "../lib/theme";
import { useStore, type Pane } from "../store";
import type { WireGrid, WireRun } from "../lib/types";

function runStyle(run: WireRun): CSSProperties {
  let fg = resolveColor(run.fg, "fg");
  let bg = resolveColor(run.bg, "bg");
  if (run.flags & F_INVERSE) [fg, bg] = [bg, fg];
  const s: CSSProperties = { color: fg };
  if (bg !== TERM_BG) s.background = bg;
  if (run.flags & F_BOLD) s.fontWeight = 700;
  if (run.flags & F_ITALIC) s.fontStyle = "italic";
  const deco: string[] = [];
  if (run.flags & F_UNDERLINE) deco.push("underline");
  if (run.flags & F_STRIKE) deco.push("line-through");
  if (deco.length) s.textDecoration = deco.join(" ");
  if (run.flags & F_DIM) s.opacity = 0.6;
  if (run.flags & F_HIDDEN) s.visibility = "hidden";
  return s;
}

export function Terminal({ pane, visible }: { pane: Pane; visible: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const ptyIdRef = useRef<string | null>(null);
  const latest = useRef<WireGrid | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const cell = useRef({ w: 7.5, h: 16.5 });
  const [grid, setGrid] = useState<WireGrid | null>(null);
  const [exited, setExited] = useState(false);

  const scheduleRender = () => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = undefined;
      setGrid(latest.current);
    });
  };

  const measure = () => {
    const m = measureRef.current;
    const wrap = wrapRef.current;
    if (!m || !wrap) return { cols: 80, rows: 24 };
    const r = m.getBoundingClientRect();
    if (r.width > 0) cell.current = { w: r.width / 10, h: r.height };
    // Subtract the wrapper's padding so the grid never overflows the viewport.
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const cols = Math.max(2, Math.floor((wrap.clientWidth - padX) / cell.current.w));
    const rows = Math.max(1, Math.floor((wrap.clientHeight - padY) / cell.current.h));
    return { cols, rows };
  };

  useEffect(() => {
    let disposed = false;
    const { cols, rows } = measure();
    api
      .ptySpawn(
        {
          cwd: pane.cwd,
          command: pane.command,
          args: pane.args,
          env: pane.env,
          cols,
          rows,
        },
        (g) => {
          latest.current = g;
          scheduleRender();
        },
      )
      .then((id) => {
        if (disposed) {
          api.ptyKill(id);
          return;
        }
        ptyIdRef.current = id;
        useStore.getState().bindPty(pane.paneId, id);
      })
      .catch(() => setExited(true));

    return () => {
      disposed = true;
      if (ptyIdRef.current) api.ptyKill(ptyIdRef.current);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.paneId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!ptyIdRef.current) return;
      const { cols, rows } = measure();
      api.ptyResize(ptyIdRef.current, cols, rows).then((g) => {
        if (g) {
          latest.current = g;
          scheduleRender();
        }
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (visible) wrapRef.current?.focus();
  }, [visible]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const seq = encodeKey(e.nativeEvent);
    if (seq != null) {
      e.preventDefault();
      if (ptyIdRef.current) api.ptyWrite(ptyIdRef.current, seq);
    }
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => {
        wrapRef.current?.focus();
        useStore.getState().selectPane(pane.paneId);
      }}
      className="term relative h-full w-full overflow-hidden outline-none p-2"
    >
      <span
        ref={measureRef}
        className="term"
        style={{ position: "absolute", visibility: "hidden", top: 0, left: 0 }}
        aria-hidden
      >
        MMMMMMMMMM
      </span>

      {grid?.lines.map((runs, y) => (
        <div key={y} className="term-line">
          {runs.map((run, i) => (
            <span key={i} style={runStyle(run)}>
              {run.text}
            </span>
          ))}
        </div>
      ))}

      {grid && grid.cursorVisible && visible && (
        <div
          className="term-cursor"
          style={{
            position: "absolute",
            left: 8 + grid.cursorX * cell.current.w,
            top: 8 + grid.cursorY * cell.current.h,
            width: cell.current.w,
            height: cell.current.h,
            opacity: 0.85,
          }}
        />
      )}

      {exited && (
        <div className="absolute inset-0 grid place-items-center text-sm text-[var(--color-muted)]">
          process exited
        </div>
      )}
    </div>
  );
}
