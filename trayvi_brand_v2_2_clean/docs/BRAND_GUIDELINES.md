# Trayvi Brand Kit v2.2

**Status:** PROVISIONAL — cleaned candidate pending owner approval and legal review.

## Master assets

Use SVG masters. PNG files are generated exports and must not be edited as source artwork.

- Use `trayvi-logo-horizontal.svg` on light or transparent backgrounds.
- Use `trayvi-logo-horizontal-dark-bg.svg` when a fixed navy panel is appropriate.
- Use `trayvi-symbol.svg` where the horizontal lockup has insufficient room.
- Use monochrome dark only on light backgrounds and monochrome light only on dark backgrounds.
- Use `trayvi-app-icon.svg` as full-bleed source artwork; do not add a second rounded mask before platform export.

## Colors

- Primary Teal `#10BFA5`
- Midnight Navy `#0B1623`
- White `#FFFFFF`
- Orange Accent `#FF9F43`
- Cloud Background `#F7FAFC`
- Action Blue / Route `#3478F6`
- Graphite `#182230`

Brand colors are not automatically accessible semantic colors. Follow the main project `docs/design/DESIGN_TOKENS.md` guidance.

## Typeface

Manrope remains a provisional UI recommendation only. No font files or license are bundled. The TRAYVI wordmark is vector geometry and has no font dependency.

## Clear space and minimum size

Until optical tests establish a final rule, preserve clear space around the mark equal to at least the orange destination ring's outer diameter.

Provisional minimums:

- Horizontal lockup: 160 CSS px wide on screen.
- Standalone symbol: 32 CSS px square-equivalent on screen.
- Below these sizes, use a separately tested simplified micro-mark; do not force the full route detail to remain visible.

These are candidate limits, not final print specifications.

## Rules

- Do not stretch, skew, rotate, outline, or rearrange the mark.
- Do not retype the wordmark.
- Do not recolor outside the supplied variants.
- Do not add gradients, shadows, glows, borders, or effects to master SVGs.
- Do not place the standard navy variant on a dark background; use the light/dark-background variant.
- Do not place the mark over visually busy imagery without a controlled surface.
- Keep SVG files free of scripts, remote references, embedded raster images, and font dependencies.

## Accessibility

Provide the accessible product name in the host application. Inline informative SVG may expose its title; decorative instances must be hidden from assistive technology to avoid duplicate announcements. The logo does not replace a page heading or textual product name where clarity requires text.

## Before production approval

- Owner comparison and approval against the original concept.
- Small-size optical correction and platform icon previews.
- Final clear-space/minimum-size specification.
- Trademark, originality, and ownership review.
- App-store export matrix and Android adaptive foreground/background layers.
- Print color specifications if physical use is planned.
