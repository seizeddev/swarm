#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Swarm logo kit generator — the single source for every brand asset.

Run from anywhere:  python3 brand/build.py

Deterministic & offline: the mark is drawn from the embedded blade/cap
coordinates (canonical copy lives in src/components/Sidebar.tsx :: SwarmMark),
the wordmark is outlined from the vendored Inter-Bold (OFL) via fontTools, and
rasters come from PIL — no SVG rasterizer, no system fonts, no network.

Outputs land in brand/{logo,icon,social,palette}/ and the refreshed social
banner is also written to docs/banner.png (this replaces docs/make_banner.py).
"""
import os

from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT_PATH = os.path.join(HERE, "fonts", "Inter-Bold.ttf")          # wordmark
FONT_MEDIUM = os.path.join(HERE, "fonts", "Inter-Medium.ttf")      # tagline / supporting text

# ── palette (mirrors src/styles.css — the app is the source of truth) ─────────
PARCHMENT = "#d8d4c8"   # default mark colour on dark (= --color-text)
WHITE = "#f4f1e8"       # warm white, for busy/photographic surfaces
INK = "#161512"         # mark on light backgrounds
ICON_BURST = "#ece8dc"  # brighter parchment for the app-icon tile (legibility)
MUTED = "#989484"       # tagline on dark
BG_STOPS = [(0.0, (31, 30, 27)), (0.60, (28, 27, 24)), (1.0, (22, 21, 18))]  # #1f1e1b→#1c1b18→#161512

TAGLINE = "Mission control for your coding agents."
SPDX_XML = "<!-- SPDX-License-Identifier: GPL-3.0-or-later -->"
SPDX_CSS = "/* SPDX-License-Identifier: GPL-3.0-or-later */"

# ── mark geometry — canonical copy: src/components/Sidebar.tsx :: SwarmMark ───
# viewBox 0 0 100 100. 8 blades (triangular tip = polygon) + 8 round caps (circle).
BLADES = [
    [(45.97, 42.0), (47.97, 14.68), (57.03, 16.94)],
    [(52.8, 41.5), (73.54, 23.59), (78.35, 31.59)],
    [(58.0, 45.97), (85.32, 47.97), (83.06, 57.03)],
    [(58.5, 52.8), (76.41, 73.54), (68.41, 78.35)],
    [(54.03, 58.0), (52.03, 85.32), (42.97, 83.06)],
    [(47.2, 58.5), (26.46, 76.41), (21.65, 68.41)],
    [(42.0, 54.03), (14.68, 52.03), (16.94, 42.97)],
    [(41.5, 47.2), (23.59, 26.46), (31.59, 21.65)],
]
CAPS = [(52.5, 15.81), (75.95, 27.59), (84.19, 52.5), (72.41, 75.95),
        (47.5, 84.19), (24.05, 72.41), (15.81, 47.5), (27.59, 24.05)]
CAP_R = 4.67


def hx(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ── SVG: the mark ─────────────────────────────────────────────────────────────
def mark_inner():
    out = []
    for poly in BLADES:
        pts = " ".join(f"{x},{y}" for x, y in poly)
        out.append(f'  <polygon points="{pts}"/>')
    for cx, cy in CAPS:
        out.append(f'  <circle cx="{cx}" cy="{cy}" r="{CAP_R}"/>')
    return "\n".join(out)


def write_mark_svg(path, fill):
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        f'fill="{fill}" role="img" aria-label="swarm">\n'
        f'  <title>swarm</title>\n{mark_inner()}\n</svg>\n'
    )
    write(path, svg)


# ── wordmark: outline "swarm" from Inter-Bold ────────────────────────────────
def wordmark_geometry(word="swarm", tracking_em=-0.03):
    """Return (path_d, (minx, miny, vbw, vbh)) in font units, y-down."""
    font = TTFont(FONT_PATH)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    hmtx = font["hmtx"]
    track = tracking_em * upm

    x = 0.0
    cmds = []
    bx0 = by0 = 1e18
    bx1 = by1 = -1e18
    for ch in word:
        g = cmap[ord(ch)]
        # y-flip (font is y-up, SVG y-down) + x-shift to running pen position
        m = (1, 0, 0, -1, x, 0)
        spen = SVGPathPen(glyphs)
        glyphs[g].draw(TransformPen(spen, m))
        cmds.append(spen.getCommands())
        bpen = BoundsPen(glyphs)
        glyphs[g].draw(TransformPen(bpen, m))
        if bpen.bounds:
            x0, y0, x1, y1 = bpen.bounds
            bx0, by0 = min(bx0, x0), min(by0, y0)
            bx1, by1 = max(bx1, x1), max(by1, y1)
        x += hmtx[g][0] + track
    return " ".join(c for c in cmds if c), (bx0, by0, bx1 - bx0, by1 - by0)


def write_wordmark_svg(path, fill, geom):
    d, (mnx, mny, vw, vh) = geom
    pad = 0.0
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{mnx - pad:.1f} {mny - pad:.1f} {vw + 2 * pad:.1f} {vh + 2 * pad:.1f}" '
        f'fill="{fill}" role="img" aria-label="swarm">\n'
        f'  <title>swarm</title>\n  <path d="{d}"/>\n</svg>\n'
    )
    write(path, svg)


# ── lockups (SVG) — mark + wordmark composed via nested <svg> ─────────────────
HORIZ_WM_RATIO = 0.52   # wordmark ink-height ÷ mark height
HORIZ_GAP = 0.30
STACK_WM_RATIO = 0.46
STACK_GAP = 0.22


def write_lockup_horizontal(path, fill, geom):
    _, (mnx, mny, vw, vh) = geom
    M = 100.0
    wm_h = HORIZ_WM_RATIO * M
    wm_w = wm_h * (vw / vh)
    gap = HORIZ_GAP * M
    W = M + gap + wm_w
    wm_x = M + gap
    wm_y = (M - wm_h) / 2
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {M:.1f}" '
        f'fill="{fill}" role="img" aria-label="swarm">\n'
        f'  <title>swarm</title>\n'
        f'  <svg x="0" y="0" width="{M:.1f}" height="{M:.1f}" viewBox="0 0 100 100">\n{mark_inner()}\n  </svg>\n'
        f'  <svg x="{wm_x:.2f}" y="{wm_y:.2f}" width="{wm_w:.2f}" height="{wm_h:.2f}" '
        f'viewBox="{mnx:.1f} {mny:.1f} {vw:.1f} {vh:.1f}" preserveAspectRatio="xMidYMid meet">\n'
        f'    <path d="{geom[0]}"/>\n  </svg>\n</svg>\n'
    )
    write(path, svg)


def write_lockup_stacked(path, fill, geom):
    _, (mnx, mny, vw, vh) = geom
    M = 100.0
    wm_h = STACK_WM_RATIO * M
    wm_w = wm_h * (vw / vh)
    gap = STACK_GAP * M
    W = max(M, wm_w)
    H = M + gap + wm_h
    mark_x = (W - M) / 2
    wm_x = (W - wm_w) / 2
    wm_y = M + gap
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {H:.1f}" '
        f'fill="{fill}" role="img" aria-label="swarm">\n'
        f'  <title>swarm</title>\n'
        f'  <svg x="{mark_x:.2f}" y="0" width="{M:.1f}" height="{M:.1f}" viewBox="0 0 100 100">\n{mark_inner()}\n  </svg>\n'
        f'  <svg x="{wm_x:.2f}" y="{wm_y:.2f}" width="{wm_w:.2f}" height="{wm_h:.2f}" '
        f'viewBox="{mnx:.1f} {mny:.1f} {vw:.1f} {vh:.1f}" preserveAspectRatio="xMidYMid meet">\n'
        f'    <path d="{geom[0]}"/>\n  </svg>\n</svg>\n'
    )
    write(path, svg)


# ── favicon + app-icon SVG ───────────────────────────────────────────────────
def write_favicon_svg(path):
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="swarm">\n'
        f'  <title>swarm</title>\n'
        f'  <style>\n'
        f'    polygon, circle {{ fill: {PARCHMENT}; }}\n'
        f'    @media (prefers-color-scheme: light) {{ polygon, circle {{ fill: {INK}; }} }}\n'
        f'  </style>\n{mark_inner()}\n</svg>\n'
    )
    write(path, svg)


def write_app_icon_svg(path):
    top, mid, bot = [f'#{r:02x}{g:02x}{b:02x}' for _, (r, g, b) in BG_STOPS]
    rx = 100 * 0.2237
    # burst scaled to 80% of the tile, centred (mark viewBox 0..100 → 10..90)
    s = 0.80
    off = (100 - 100 * s) / 2
    svg = (
        f'{SPDX_XML}\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="swarm app icon">\n'
        f'  <title>swarm</title>\n'
        f'  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">\n'
        f'    <stop offset="0" stop-color="{top}"/>\n'
        f'    <stop offset="0.6" stop-color="{mid}"/>\n'
        f'    <stop offset="1" stop-color="{bot}"/>\n'
        f'  </linearGradient></defs>\n'
        f'  <rect width="100" height="100" rx="{rx:.2f}" fill="url(#bg)"/>\n'
        f'  <svg x="{off:.1f}" y="{off:.1f}" width="{100 * s:.1f}" height="{100 * s:.1f}" '
        f'viewBox="0 0 100 100" fill="{ICON_BURST}">\n{mark_inner()}\n  </svg>\n</svg>\n'
    )
    write(path, svg)


# ── PIL raster helpers ───────────────────────────────────────────────────────
def render_mark(px, rgba):
    base = px * 2
    k = base / 100.0
    m = Image.new("RGBA", (base, base), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    for poly in BLADES:
        d.polygon([(x * k, y * k) for x, y in poly], fill=rgba)
    for cx, cy in CAPS:
        d.ellipse([(cx - CAP_R) * k, (cy - CAP_R) * k, (cx + CAP_R) * k, (cy + CAP_R) * k], fill=rgba)
    return m.resize((px, px), Image.LANCZOS)


def vgrad(w, h, stops):
    col = Image.new("RGB", (1, h))
    p = col.load()
    for y in range(h):
        t = y / (h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if t <= p1:
                f = 0 if p1 == p0 else (t - p0) / (p1 - p0)
                p[0, y] = tuple(round(c0[j] + (c1[j] - c0[j]) * f) for j in range(3))
                break
        else:
            p[0, y] = stops[-1][1]
    return col.resize((w, h))


def wordmark_img(font_px, rgba, tracking_em=-0.03):
    font = ImageFont.truetype(FONT_PATH, font_px)
    track = tracking_em * font_px
    word = "swarm"
    advs = [font.getlength(c) for c in word]
    total = sum(advs) + track * (len(word) - 1)
    canvas = Image.new("RGBA", (int(total) + font_px * 2, font_px * 3), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    x = float(font_px)
    for i, c in enumerate(word):
        d.text((x, canvas.height * 0.5), c, font=font, fill=rgba, anchor="lm")
        x += advs[i] + track
    return canvas.crop(canvas.getbbox())


def tile(px, rounded=True, burst_frac=0.80, burst=ICON_BURST):
    ss = 4 if px <= 192 else 2
    W = px * ss
    img = vgrad(W, W, BG_STOPS).convert("RGBA")
    bsz = int(W * burst_frac)
    img.alpha_composite(render_mark(bsz, hx(burst) + (255,)), ((W - bsz) // 2, (W - bsz) // 2))
    if rounded:
        mask = Image.new("L", (W, W), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.2237), fill=255)
        out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out
    return img.resize((px, px), Image.LANCZOS)


def lockup_horizontal_png(mark_px, rgba):
    mk = render_mark(mark_px, rgba)
    wm = wordmark_img(int(mark_px * 0.9), rgba)
    wm_h = int(mark_px * HORIZ_WM_RATIO)
    wm = wm.resize((round(wm.width * wm_h / wm.height), wm_h), Image.LANCZOS)
    gap = int(mark_px * HORIZ_GAP)
    W = mark_px + gap + wm.width
    out = Image.new("RGBA", (W, mark_px), (0, 0, 0, 0))
    out.alpha_composite(mk, (0, 0))
    out.alpha_composite(wm, (mark_px + gap, (mark_px - wm_h) // 2))
    return out


def centered_banner(w, h, mark_px, wm_px, tag_px, gap1, gap2):
    ss = 2
    W, H = w * ss, h * ss
    img = vgrad(W, H, BG_STOPS).convert("RGBA")
    mk = render_mark(mark_px * ss, hx(PARCHMENT) + (255,))
    wm = wordmark_img(wm_px * ss, hx(PARCHMENT) + (255,))
    tag_im = _tagline_img(tag_px * ss, hx(MUTED) + (255,))
    block_h = mk.height + gap1 * ss + wm.height + gap2 * ss + tag_im.height
    y = (H - block_h) // 2
    img.alpha_composite(mk, ((W - mk.width) // 2, y)); y += mk.height + gap1 * ss
    img.alpha_composite(wm, ((W - wm.width) // 2, y)); y += wm.height + gap2 * ss
    img.alpha_composite(tag_im, ((W - tag_im.width) // 2, y))
    return img.convert("RGB").resize((w, h), Image.LANCZOS)


def _tagline_img(px, rgba):
    # Tagline is Inter Medium (the supporting-text weight) — lighter than the
    # Bold wordmark so the hierarchy reads mark → wordmark → tagline.
    font = ImageFont.truetype(FONT_MEDIUM, px)
    tmp = Image.new("RGBA", (px * len(TAGLINE), px * 3), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((px, px), TAGLINE, font=font, fill=rgba, anchor="lm")
    return tmp.crop(tmp.getbbox())


# ── palette assets ───────────────────────────────────────────────────────────
def write_palette_css(path):
    css = f"""{SPDX_CSS}
/* Swarm brand palette — mirrors src/styles.css (the app is the source of truth). */
:root {{
  --swarm-parchment: {PARCHMENT}; /* default mark on dark (= --color-text) */
  --swarm-white: {WHITE};         /* warm white, for busy/photographic surfaces */
  --swarm-ink: {INK};             /* mark on light backgrounds */
  --swarm-bg: #1c1b18;            /* app background / tile base */
  --swarm-bg-top: #1f1e1b;
  --swarm-bg-bot: #161512;
  --swarm-muted: {MUTED};         /* tagline on dark */
  --swarm-faint: #8a8674;
  --swarm-surface-1: #232220;
  --swarm-surface-2: #2b2a26;
  --swarm-surface-3: #34322e;
  --swarm-bg-gradient: linear-gradient(180deg, #1f1e1b 0%, #1c1b18 60%, #161512 100%);
}}
"""
    write(path, css)


def write_palette_svg(path):
    swatches = [
        ("parchment", PARCHMENT, INK), ("white", WHITE, INK), ("ink", INK, PARCHMENT),
        ("bg", "#1c1b18", PARCHMENT), ("surface-1", "#232220", PARCHMENT),
        ("surface-2", "#2b2a26", PARCHMENT), ("surface-3", "#34322e", PARCHMENT),
        ("muted", MUTED, INK), ("faint", "#8a8674", INK),
    ]
    cw, ch, pad = 150, 96, 0
    cells = []
    for i, (name, hexv, fg) in enumerate(swatches):
        x = i * cw
        cells.append(
            f'  <g transform="translate({x},0)">\n'
            f'    <rect width="{cw}" height="{ch}" fill="{hexv}"/>\n'
            f'    <text x="12" y="{ch - 28}" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="{fg}">{name}</text>\n'
            f'    <text x="12" y="{ch - 12}" font-family="ui-monospace, monospace" font-size="12" fill="{fg}" opacity="0.8">{hexv}</text>\n'
            f'  </g>'
        )
    svg = (
        f'{SPDX_XML}\n<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {cw * len(swatches)} {ch}" role="img" aria-label="Swarm palette">\n'
        f'  <title>Swarm palette</title>\n' + "\n".join(cells) + "\n</svg>\n"
    )
    write(path, svg)


# ── io ───────────────────────────────────────────────────────────────────────
def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("svg/css", os.path.relpath(path, ROOT))


def save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("png    ", os.path.relpath(path, ROOT), img.size)


def main():
    logo = os.path.join(HERE, "logo")
    icon = os.path.join(HERE, "icon")
    social = os.path.join(HERE, "social")
    palette = os.path.join(HERE, "palette")

    geom = wordmark_geometry()

    # logo SVGs
    write_mark_svg(os.path.join(logo, "mark.svg"), "currentColor")
    write_mark_svg(os.path.join(logo, "mark-parchment.svg"), PARCHMENT)
    write_mark_svg(os.path.join(logo, "mark-white.svg"), WHITE)
    write_mark_svg(os.path.join(logo, "mark-ink.svg"), INK)
    write_wordmark_svg(os.path.join(logo, "wordmark.svg"), "currentColor", geom)
    write_wordmark_svg(os.path.join(logo, "wordmark-parchment.svg"), PARCHMENT, geom)
    write_wordmark_svg(os.path.join(logo, "wordmark-ink.svg"), INK, geom)
    write_lockup_horizontal(os.path.join(logo, "lockup-horizontal.svg"), "currentColor", geom)
    write_lockup_horizontal(os.path.join(logo, "lockup-horizontal-ink.svg"), INK, geom)
    write_lockup_stacked(os.path.join(logo, "lockup-stacked.svg"), "currentColor", geom)
    write_lockup_stacked(os.path.join(logo, "lockup-stacked-ink.svg"), INK, geom)

    # logo PNGs (transparent)
    save_png(render_mark(512, hx(PARCHMENT) + (255,)), os.path.join(logo, "mark.png"))
    save_png(render_mark(1024, hx(PARCHMENT) + (255,)), os.path.join(logo, "mark@2x.png"))
    save_png(lockup_horizontal_png(256, hx(PARCHMENT) + (255,)), os.path.join(logo, "lockup-horizontal.png"))
    save_png(lockup_horizontal_png(256, hx(INK) + (255,)), os.path.join(logo, "lockup-horizontal-ink.png"))

    # icon + favicons
    write_app_icon_svg(os.path.join(icon, "app-icon.svg"))
    write_favicon_svg(os.path.join(icon, "favicon.svg"))
    save_png(tile(1024), os.path.join(icon, "app-icon-1024.png"))
    save_png(tile(180), os.path.join(icon, "apple-touch-icon.png"))
    f16, f32, f48 = tile(16), tile(32), tile(48)
    save_png(f16, os.path.join(icon, "favicon-16.png"))
    save_png(f32, os.path.join(icon, "favicon-32.png"))
    save_png(f48, os.path.join(icon, "favicon-48.png"))
    f32.save(os.path.join(icon, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("ico    ", os.path.relpath(os.path.join(icon, "favicon.ico"), ROOT))

    # social — mark dominant over the wordmark, tagline below (approved layout A)
    banner = centered_banner(1280, 640, mark_px=216, wm_px=120, tag_px=30, gap1=34, gap2=26)
    save_png(banner, os.path.join(social, "banner.png"))
    save_png(banner, os.path.join(ROOT, "docs", "banner.png"))  # refresh the repo social-preview
    og = centered_banner(1200, 630, mark_px=208, wm_px=116, tag_px=29, gap1=32, gap2=24)
    save_png(og, os.path.join(social, "og-image.png"))

    # palette
    write_palette_css(os.path.join(palette, "palette.css"))
    write_palette_svg(os.path.join(palette, "palette.svg"))


if __name__ == "__main__":
    main()
