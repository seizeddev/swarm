# swarm — brand kit

The complete logo kit for **swarm**. Everything here is generated from one
reproducible source — open [`index.html`](index.html) in a browser to see the
whole kit on one page.

> **Mission control for your coding agents.**

## Quick reference

| You want… | Use |
|-----------|-----|
| The logo, on a dark UI | `logo/lockup-horizontal.svg` (parchment) |
| The logo, on a light doc | `logo/lockup-horizontal-ink.svg` |
| Just the mark | `logo/mark.svg` (inherits `currentColor`) or `mark-{parchment,white,ink}.svg` |
| Vertical/narrow space | `logo/lockup-stacked.svg` (+ `-ink`) |
| A website favicon | `icon/favicon.svg` (adapts to light/dark tabs) + `icon/favicon.ico` |
| The app icon | `icon/app-icon.svg` (the mark on the dark tile — **icon only**) |
| Social / OG preview | `social/banner.png` (1280×640), `social/og-image.png` (1200×630) |
| Brand colors in CSS | `palette/palette.css` |

## The mark

The **burst** — eight blades (a triangular tip + a round cap) in eight-fold
rotational symmetry around an open center. It reads as a swarm radiating from a
point: many agents, one origin. The canonical geometry lives in
`src/components/Sidebar.tsx` (`SwarmMark`); `brand/build.py` and `logo/mark.svg`
carry the identical coordinates.

- **The logo is the bare mark** — transparent, on any surface. The dark squircle
  tile is **app-icon only**; never wrap the bare mark in the tile in running content.
- **Monochrome, always.** Parchment on dark, ink on light. No accent color.

## Color

Warm monochrome, mirrored from `src/styles.css` (the app is the source of truth).

| Token       | Hex       | Use                                          |
|-------------|-----------|----------------------------------------------|
| parchment   | `#d8d4c8` | **default mark color on dark** (`--color-text`) |
| white       | `#f4f1e8` | warm white — only on busy/photographic surfaces |
| ink         | `#161512` | mark on light backgrounds                    |
| bg          | `#1c1b18` | app background / tile base                   |
| muted       | `#989484` | tagline / supporting text on dark            |
| surface 1–3 | `#232220` · `#2b2a26` · `#34322e` | UI surfaces                |

Tile / banner background is the app gradient `linear-gradient(180deg,#1f1e1b,#1c1b18 60%,#161512)`.

## Type

- **Wordmark:** `swarm`, lowercase, **Inter Bold**, tracking ≈ `-0.03em`, **outlined
  to paths** in the SVGs (font-independent — don't re-typeset it).
- **Supporting text** (tagline, captions): **Inter Medium**.

Inter is vendored under `fonts/` (Bold + Medium) with its OFL license (`fonts/OFL.txt`).

## Clear space & minimum size

- **Clear space:** keep ≥ one cap-diameter of empty space around the bare mark;
  ≥ the mark's height around a lockup.
- **Minimum size:** mark ≥ 16px; horizontal lockup ≥ 96px wide; stacked lockup ≥ 64px wide.

## Do & Don't

**Do** — parchment on dark / ink on light · let the mark breathe (it's the hero) ·
pair copy with Inter · use the provided SVGs.

**Don't** — no gradients, glow, or shadow on the mark · no rotation, skew, or stretch ·
no accent tint · don't put the bare mark on the squircle tile in running content ·
don't re-typeset the wordmark.

## Regenerating

```sh
python3 brand/build.py
```

Deterministic and offline — the mark is drawn from embedded coordinates, the
wordmark is outlined from the vendored Inter via `fontTools`, and rasters come from
`Pillow`. No SVG rasterizer, no system fonts, no network. This is the **single**
generator: it also refreshes the repo social-preview at `docs/banner.png`.

## License

Kit assets are **GPL-3.0-or-later**, like the rest of swarm. The bundled **Inter**
font is licensed separately under the SIL **OFL 1.1** (`fonts/OFL.txt`).
