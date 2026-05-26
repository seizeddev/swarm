// SPDX-License-Identifier: GPL-3.0-or-later
// WebGL2 rendering backend: the primary GPU path. Draws the grid as instanced
// quads — one pass for non-default cell backgrounds, one textured pass for glyphs
// sampled from the SHARED 2D-rasterized atlas (so text is pixel-identical to the
// Canvas2D baseline; premultiplied-alpha blend, opaque backgrounds first), then
// selection tint and cursor. A full GPU redraw per frame is cheap, so this ignores
// the dirty-row list. On context loss it notifies the orchestrator to rebuild
// (which re-tries WebGL2 and otherwise falls back to Canvas2D).
import { F_DIM, F_HIDDEN, F_INVERSE, resolveColor, TERM_BG, TERM_FG } from "../theme";
import type { CellMetrics } from "./metrics";
import type { GlyphAtlas } from "./atlas";
import type { RenderFrame, RendererBackend } from "./renderer";
import { cellInRange } from "./select";

/* v8 ignore start -- WebGL2 needs a real GPU context, unavailable in node tests. */

const SOLID_VS = `#version 300 es
layout(location=0) in vec2 a_unit;        // 0..1 quad corner
layout(location=1) in vec2 a_cell;         // cell (col,row)
layout(location=2) in vec2 a_span;         // size in cells (wide glyph -> x=2)
layout(location=3) in vec4 a_color;        // straight rgba
uniform vec2 u_resolution;                 // device px
uniform vec2 u_cell;                       // cell px
out vec4 v_color;
void main() {
  vec2 px = (a_cell + a_unit * a_span) * u_cell;
  vec2 clip = (px / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const SOLID_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 frag;
void main() { frag = vec4(v_color.rgb * v_color.a, v_color.a); }`; // premultiplied out

const GLYPH_VS = `#version 300 es
layout(location=0) in vec2 a_unit;
layout(location=1) in vec2 a_cell;
layout(location=2) in vec2 a_span;
layout(location=3) in vec4 a_uv;           // (u0,v0,u1,v1) in texels-normalized
layout(location=4) in float a_alpha;       // dim factor
uniform vec2 u_resolution;
uniform vec2 u_cell;
out vec2 v_uv;
out float v_alpha;
void main() {
  vec2 px = (a_cell + a_unit * a_span) * u_cell;
  vec2 clip = (px / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_unit);
  v_alpha = a_alpha;
}`;

const GLYPH_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_alpha;
uniform sampler2D u_atlas;                  // premultiplied
out vec4 frag;
void main() { frag = texture(u_atlas, v_uv) * v_alpha; }`;

const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);

function parseHex(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("webgl2: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    throw new Error("webgl2: shader compile failed: " + log);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("webgl2: createProgram failed");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("webgl2: link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}

const ATLAS_PX = 2048;

export class WebGL2Backend implements RendererBackend {
  readonly kind = "webgl2" as const;
  private gl: WebGL2RenderingContext;
  private metrics: CellMetrics;
  private atlas: GlyphAtlas;
  private solidProg: WebGLProgram;
  private glyphProg: WebGLProgram;
  private unitBuf: WebGLBuffer;
  private solidVao: WebGLVertexArrayObject;
  private glyphVao: WebGLVertexArrayObject;
  private solidInst: WebGLBuffer; // [cellX,cellY, spanX,spanY, r,g,b,a] × N
  private glyphInst: WebGLBuffer; // [cellX,cellY, spanX,spanY, u0,v0,u1,v1, alpha] × N
  private tex: WebGLTexture;
  private texVersion = -1;
  private onLost?: () => void;

  static tryCreate(
    canvas: HTMLCanvasElement,
    metrics: CellMetrics,
    atlas: GlyphAtlas,
  ): WebGL2Backend | null {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return null;
    return new WebGL2Backend(gl, metrics, atlas);
  }

  private constructor(gl: WebGL2RenderingContext, metrics: CellMetrics, atlas: GlyphAtlas) {
    this.gl = gl;
    this.metrics = metrics;
    this.atlas = atlas;
    this.solidProg = link(gl, SOLID_VS, SOLID_FS);
    this.glyphProg = link(gl, GLYPH_VS, GLYPH_FS);

    const mk = () => {
      const b = gl.createBuffer();
      if (!b) throw new Error("webgl2: createBuffer failed");
      return b;
    };
    this.unitBuf = mk();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuf);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
    this.solidInst = mk();
    this.glyphInst = mk();

    const vao = () => {
      const v = gl.createVertexArray();
      if (!v) throw new Error("webgl2: createVertexArray failed");
      return v;
    };
    this.solidVao = vao();
    this.glyphVao = vao();
    this.setupSolidVao();
    this.setupGlyphVao();

    this.tex = (() => {
      const t = gl.createTexture();
      if (!t) throw new Error("webgl2: createTexture failed");
      return t;
    })();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    (gl.canvas as HTMLCanvasElement).addEventListener("webglcontextlost", this.handleLost, false);
  }

  private handleLost = (e: Event): void => {
    e.preventDefault();
    this.onLost?.();
  };

  setOnLost(cb: () => void): void {
    this.onLost = cb;
  }

  private setupSolidVao(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidInst);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  private setupGlyphVao(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInst);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  resize(deviceW: number, deviceH: number): void {
    const c = this.gl.canvas as HTMLCanvasElement;
    if (c.width !== deviceW || c.height !== deviceH) {
      c.width = deviceW;
      c.height = deviceH;
    }
    this.gl.viewport(0, 0, deviceW, deviceH);
  }

  setMetrics(metrics: CellMetrics, atlas: GlyphAtlas): void {
    this.metrics = metrics;
    this.atlas = atlas;
    this.texVersion = -1; // force re-upload
  }

  private uploadAtlasIfStale(): void {
    if (this.texVersion === this.atlas.version) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.atlas.canvas as unknown as TexImageSource,
    );
    this.texVersion = this.atlas.version;
  }

  draw(frame: RenderFrame): void {
    const gl = this.gl;
    const { grid, selection } = frame;
    const { cellW, cellH } = this.metrics;
    const w = grid.cols * cellW;
    const h = grid.rows * cellH;

    // Background: clear to terminal bg, then draw the non-default bg cells. Glyphs
    // need the atlas texture current first (it also bakes fg colour into pixels).
    const [br, bg, bb] = parseHex(TERM_BG);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    const solid: number[] = [];
    const glyphs: number[] = [];
    for (let y = 0; y < grid.rows; y++) {
      const runs = grid.lines[y];
      if (!runs) continue;
      let col = 0;
      for (const run of runs) {
        let fg = resolveColor(run.fg, "fg");
        let bgc = resolveColor(run.bg, "bg");
        if (run.flags & F_INVERSE) [fg, bgc] = [bgc, fg];
        const hidden = (run.flags & F_HIDDEN) !== 0;
        const alpha = run.flags & F_DIM ? 0.6 : 1;
        const chars = [...run.text];
        if (bgc !== TERM_BG) {
          const [r, g, b] = parseHex(bgc);
          solid.push(col, y, chars.length, 1, r, g, b, 1);
        }
        if (!hidden) {
          for (const ch of chars) {
            if (ch !== " ") {
              const slot = this.atlas.get(ch, run.flags, fg);
              const span = slot.wide ? 2 : 1;
              const u0 = slot.x / ATLAS_PX;
              const v0 = slot.y / ATLAS_PX;
              const u1 = (slot.x + (slot.wide ? cellW * 2 : cellW)) / ATLAS_PX;
              const v1 = (slot.y + cellH) / ATLAS_PX;
              glyphs.push(col, y, span, 1, u0, v0, u1, v1, alpha);
            }
            col++;
          }
        } else {
          col += chars.length;
        }
      }
    }

    // Atlas may have grown during the glyph loop (cache misses rasterized new
    // glyphs); upload after, so the texture has every glyph this frame uses.
    this.uploadAtlasIfStale();

    this.drawSolid(solid, w, h);

    // Glyphs (premultiplied-alpha over the opaque backgrounds).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawGlyphs(glyphs, w, h);

    // Selection tint + cursor: straight-alpha translucent quads on top.
    const overlay: number[] = [];
    if (selection) {
      for (let y = selection.start.row; y <= selection.end.row; y++) {
        let x = 0;
        while (x < grid.cols) {
          if (!cellInRange({ col: x, row: y }, selection.start, selection.end)) {
            x++;
            continue;
          }
          let run = x;
          while (run < grid.cols && cellInRange({ col: run, row: y }, selection.start, selection.end))
            run++;
          overlay.push(x, y, run - x, 1, 0.49, 0.61, 1, 0.3);
          x = run;
        }
      }
    }
    if (grid.cursorVisible && grid.cursorY >= 0 && grid.cursorY < grid.rows) {
      const [cr, cg, cb] = parseHex(TERM_FG);
      overlay.push(grid.cursorX, grid.cursorY, 1, 1, cr, cg, cb, frame.focused ? 0.85 : 0.32);
    }
    if (overlay.length) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.drawSolid(overlay, w, h);
    }
  }

  private drawSolid(data: number[], w: number, h: number): void {
    if (!data.length) return;
    const gl = this.gl;
    gl.useProgram(this.solidProg);
    gl.uniform2f(gl.getUniformLocation(this.solidProg, "u_resolution"), w, h);
    gl.uniform2f(gl.getUniformLocation(this.solidProg, "u_cell"), this.metrics.cellW, this.metrics.cellH);
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidInst);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, data.length / 8);
    gl.bindVertexArray(null);
  }

  private drawGlyphs(data: number[], w: number, h: number): void {
    if (!data.length) return;
    const gl = this.gl;
    gl.useProgram(this.glyphProg);
    gl.uniform2f(gl.getUniformLocation(this.glyphProg, "u_resolution"), w, h);
    gl.uniform2f(gl.getUniformLocation(this.glyphProg, "u_cell"), this.metrics.cellW, this.metrics.cellH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.glyphProg, "u_atlas"), 0);
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphInst);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, data.length / 9);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    (gl.canvas as HTMLCanvasElement).removeEventListener("webglcontextlost", this.handleLost);
    gl.deleteBuffer(this.unitBuf);
    gl.deleteBuffer(this.solidInst);
    gl.deleteBuffer(this.glyphInst);
    gl.deleteVertexArray(this.solidVao);
    gl.deleteVertexArray(this.glyphVao);
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.solidProg);
    gl.deleteProgram(this.glyphProg);
  }
}
/* v8 ignore stop */
