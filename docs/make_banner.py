#!/usr/bin/env python3
"""Generate the swarm hero / social-preview banner (1280x640).

Uses the bare burst mark (the rounded-square tile is keyed out of the app
icon) on the app's own background — no border, no glow — with the wordmark
and tagline centered. Rendered at 2x and downscaled (LANCZOS) for crispness.
"""
from PIL import Image, ImageDraw, ImageFont
import os

S = 2  # supersample factor
W, H = 1280 * S, 640 * S

# Palette — eyedropped from src/styles.css
TEXT = (244, 244, 245)
MUTED = (154, 154, 158)
FAINT = (90, 90, 94)
BG_TOP = (26, 26, 26)
BG_BOT = (19, 19, 20)

HERE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(HERE, "../src-tauri/icons/icon.png")


def font(size, bold=False):
    size *= S
    try:
        f = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", size)
        if bold:
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                pass
        return f
    except Exception:
        p = "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold \
            else "/System/Library/Fonts/Supplemental/Arial.ttf"
        return ImageFont.truetype(p, size)


def mono(size):
    return ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", size * S)


# --- background: subtle vertical gradient, no glow ----------------------
img = Image.new("RGB", (W, H), BG_BOT)
top = Image.new("RGB", (W, H), BG_TOP)
mask = Image.linear_gradient("L").resize((W, H))  # 0 top -> 255 bottom
img = Image.composite(img, top, mask)
draw = ImageDraw.Draw(img)
cx = W // 2

# --- burst mark: the exact in-app vector (SwarmMark in Sidebar.tsx) ------
# viewBox 0 0 100 100; 8 blades = a triangular tip (polygon) + a round cap
# (circle). Drawn at high supersample and downscaled for clean AA edges.
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


def render_mark(px):
    R = 1024
    k = R / 100.0
    m = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    md = ImageDraw.Draw(m)
    fill = (TEXT[0], TEXT[1], TEXT[2], 255)
    for poly in BLADES:
        md.polygon([(x * k, y * k) for x, y in poly], fill=fill)
    for cxp, cyp in CAPS:
        md.ellipse([(cxp - CAP_R) * k, (cyp - CAP_R) * k,
                    (cxp + CAP_R) * k, (cyp + CAP_R) * k], fill=fill)
    return m.resize((px, px), Image.LANCZOS)


msz = 216 * S
mark = render_mark(msz)
img.paste(mark, (cx - msz // 2, 78 * S), mark)

# --- centered wordmark + tagline ----------------------------------------
draw.text((cx, 338 * S), "swarm", font=font(120, bold=True), fill=TEXT, anchor="mm")

tag = font(33)
draw.text((cx, 452 * S), "Parallel terminals for your AI coding agents,", font=tag, fill=MUTED, anchor="mm")
draw.text((cx, 496 * S), "with a built-in GitHub view.", font=tag, fill=MUTED, anchor="mm")

draw.text((cx, 558 * S), "Rust core   ·   no Electron   ·   macOS / Linux / Windows",
          font=mono(20), fill=FAINT, anchor="mm")

# --- downscale & save ----------------------------------------------------
out = img.resize((1280, 640), Image.LANCZOS)
dest = os.path.join(HERE, "banner.png")
out.save(dest)
print("wrote", dest, out.size)
