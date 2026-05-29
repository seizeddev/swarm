# Swarm Logo Kit — Design

Date: 2026-05-29
Status: approved (brainstorm)

## Goal

A complete, self-contained brand/logo kit for Swarm — "everything drum und dran":
mark, wordmark, lockups, app-icon master, favicons, social banner, palette, and a
written brand guide, all generated from one reproducible source and reviewable on a
single contact-sheet page.

## Locked decisions

- **Tagline:** `Mission control for your coding agents.`
  - Rationale: owns *command/oversight of many agents* — differentiated from cmux
    ("the terminal built for coding agents") and Warp ("ship better software with any
    agent"). The built-in PR/git view makes "mission control" literal.
- **Mark:** the existing **burst** — 8 blades (triangular tip + round cap) in 8-fold
  rotational symmetry around a center hole. Canonical geometry is the `SwarmMark`
  vector in `src/components/Sidebar.tsx` (viewBox `0 0 100 100`). The kit does **not**
  redesign the mark.
- **Wordmark:** `swarm` (lowercase) in **Inter Bold**, tracking ≈ `-0.03em`, outlined
  to SVG paths so the wordmark is font-independent. Inter is OFL → vendored.
- **Logo = bare mark**, transparent, monochrome. The dark squircle tile is **app-icon
  only**, never part of the logo.
- **Finish:** strictly monochrome, flat — no glow, no accent color. Matches the app's
  deliberate restraint.
- **Banner:** centered layout, warm palette, new tagline, **no** meta line
  (the old "Rust core · no Electron · macOS / Linux / Windows" line is dropped).

## Color

Warm monochrome, mirrored from `src/styles.css` (the app is the source of truth).

| Token        | Hex         | Use                                   |
|--------------|-------------|---------------------------------------|
| parchment    | `#d8d4c8`   | **default mark/logo color on dark** (= app `--color-text`) |
| white (warm) | `#f4f1e8`   | high-contrast mark on photos/busy bg  |
| ink          | `#161512`   | mark/logo on light backgrounds        |
| bg           | `#1c1b18`   | app background / tile base            |
| bg-gradient  | `linear-gradient(180deg,#1f1e1b 0%,#1c1b18 60%,#161512 100%)` | banner / tile |
| muted        | `#989484`   | tagline on dark                       |
| faint        | `#8a8674`   | secondary meta                        |
| surface-1/2/3| `#232220` / `#2b2a26` / `#34322e` | swatch sheet reference |

App-icon tile burst uses a brighter parchment-white (`#ece8dc`) as today, for icon legibility.

## Deliverables (`brand/`)

```
brand/
  README.md            Brand guide: clear-space, min-size, color, font, tagline, voice, do/don't
  index.html           Contact sheet — renders the whole kit on one page (open in browser)
  build.py             THE single generator: rasters + wordmark outlines, from mark coords + Inter
  fonts/
    Inter-Bold.ttf      vendored (OFL)
    OFL.txt             Inter license
  logo/
    mark.svg            currentColor master (transparent)
    mark-parchment.svg  #d8d4c8
    mark-white.svg      #f4f1e8
    mark-ink.svg        #161512
    wordmark.svg        currentColor (Inter outlined)
    wordmark-parchment.svg
    wordmark-ink.svg
    lockup-horizontal.svg        mark + wordmark (currentColor)
    lockup-horizontal-ink.svg
    lockup-stacked.svg
    lockup-stacked-ink.svg
    mark.png / mark@2x.png        parchment, transparent (raster fallback)
    lockup-horizontal.png         parchment on transparent
    lockup-horizontal-ink.png     ink on transparent
  icon/
    app-icon.svg        mark on dark squircle tile (master)
    app-icon-1024.png
    favicon.svg         mark, adapts via prefers-color-scheme (parchment on dark tabs, ink on light)
    favicon-16.png  favicon-32.png  favicon-48.png
    favicon.ico         multi-size (16/32/48)
    apple-touch-icon.png  180×180 on tile
  social/
    banner.png          1280×640, centered  (also written to docs/banner.png)
    og-image.png        1200×630, centered
  palette/
    palette.css         documented brand tokens
    palette.svg         swatch sheet
```

## Build approach

- **One generator, one geometry source.** `brand/build.py` holds the mark blade/cap
  coordinates (same set `docs/make_banner.py` used) and emits every raster + the
  generated SVGs from them. The hand-authored `mark.svg` carries the identical
  coordinates; a comment in both `build.py` and `src/components/Sidebar.tsx` cross-links
  them so the three copies stay in sync. (We do not refactor the app to import a shared
  source — out of scope, risky.)
- **Mark rasterization via PIL** (polygons + circles, supersampled + LANCZOS), no SVG
  rasterizer needed. Proven by the existing `make_banner.py`.
- **Wordmark outlining via fontTools**: load vendored Inter-Bold, extract glyph outlines
  for `s w a r m`, apply `-0.03em` tracking, emit `<path>` data → `wordmark.svg`. PIL
  renders the same TTF for PNG lockups so vector and raster match.
- **Favicon/icon sizes** via PIL resize; `favicon.ico` via PIL multi-size save.
  `apple-touch-icon` and `app-icon-1024` are the mark composited on the squircle tile.

## Repo integration (approved)

- **Consolidate the banner generator.** `brand/build.py` becomes the single banner
  source and writes the refreshed banner to both `brand/social/banner.png` and
  `docs/banner.png`. **Remove `docs/make_banner.py`** and update the CLAUDE.md "Assets"
  note to point at `brand/build.py`.
- **Do not touch shipped app icons.** `src-tauri/icons/*` (`.icns`/`.ico`/iOS set) stay
  as-is; the kit ships the `app-icon.svg` master + a 1024 PNG only.
- **Wiring stays minimal.** Add `brand/` + `brand/README.md`; update the CLAUDE.md
  Assets note. The main `README.md` is **not** modified.

## Brand-guide rules (for README.md)

- **Clear space:** ≥ 1× cap-diameter around the bare mark; ≥ mark-height around lockups.
- **Min size:** mark 16px (favicon floor); horizontal lockup ≥ 96px wide;
  stacked lockup ≥ 64px wide.
- **Color usage:** parchment on dark (default), ink on light, warm-white only when a
  surface is busy/photographic. Never recolor the mark outside these.
- **Don'ts:** no gradients/glow/shadow on the mark; no rotation/skew/stretch; no accent
  tint; don't place the bare mark on the squircle tile in running text (tile = icon only);
  don't re-typeset the wordmark in another font (use the outlined SVG).
- **Font:** Inter (OFL) for wordmark + supporting type. Mono meta (where used): the app's
  mono stack.
- **Voice:** terse, confident, technical. Lowercase "swarm" in the wordmark.

## Acceptance criteria

1. `python3 brand/build.py` regenerates **all** rasters + generated SVGs deterministically
   from the vendored font + embedded coordinates, with **no network and no system fonts**.
2. Every new file carries the SPDX header (`GPL-3.0-or-later`; `/* */` for CSS); Inter
   keeps its own OFL.txt.
3. `brand/index.html` opens in a browser and shows the full kit: mark variants (on dark
   + on light), wordmark, both lockups, app-icon + favicon, banner + og-image, palette
   swatches, clear-space/min-size diagram, font specimen, tagline, do/don'ts.
4. The hand-authored `mark.svg` renders pixel-identical to the PIL-drawn mark and to the
   in-app `SwarmMark`.
5. `docs/banner.png` is refreshed (warm, new tagline, no meta line); `docs/make_banner.py`
   is gone; the CLAUDE.md Assets note matches reality.
6. The bare mark never appears on the squircle tile outside `icon/`.

## Out of scope

- Redesigning the mark.
- Regenerating the shipped Tauri icon set.
- Animated/motion logo.
- README changes beyond the kit + CLAUDE.md Assets note.
