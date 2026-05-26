// SPDX-License-Identifier: GPL-3.0-or-later
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { encodeKey } from "../lib/keys";
import { applyUpdate, runStyle } from "../lib/term";
import { useStore, type Pane } from "../store";
import type { WireRun, WireUpdate } from "../lib/types";

// One grid row. Memoized and keyed by its row index, so a delta that replaces a
// single line's `runs` array re-renders only that `<TermLine>` — the untouched
// rows keep their previous `runs` reference and bail out of reconciliation.
const TermLine = memo(function TermLine({ runs }: { runs: WireRun[] }) {
  return (
    <div className="term-line">
      {runs.map((run, i) => (
        <span key={i} style={runStyle(run)}>
          {run.text}
        </span>
      ))}
    </div>
  );
});

// `visible` = this pane is on screen (a split shows every leaf at once, so all of
// them are visible and must paint live). `focused` = it also owns the keyboard —
// only the active leaf, which alone grabs DOM focus and draws a solid cursor.
// Conflating the two froze unfocused split panes: the core was told to stop
// emitting, so a working agent in a sibling pane looked idle until you clicked it.
export function Terminal({
  pane,
  visible,
  focused,
  wPct,
  hPct,
}: {
  pane: Pane;
  visible: boolean;
  focused: boolean;
  // This pane's allotted size in the tab layout (percent of the tiling area).
  // Changes when a split is created/removed or a divider is dragged — a
  // deterministic signal we re-fit from, since ResizeObserver can't be trusted
  // to deliver a height-only growth in WKWebView (see the layout-change effect).
  wPct?: number;
  hPct?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const ptyIdRef = useRef<string | null>(null);
  // The source of truth: one runs-array per visible row, patched in place by
  // deltas (so untouched rows keep their reference). A frame publishes a shallow
  // copy into `lines` state; `<TermLine>` memoization then re-renders only the
  // rows whose reference changed.
  const linesRef = useRef<WireRun[][]>([]);
  const cursorRef = useRef({ x: 0, y: 0, visible: false });
  const visibleRef = useRef(visible);
  const raf = useRef<number | undefined>(undefined);
  // Debounce handle for ResizeObserver-driven resizes (window/font changes).
  const resizeTimer = useRef<number | undefined>(undefined);
  const cell = useRef({ w: 7.5, h: 16.5 });
  // Latest layout fraction, mirrored from props so a *deferred* fit (a debounced
  // ResizeObserver callback, a settle-fit timer, a rAF) reads the current size
  // and never a stale closure — a stale fit would push the wrong winsize (e.g.
  // the pre-split full height while the pane is mid-split), and the kernel then
  // suppresses the real SIGWINCH on the next change because the size "already"
  // matches, so the TUI never repaints until you type. See fit()/measureFraction.
  const wPctRef = useRef(wPct);
  const hPctRef = useRef(hPct);
  // Last size pushed to the PTY: skip redundant resends so every ptyResize is a
  // genuine winsize change (one SIGWINCH), never a no-op that masks the next one.
  const lastSent = useRef<{ cols: number; rows: number } | null>(null);
  const [lines, setLines] = useState<WireRun[][]>([]);
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });
  const [exited, setExited] = useState(false);

  const scheduleRender = () => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = undefined;
      setLines(linesRef.current.slice());
      setCursor(cursorRef.current);
    });
  };

  const apply = (u: WireUpdate) => {
    linesRef.current = applyUpdate(linesRef.current, u);
    cursorRef.current = { x: u.cursorX, y: u.cursorY, visible: u.cursorVisible };
    // Hidden panes keep their state current but never paint — no setState churn.
    if (visibleRef.current) scheduleRender();
  };

  // Returns the grid geometry, or `null` when the pane has no real laid-out size
  // yet (missing refs or a 0×0 box). Crucially it never invents a fallback size:
  // a measurement taken from a 0-box used to floor() to 2×1 (or, worse, a sane-
  // looking 80×24) and get *sent* as a resize — which starts/reflows the agent
  // into the wrong geometry and leaves the terminal stuck at the top with dead
  // space below. Callers must skip when this is null.
  const measure = (): { cols: number; rows: number } | null => {
    const m = measureRef.current;
    const wrap = wrapRef.current;
    if (!m || !wrap || wrap.clientWidth === 0 || wrap.clientHeight === 0) return null;
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

  // Resolve once the pane has a real laid-out size, so the spawn never measures
  // a transient 0×0 box. Retries across a few frames; only if the pane never
  // lays out (genuinely hidden) does it fall back to a usable default.
  const measureReady = (cancelledRef: () => boolean) =>
    new Promise<{ cols: number; rows: number }>((resolve) => {
      let tries = 0;
      const tick = () => {
        const dims = measureFraction() ?? measure();
        if (dims) resolve(dims);
        else if (cancelledRef() || tries >= 20) resolve({ cols: 80, rows: 24 });
        else {
          tries++;
          requestAnimationFrame(tick);
        }
      };
      tick();
    });

  // Resize the PTY from this pane's *layout fraction* of the stable tiling area,
  // rather than from its own measured height. After a split opens/closes, WKWebView
  // can take up to a second — or until the next interaction forces a repaint — to
  // recompute the resolved height of a percentage-sized absolutely-positioned box.
  // So measuring the pane element directly reports the stale (pre-grow) size: the
  // TUI stays short until WebKit's lazy reflow finally lands (the "resizes back,
  // but only after I type" symptom). The tiling area's pixel size is stable across
  // splits (only the window changes it) and wPct/hPct are the new fractions the
  // instant the layout state changes, so this is correct immediately. Returns the
  // dims, or null if the area isn't laid out yet / no fraction is known.
  const measureFraction = (): { cols: number; rows: number } | null => {
    const wrap = wrapRef.current;
    const wp = wPctRef.current;
    const hp = hPctRef.current;
    if (!wrap || wp == null || hp == null) return null;
    // wrap (relative) → its offsetParent is the absolute pane box → whose
    // offsetParent is the relative tiling area we want.
    const area = (wrap.offsetParent as HTMLElement | null)?.offsetParent as HTMLElement | null;
    if (!area || area.clientWidth === 0 || area.clientHeight === 0) return null;
    const m = measureRef.current;
    if (m) {
      const r = m.getBoundingClientRect();
      if (r.width > 0) cell.current = { w: r.width / 10, h: r.height };
    }
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const cols = Math.max(2, Math.floor(((area.clientWidth * wp) / 100 - padX) / cell.current.w));
    const rows = Math.max(1, Math.floor(((area.clientHeight * hp) / 100 - padY) / cell.current.h));
    return { cols, rows };
  };

  // Push the current geometry to the running PTY. Prefers the fraction-derived
  // size (lag-free, never the stale element height) and falls back to a direct
  // element measure only when no layout fraction is known. Guards against a
  // missing id or a zero-size box, so it's safe to fire from any settle point;
  // re-sending the same size is cheap, so it needs no change-tracking.
  const fit = () => {
    const id = ptyIdRef.current;
    if (!id) return;
    const dims = measureFraction() ?? measure();
    if (!dims) return; // pane not laid out — never push a degenerate size
    // Skip a redundant resend: an identical winsize is a no-op in the kernel and
    // suppresses the SIGWINCH the *next* genuine change needs, stranding the TUI.
    const last = lastSent.current;
    if (last && last.cols === dims.cols && last.rows === dims.rows) return;
    lastSent.current = dims;
    api.ptyResize(id, dims.cols, dims.rows).catch(() => {});
  };

  // Debounced re-fit off the ResizeObserver (window / font changes): re-fits at
  // fire time so it reads the settled geometry.
  const scheduleFit = () => {
    if (resizeTimer.current != null) clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      resizeTimer.current = undefined;
      fit();
    }, 50);
  };

  // Keep the fraction refs in lock-step with the props, synchronously after every
  // commit (before paint and before any deferred fit fires), so no fit ever sizes
  // from a stale fraction.
  useLayoutEffect(() => {
    wPctRef.current = wPct;
    hPctRef.current = hPct;
  });

  useEffect(() => {
    let cancelled = false;
    // A single spawn-time measure is racy. In a packaged build the window and
    // layout can settle a frame or two *after* the pane first mounts, so the
    // initial measure() may catch a transient (too-small) box and spawn the PTY
    // with too few rows — and on a steady window nothing re-measures, while the
    // ResizeObserver's first callback can fire before the async spawn has set
    // the PTY id (so it bails on `!id`). That left the terminal short of the
    // bottom, intermittently, only in release (dev's StrictMode remount + a
    // settled dev window hid it). Fix: once the PTY exists, re-fit at several
    // independent settle points — the next two frames, after fonts load, and a
    // timed backstop. Whichever lands last on the final geometry wins; live
    // resizes are then handled by the observer.
    const timers: number[] = [];
    const scheduleSettleFits = () => {
      timers.push(requestAnimationFrame(() => requestAnimationFrame(fit)));
      timers.push(window.setTimeout(fit, 60));
      timers.push(window.setTimeout(fit, 250));
      document.fonts?.ready.then(fit).catch(() => {});
    };
    (async () => {
      // Reattach to a still-running PTY if this pane already has one (it survived
      // a previous unmount, e.g. a workspace switch); otherwise spawn fresh.
      const existing = useStore.getState().panes.find((p) => p.paneId === pane.paneId)?.ptyId;
      if (existing && (await api.ptyAlive(existing))) {
        if (cancelled) return;
        ptyIdRef.current = existing;
        try {
          await api.ptyAttach(existing, apply);
          api.ptySetVisible(existing, visibleRef.current).catch(() => {});
          scheduleSettleFits();
          return;
        } catch {
          /* session vanished between the alive check and attach → spawn below */
        }
      }
      // Wait for the pane's real size before spawning — measuring too early
      // yields a 0×0 box and would start the agent in a 1-row terminal.
      const { cols, rows } = await measureReady(() => cancelled);
      if (cancelled) return;
      try {
        const id = await api.ptySpawn(
          { cwd: pane.cwd, command: pane.command, args: pane.args, env: pane.env, cols, rows },
          apply,
        );
        // If the pane was removed while spawning, the PTY is orphaned — kill it.
        if (!useStore.getState().panes.some((p) => p.paneId === pane.paneId)) {
          api.ptyKill(id);
          return;
        }
        ptyIdRef.current = id;
        useStore.getState().bindPty(pane.paneId, id);
        // If the component unmounted mid-spawn (e.g. a workspace switch), start
        // the PTY hidden; a later remount reattaches and makes it visible.
        api.ptySetVisible(id, cancelled ? false : visibleRef.current).catch(() => {});
        scheduleSettleFits();
      } catch {
        if (!cancelled) setExited(true);
      }
    })();

    return () => {
      cancelled = true;
      // Drop any pending settle-fits so they don't resize a kept-alive PTY after
      // this pane has unmounted (the handles are rAF + timeout ids; clearing both
      // ways is harmless for the mismatched kind).
      for (const t of timers) {
        clearTimeout(t);
        cancelAnimationFrame(t);
      }
      // Keep the PTY alive across remounts; just gate it so the render thread
      // stops sending. The PTY is killed explicitly on pane/workspace removal.
      if (ptyIdRef.current) api.ptySetVisible(ptyIdRef.current, false).catch(() => {});
      // Cancelling must also clear the handle: a remount on the SAME instance
      // (React StrictMode's mount→unmount→remount, where refs persist) would
      // otherwise leave `raf.current` holding a stale, already-cancelled handle,
      // and the `raf.current != null` guard in scheduleRender would then drop
      // every future frame — the grid would never repaint. (root cause of the
      // post-perf black terminal: the new visible-effect schedules a RAF during
      // mount, so one is always pending when StrictMode's cleanup fires.)
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.paneId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Catches viewport/font changes (the window resizing, fonts loading). Layout
    // changes inside the tab — splits opening/closing, divider drags — are NOT
    // reliably reported here (WKWebView misses a height-only growth of a
    // percentage-sized absolutely-positioned pane), so those are driven from the
    // layout-change effect below; both share scheduleFit's debounce.
    const ro = new ResizeObserver(() => {
      if (!ptyIdRef.current) return;
      // A hidden pane (display:none ancestor) reports a 0-size box; resizing the
      // PTY to that would reflow the agent's UI to 2×1. Ignore those.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      scheduleFit();
    });
    ro.observe(el);
    return () => {
      if (resizeTimer.current != null) clearTimeout(resizeTimer.current);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile the PTY geometry whenever this pane's allotted size changes in the
  // tab layout — a sibling split opened/closed, or a divider was dragged. The
  // grow case (closing a split-*down* sibling, so the survivor's height doubles)
  // is the one ResizeObserver drops in WKWebView, leaving a running TUI (Claude
  // Code) stuck at the old half-height with dead space below until a reload.
  //
  // Runs in a layout effect (synchronously, before paint) and sizes from the
  // stable area fraction via fit() — so it lands the instant the layout changes,
  // with none of the percentage-reflow lag that measuring the pane element would
  // incur, and (critically) the ResizeObserver's own fit() now uses the same
  // fraction, so it can't clobber this back to the stale half-height. Retry once
  // next frame if the area isn't laid out yet. A no-op until the PTY exists, so
  // it never races the spawn-time sizing.
  useLayoutEffect(() => {
    if (!visible || ptyIdRef.current == null) return;
    fit();
    const h = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wPct, hPct, visible]);

  useEffect(() => {
    visibleRef.current = visible;
    const id = ptyIdRef.current;
    if (id) api.ptySetVisible(id, visible).catch(() => {});
    if (visible) {
      // Paint the current state immediately; the core also pushes a fresh full
      // frame in response to ptySetVisible(true).
      scheduleRender();
      // Re-fit on becoming visible: while hidden (display:none) the box is 0×0,
      // so any window resize that happened meanwhile was ignored by the observer
      // (it bails on a zero-size box). Reconcile the geometry now it's shown.
      requestAnimationFrame(fit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Keyboard focus follows the active leaf only — never grab focus just for being
  // on screen, or sibling split panes would fight over the keyboard on mount.
  useEffect(() => {
    if (focused) wrapRef.current?.focus();
  }, [focused]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const seq = encodeKey(e.nativeEvent);
    if (seq != null) {
      e.preventDefault();
      if (ptyIdRef.current) api.ptyWrite(ptyIdRef.current, seq);
    }
  };

  // Paste guard: a multi-line clipboard payload lands at the shell prompt and
  // every embedded newline auto-executes the line before it — so a page that
  // seeded the clipboard with `rm -rf … \n` could run it on a single paste.
  // Require explicit confirmation when the paste spans more than one line.
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    e.preventDefault();
    const id = ptyIdRef.current;
    if (!id || !text) return;
    const multiline = /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
    if (multiline) {
      const count = text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
      if (!window.confirm(`Paste ${count} lines into the terminal? Lines may run as commands.`)) {
        return;
      }
    }
    api.ptyWrite(id, text);
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={() => {
        wrapRef.current?.focus();
        useStore.getState().selectPane(pane.paneId);
      }}
      className="term term-pane relative h-full w-full overflow-hidden outline-none p-2"
    >
      <span
        ref={measureRef}
        className="term"
        style={{ position: "absolute", visibility: "hidden", top: 0, left: 0 }}
        aria-hidden
      >
        MMMMMMMMMM
      </span>

      {lines.map((runs, y) => (
        <TermLine key={y} runs={runs} />
      ))}

      {cursor.visible && visible && (
        <div
          className="term-cursor"
          style={{
            position: "absolute",
            left: 8 + cursor.x * cell.current.w,
            top: 8 + cursor.y * cell.current.h,
            width: cell.current.w,
            height: cell.current.h,
            // Solid in the focused pane; dimmed in an unfocused (but live) split
            // sibling, the usual terminal convention for "running, not typing here".
            opacity: focused ? 0.85 : 0.32,
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
