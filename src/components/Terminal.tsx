// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/ipc";
import { Grid } from "../lib/term/grid";
import { measureCell, type CellMetrics } from "../lib/term/metrics";
import { GlyphAtlas } from "../lib/term/atlas";
import { createRenderer, type RendererBackend, type RenderFrame } from "../lib/term/renderer";
import { encodeKey, encodeMouse, focusEvent, reportsMouse, wheelFallback, wrapPaste } from "../lib/term/input";
import { bytesToBase64, pickClipboardImage } from "../lib/term/clipboard";
import { wheelScrollsBuffer } from "../lib/term/mode";
import { pixelToCell, orderCells, expandWord, expandLine, rowText, type Cell } from "../lib/term/select";
import { openExternal } from "../lib/external";
import { setTerminalSurface } from "../lib/theme";
import { useStore, type Pane } from "../store";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "../lib/menu";
import { ClipboardPaste, Copy, Eraser, SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";
import type { WireUpdate } from "../lib/types";

// `visible` = this pane is on screen (a split shows every leaf at once, so all of
// them must paint live). `focused` = it also owns the keyboard — only the active
// leaf grabs DOM focus and draws a solid cursor. Conflating the two froze unfocused
// split panes (the core was told to stop emitting), so a working agent in a sibling
// pane looked idle until clicked.
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
  // ResizeObserver can't be trusted for a height-only growth in WKWebView, so we
  // re-fit from this deterministic fraction (see the layout-change effect).
  wPct?: number;
  hPct?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Backend-independent model + draw layer.
  const gridRef = useRef(new Grid());
  const metricsRef = useRef<CellMetrics | null>(null);
  const atlasRef = useRef<GlyphAtlas | null>(null);
  const rendererRef = useRef<RendererBackend | null>(null);

  // Selection state (viewport cells). `anchor` is the drag start; `sel` the current
  // ordered range; live during a drag, frozen after mouseup until the next click.
  const anchorRef = useRef<Cell | null>(null);
  const selRef = useRef<{ start: Cell; end: Cell } | null>(null);
  const draggingRef = useRef(false);
  const hoverRef = useRef<{ row: number; startCol: number; endCol: number } | null>(null);

  const visibleRef = useRef(visible);
  const focusedRef = useRef(focused);
  const raf = useRef<number | undefined>(undefined);
  const fitRaf = useRef<number | undefined>(undefined);
  const fitStable = useRef<{ cols: number; rows: number } | null>(null);
  const lastSent = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimer = useRef<number | undefined>(undefined);
  const wPctRef = useRef(wPct);
  const hPctRef = useRef(hPct);
  // CSS-px cell size, derived from the (device-px) metrics — used for hit-testing
  // and the fraction→cols/rows maths.
  const cssCell = useRef({ w: 7.5, h: 17 });
  const [exited, setExited] = useState(false);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // ── Rendering ──────────────────────────────────────────────────────────────
  const scheduleRender = () => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = undefined;
      const r = rendererRef.current;
      const g = gridRef.current;
      if (!r) return;
      const frame: RenderFrame = {
        grid: g,
        dirty: g.takeDirty(),
        selection: selRef.current,
        focused: focusedRef.current,
        hover: hoverRef.current,
      };
      try {
        r.draw(frame);
      } catch {
        // A lost/failed GPU context: rebuild (re-tries WebGL2, else Canvas2D).
        rebuildRenderer();
      }
      updateScrollbar();
    });
  };

  const apply = (u: WireUpdate) => {
    gridRef.current.apply(u);
    if (visibleRef.current) scheduleRender();
  };

  // ── Metrics / backend ───────────────────────────────────────────────────────
  // Measure the cell box to integer device pixels from the live `.term` font, then
  // (re)build the atlas + renderer. Returns false until the pane has laid out.
  const measureMetrics = (): boolean => {
    const span = measureRef.current;
    if (!span) return false;
    const cs = getComputedStyle(span);
    const fontPx = parseFloat(cs.fontSize) || 12.5;
    const lineHeightPx = parseFloat(cs.lineHeight) || Math.round(fontPx * 1.35);
    const family = cs.fontFamily || "monospace";
    // The canvas clears to the terminal surface colour; the `.term` span carries the
    // same `--color-bg-deep` as the pane wrapper, so reading it here keeps the canvas
    // clear in lockstep with the app palette (the sub-cell remainder is seamless).
    // Runs before the first frame, so there's no flash.
    setTerminalSurface(cs.backgroundColor);
    const dpr = window.devicePixelRatio || 1;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return false;
    const m = measureCell(ctx, fontPx, family, lineHeightPx, dpr);
    metricsRef.current = m;
    cssCell.current = { w: m.cellW / dpr, h: m.cellH / dpr };
    if (!atlasRef.current) atlasRef.current = new GlyphAtlas(m, family);
    else atlasRef.current.reset(m);
    if (!rendererRef.current) {
      const canvas = canvasRef.current;
      if (canvas) rendererRef.current = createRenderer(canvas, m, atlasRef.current, rebuildRenderer);
    } else {
      rendererRef.current.setMetrics(m, atlasRef.current);
    }
    gridRef.current.markAllDirty();
    return true;
  };

  const rebuildRenderer = () => {
    const canvas = canvasRef.current;
    const m = metricsRef.current;
    const atlas = atlasRef.current;
    if (!canvas || !m || !atlas) return;
    rendererRef.current?.dispose();
    rendererRef.current = createRenderer(canvas, m, atlas, rebuildRenderer);
    const dims = lastSent.current;
    if (dims) applyCanvasSize(dims.cols, dims.rows);
    gridRef.current.markAllDirty();
    scheduleRender();
  };

  // ── Sizing ───────────────────────────────────────────────────────────────────
  // cols/rows from the stable tiling-area fraction (lag-free — never the lagging
  // element height), divided by the integer cell metrics. See the long note in the
  // layout-change effect for why the fraction is used instead of ResizeObserver.
  const measureFraction = (): { cols: number; rows: number } | null => {
    const wrap = wrapRef.current;
    const wp = wPctRef.current;
    const hp = hPctRef.current;
    if (!wrap || wp == null || hp == null) return null;
    const area = (wrap.offsetParent as HTMLElement | null)?.offsetParent as HTMLElement | null;
    if (!area || area.clientWidth === 0 || area.clientHeight === 0) return null;
    return dimsFromBox((area.clientWidth * wp) / 100, (area.clientHeight * hp) / 100);
  };

  const measure = (): { cols: number; rows: number } | null => {
    const wrap = wrapRef.current;
    if (!wrap || wrap.clientWidth === 0 || wrap.clientHeight === 0) return null;
    return dimsFromBox(wrap.clientWidth, wrap.clientHeight);
  };

  const dimsFromBox = (boxW: number, boxH: number): { cols: number; rows: number } => {
    const wrap = wrapRef.current as HTMLElement;
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const { w, h } = cssCell.current;
    return {
      cols: Math.max(2, Math.floor((boxW - padX) / w)),
      rows: Math.max(1, Math.floor((boxH - padY) / h)),
    };
  };

  // Size the canvas backing store (device px) and CSS box to the committed grid, so
  // the cell grid is always exactly sized; the pane's sub-cell remainder shows the
  // terminal background of the wrapper, seamlessly.
  const applyCanvasSize = (cols: number, rows: number) => {
    const m = metricsRef.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!m || !canvas || !wrap) return;
    const dw = cols * m.cellW;
    const dh = rows * m.cellH;
    canvas.style.width = `${dw / m.dpr}px`;
    canvas.style.height = `${dh / m.dpr}px`;
    // Position the canvas at the wrapper's content origin, derived from its real
    // padding (the same padding dimsFromBox subtracts) — so the CSS class never has
    // to hardcode an offset that could drift from the wrapper's `p-2`.
    const cs = getComputedStyle(wrap);
    canvas.style.left = `${parseFloat(cs.paddingLeft)}px`;
    canvas.style.top = `${parseFloat(cs.paddingTop)}px`;
    rendererRef.current?.resize(dw, dh);
    gridRef.current.markAllDirty();
  };

  // Stable-commit fit: measure on a frame; only commit when the measurement repeats
  // identically across two frames (the area has settled). This replaces the old
  // settle-storm of rAF+60ms+250ms+fonts.ready+RO fits, which could each land on a
  // different floor() row count while the box was still moving — the source of the
  // "random few-px gap at the bottom" jump.
  const requestFit = () => {
    if (fitRaf.current != null) return;
    fitRaf.current = requestAnimationFrame(() => {
      fitRaf.current = undefined;
      const dims = measureFraction() ?? measure();
      if (!dims) return;
      const prev = fitStable.current;
      fitStable.current = dims;
      if (!prev || prev.cols !== dims.cols || prev.rows !== dims.rows) {
        requestFit(); // not yet stable — re-check next frame
        return;
      }
      commitFit(dims);
    });
  };

  const commitFit = (dims: { cols: number; rows: number }) => {
    applyCanvasSize(dims.cols, dims.rows);
    scheduleRender();
    const last = lastSent.current;
    if (last && last.cols === dims.cols && last.rows === dims.rows) return;
    lastSent.current = dims;
    const id = ptyIdRef.current;
    if (id) api.ptyResize(id, dims.cols, dims.rows).catch(() => {});
  };

  const scheduleFit = () => {
    if (resizeTimer.current != null) clearTimeout(resizeTimer.current);
    resizeTimer.current = window.setTimeout(() => {
      resizeTimer.current = undefined;
      fitStable.current = null;
      requestFit();
    }, 50);
  };

  // Wait for a real laid-out size before the spawn measures geometry.
  const measureReady = (cancelled: () => boolean) =>
    new Promise<{ cols: number; rows: number }>((resolve) => {
      let tries = 0;
      const tick = () => {
        if (!metricsRef.current) measureMetrics();
        const dims = measureFraction() ?? measure();
        if (dims) resolve(dims);
        else if (cancelled() || tries >= 20) resolve({ cols: 80, rows: 24 });
        else {
          tries++;
          requestAnimationFrame(tick);
        }
      };
      tick();
    });

  // ── Scrollback overlay ────────────────────────────────────────────────────────
  const updateScrollbar = () => {
    const bar = scrollbarRef.current;
    const g = gridRef.current;
    if (!bar) return;
    const total = g.history + g.rows;
    if (g.history === 0 || total <= g.rows) {
      bar.style.opacity = "0";
      return;
    }
    const thumb = Math.max(8, (g.rows / total) * 100);
    // displayOffset 0 = bottom; history = top. Convert to a top-anchored position.
    const fromTop = ((g.history - g.displayOffset) / total) * 100;
    bar.style.opacity = g.displayOffset > 0 ? "0.5" : "0.2";
    bar.style.height = `${thumb}%`;
    bar.style.top = `${fromTop}%`;
  };

  // ── Lifecycle: spawn / attach ─────────────────────────────────────────────────
  useLayoutEffect(() => {
    wPctRef.current = wPct;
    hPctRef.current = hPct;
  });

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  useEffect(() => {
    focusedRef.current = focused;
    // Focus reporting (DEC 1004) when the program asked for it.
    const id = ptyIdRef.current;
    const seq = focusEvent(gridRef.current.mode, focused);
    if (id && seq) api.ptyWrite(id, seq);
    if (focused) gridRef.current.markAllDirty();
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  useEffect(() => {
    let cancelled = false;
    measureMetrics();
    (async () => {
      const existing = useStore.getState().panes.find((p) => p.paneId === pane.paneId)?.ptyId;
      if (existing && (await api.ptyAlive(existing))) {
        if (cancelled) return;
        ptyIdRef.current = existing;
        try {
          await api.ptyAttach(existing, apply);
          api.ptySetVisible(existing, visibleRef.current).catch(() => {});
          requestFit();
          return;
        } catch {
          /* session vanished between alive-check and attach → spawn below */
        }
      }
      const { cols, rows } = await measureReady(() => cancelled);
      if (cancelled) return;
      try {
        const id = await api.ptySpawn(
          { cwd: pane.cwd, command: pane.command, args: pane.args, env: pane.env, cols, rows },
          apply,
        );
        if (!useStore.getState().panes.some((p) => p.paneId === pane.paneId)) {
          api.ptyKill(id);
          return;
        }
        ptyIdRef.current = id;
        lastSent.current = { cols, rows };
        applyCanvasSize(cols, rows);
        useStore.getState().bindPty(pane.paneId, id);
        api.ptySetVisible(id, cancelled ? false : visibleRef.current).catch(() => {});
        requestFit();
      } catch {
        if (!cancelled) setExited(true);
      }
    })();

    return () => {
      cancelled = true;
      if (ptyIdRef.current) api.ptySetVisible(ptyIdRef.current, false).catch(() => {});
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = undefined;
      }
      if (fitRaf.current) {
        cancelAnimationFrame(fitRaf.current);
        fitRaf.current = undefined;
      }
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.paneId]);

  // OSC 52 copy: a program asked to set the system clipboard. Honour it for this
  // pane only (filtered by id), writing via the WebView clipboard API.
  useEffect(() => {
    const un = listen<{ id: string; text: string }>("term:clipboard", (e) => {
      if (e.payload.id === ptyIdRef.current && e.payload.text) {
        navigator.clipboard?.writeText(e.payload.text).catch(() => {});
      }
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  // ResizeObserver: window/font changes. Layout changes inside the tab are driven
  // from the fraction effect below (WKWebView misses a %-height grow).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!ptyIdRef.current) return;
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

  // Layout-change re-fit (a sibling split opened/closed, or a divider dragged).
  useLayoutEffect(() => {
    if (!visible || ptyIdRef.current == null) return;
    fitStable.current = null;
    requestFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wPct, hPct, visible]);

  // DPR change (moving the window between displays): re-measure metrics, which
  // re-rasterizes the atlas and re-fits, then repaint.
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      measureMetrics();
      fitStable.current = null;
      requestFit();
      scheduleRender();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = ptyIdRef.current;
    if (id) api.ptySetVisible(id, visible).catch(() => {});
    if (visible) {
      gridRef.current.markAllDirty();
      scheduleRender();
      requestFit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (focused) wrapRef.current?.focus();
  }, [focused]);

  // ── Input ─────────────────────────────────────────────────────────────────────
  const clearSelection = () => {
    if (selRef.current) {
      selRef.current = null;
      gridRef.current.markAllDirty();
      scheduleRender();
    }
  };

  const copySelection = async () => {
    const sel = selRef.current;
    const id = ptyIdRef.current;
    if (!sel || !id) return;
    try {
      const text = await api.ptySelectionText(id, [sel.start.row, sel.start.col], [sel.end.row, sel.end.col]);
      if (text) await navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard denied — nothing to do */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Copy a live selection on ⌘/Ctrl+C; without a selection, Ctrl+C falls through
    // to encodeKey and sends SIGINT (the interrupt path).
    if (e.key === "c" && (e.metaKey || e.ctrlKey) && selRef.current) {
      e.preventDefault();
      void copySelection();
      return;
    }
    const seq = encodeKey(e.nativeEvent, gridRef.current.mode);
    if (seq != null) {
      e.preventDefault();
      const id = ptyIdRef.current;
      if (id) {
        // Typing snaps the viewport back to the live tail (matches every terminal).
        if (gridRef.current.displayOffset > 0) api.ptyScroll(id, -1_000_000).catch(() => {});
        api.ptyWrite(id, seq);
      }
      clearSelection();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    // Grab the image File reference synchronously — clipboardData is only live
    // during the event, but the File it hands back can be read async afterwards.
    const image = text ? null : pickClipboardImage(e.clipboardData);
    e.preventDefault();
    const id = ptyIdRef.current;
    if (!id) return;
    if (!text) {
      // No text but an image (a screenshot, a copied picture): a PTY can't carry
      // raw image bytes, so — like cmux/iTerm2/WezTerm — persist it to a temp file
      // and paste the *path* for the agent to read off disk. (Claude Code's own
      // clipboard read misses WebKit images: it wants the legacy «class PNGf»
      // pasteboard type, but WKWebView publishes them as public.png.)
      if (image) void pasteImage(id, image.file, image.ext);
      return;
    }
    pasteText(text);
  };

  // Write clipboard text to the PTY: bracketed when the program asked for it,
  // otherwise guarded against accidentally auto-running multi-line content.
  // Shared by the paste event and the context-menu "Paste" item.
  const pasteText = (text: string) => {
    const id = ptyIdRef.current;
    if (!id || !text) return;
    const mode = gridRef.current.mode;
    const wrapped = wrapPaste(text, mode);
    // Bracketed paste tells the program the bytes are a paste (no per-newline
    // auto-exec), so the multi-line guard is only needed when NOT bracketed.
    if (wrapped === text) {
      const multiline = /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
      if (multiline) {
        const count = text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
        if (!window.confirm(`Paste ${count} lines into the terminal? Lines may run as commands.`)) {
          return;
        }
      }
    }
    api.ptyWrite(id, wrapped);
  };

  // Menu-triggered paste: the clipboard isn't carried on a synthetic event, so
  // read it explicitly. Read via the *native* clipboard (the Rust core), NOT
  // `navigator.clipboard.readText()` — the latter raises WKWebView's modal
  // DOM-paste permission prompt (a stray second "Paste" button + a multi-second
  // main-thread stall). Image paste stays on the native event path (the File ref
  // is only live there); this covers text, the common case. Refocus the canvas
  // afterwards so keystrokes land immediately (the menu click took focus).
  const pasteFromClipboard = async () => {
    try {
      const text = await api.readClipboardText();
      if (text) pasteText(text);
    } catch {
      /* clipboard read failed — nothing to paste */
    } finally {
      wrapRef.current?.focus();
    }
  };

  // Save a pasted image to a temp file via the core, then paste its path. Sent as
  // a bracketed paste (when the program asked for it) so a TUI sees one paste
  // event — matching how a drag-and-dropped file arrives, which is what makes
  // Claude Code attach the image.
  const pasteImage = async (id: string, file: File, ext: string) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0) return;
      const path = await api.saveClipboardImage(bytesToBase64(bytes), ext);
      if (ptyIdRef.current !== id) return; // pane changed while we were saving
      api.ptyWrite(id, wrapPaste(path, gridRef.current.mode));
    } catch {
      /* couldn't read or save the image — nothing to paste */
    }
  };

  // Pointer → viewport cell, from the canvas's CSS box.
  const eventCell = (e: React.MouseEvent): Cell | null => {
    const canvas = canvasRef.current;
    const g = gridRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return pixelToCell(e.clientX - r.left, e.clientY - r.top, cssCell.current.w, cssCell.current.h, g.cols, g.rows);
  };

  const linkAt = (cell: Cell): string | undefined => gridRef.current.runAt(cell.col, cell.row)?.link;

  const onMouseDown = (e: React.MouseEvent) => {
    wrapRef.current?.focus();
    useStore.getState().selectPane(pane.paneId);
    const cell = eventCell(e);
    if (!cell) return;
    const g = gridRef.current;
    const id = ptyIdRef.current;

    // ⌘/Ctrl-click an OSC 8 hyperlink opens it (http(s) only, via the guarded opener).
    const link = linkAt(cell);
    if (link && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openExternal(link).catch(() => {});
      return;
    }

    // Mouse-reporting program: forward the press instead of selecting. The
    // right button is the exception — it summons our context menu (see
    // onContextMenu), so we don't forward it; the coding agents we host don't
    // use a right-click, and Copy/Paste is worth more than the report.
    if (id && reportsMouse(g.mode) && e.button !== 2) {
      const seq = encodeMouse(
        { type: "press", button: e.button, col: cell.col, row: cell.row, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey },
        g.mode,
      );
      if (seq) {
        e.preventDefault();
        api.ptyWrite(id, seq);
        return;
      }
    }

    if (e.button !== 0) return;
    e.preventDefault();
    if (e.detail >= 3) {
      const text = rowText(g.lines[cell.row]);
      const { startCol, endCol } = expandLine(text, g.cols);
      selRef.current = { start: { col: startCol, row: cell.row }, end: { col: endCol, row: cell.row } };
      draggingRef.current = false;
      void copySelection();
    } else if (e.detail === 2) {
      const text = rowText(g.lines[cell.row]);
      const { startCol, endCol } = expandWord(text, cell.col);
      selRef.current = { start: { col: startCol, row: cell.row }, end: { col: endCol, row: cell.row } };
      draggingRef.current = false;
      void copySelection();
    } else {
      anchorRef.current = cell;
      selRef.current = null;
      draggingRef.current = true;
    }
    g.markAllDirty();
    scheduleRender();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const cell = eventCell(e);
    if (!cell) return;
    const g = gridRef.current;
    const id = ptyIdRef.current;

    // Hover-underline an OSC 8 hyperlink.
    const run = g.runAt(cell.col, cell.row);
    const prevHover = hoverRef.current;
    if (run?.link) {
      const { startCol, endCol } = expandLink(g, cell.row, cell.col, run.link);
      hoverRef.current = { row: cell.row, startCol, endCol };
    } else {
      hoverRef.current = null;
    }
    if (!sameHover(prevHover, hoverRef.current)) {
      g.markAllDirty();
      scheduleRender();
    }

    if (draggingRef.current && anchorRef.current) {
      selRef.current = orderCells(anchorRef.current, cell);
      g.markAllDirty();
      scheduleRender();
    } else if (id && reportsMouse(g.mode) && e.buttons) {
      const seq = encodeMouse(
        { type: "move", button: 0, col: cell.col, row: cell.row, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey },
        g.mode,
      );
      if (seq) api.ptyWrite(id, seq);
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const g = gridRef.current;
    const id = ptyIdRef.current;
    const cell = eventCell(e);
    if (id && reportsMouse(g.mode) && cell) {
      const seq = encodeMouse(
        { type: "release", button: e.button, col: cell.col, row: cell.row, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey },
        g.mode,
      );
      if (seq) api.ptyWrite(id, seq);
    }
    if (draggingRef.current) {
      draggingRef.current = false;
      // copy-on-select (terminal convention)
      if (selRef.current) void copySelection();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const g = gridRef.current;
    const id = ptyIdRef.current;
    if (!id) return;
    const up = e.deltaY < 0;
    const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / cssCell.current.h) || 1));
    if (reportsMouse(g.mode)) {
      const cell = eventCell(e as unknown as React.MouseEvent);
      const seq = encodeMouse(
        { type: "wheel", button: 0, col: cell?.col ?? 0, row: cell?.row ?? 0, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, wheelUp: up },
        g.mode,
      );
      if (seq) api.ptyWrite(id, seq.repeat(lines));
      return;
    }
    if (wheelScrollsBuffer(g.mode)) {
      api.ptyScroll(id, up ? lines : -lines).catch(() => {});
      return;
    }
    const fb = wheelFallback(g.mode, up, lines);
    if (fb) api.ptyWrite(id, fb);
  };

  // Right-click menu for the canvas — always shown (even over a mouse-reporting
  // TUI like Claude/Codex). onMouseDown deliberately doesn't forward the right
  // button to such programs, so the menu wins; Copy/Paste is more useful there
  // than a forwarded right-click the agent ignores anyway.
  const onContextMenu = (e: React.MouseEvent) => {
    const id = ptyIdRef.current;
    const store = useStore.getState();
    const items: MenuItem[] = [
      {
        label: "Copy",
        icon: <Copy size={14} />,
        disabled: !selRef.current,
        onClick: () => void copySelection(),
      },
      { label: "Paste", icon: <ClipboardPaste size={14} />, onClick: () => void pasteFromClipboard() },
      { kind: "separator" },
      {
        label: "Clear",
        icon: <Eraser size={14} />,
        // Ctrl+L — the readline/shell clear-screen binding; redraws TUIs too.
        onClick: () => id && api.ptyWrite(id, "\x0c"),
      },
      { kind: "separator" },
      {
        label: "Split Right",
        icon: <SplitSquareHorizontal size={14} />,
        onClick: () => {
          store.selectPane(pane.paneId);
          store.splitActive("row");
        },
      },
      {
        label: "Split Down",
        icon: <SplitSquareVertical size={14} />,
        onClick: () => {
          store.selectPane(pane.paneId);
          store.splitActive("col");
        },
      },
      {
        label: "Close Terminal",
        icon: <X size={14} />,
        destructive: true,
        onClick: () => store.removePane(pane.paneId),
      },
    ];
    openMenu(e, items);
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
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

      <canvas ref={canvasRef} className="term-canvas" />

      <div ref={scrollbarRef} className="term-scrollbar" aria-hidden />

      {exited && (
        <div className="absolute inset-0 grid place-items-center text-sm text-[var(--color-muted)]">
          process exited
        </div>
      )}

      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}

type Hover = { row: number; startCol: number; endCol: number };

// Field-wise equality for the hover state (null-safe) — cheaper and clearer than a
// JSON.stringify round-trip on the move hot path.
function sameHover(a: Hover | null, b: Hover | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.row === b.row && a.startCol === b.startCol && a.endCol === b.endCol;
}

// Expand a hovered cell to the full extent of the contiguous cells sharing the
// same OSC 8 link on `row` (a single link can span several style runs).
function expandLink(
  g: Grid,
  row: number,
  col: number,
  link: string,
): { startCol: number; endCol: number } {
  let s = col;
  let e = col;
  while (s > 0 && g.runAt(s - 1, row)?.link === link) s--;
  while (e < g.cols - 1 && g.runAt(e + 1, row)?.link === link) e++;
  return { startCol: s, endCol: e };
}
