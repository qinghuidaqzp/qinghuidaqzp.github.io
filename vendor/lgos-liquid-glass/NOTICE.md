# Vendored LGOS Liquid Glass

Upstream project: [LGOS-Studio/LiquidGlass](https://github.com/LGOS-Studio/LiquidGlass)

Pinned revision: `49e6e609e32c68f3a8f58eb0e04eae2f567b8ee9`

License: MIT, Copyright (c) 2026 SYSTEM-NTDEV-PRO (LGOS Studio). The full text is in [`LICENSE`](./LICENSE), copied unmodified from the pinned revision.

## Files

- [`liquid-glass.css`](https://github.com/LGOS-Studio/LiquidGlass/blob/49e6e609e32c68f3a8f58eb0e04eae2f567b8ee9/liquid-glass.css): byte-for-byte copy, kept for reference. It is not loaded directly, because its `.liquid` class sets `display`, `padding`, `min-height` and `overflow: hidden`, which would change Butterfly's layout.

## How the blog uses it

`/css/liquid-glass.css` ports the LGOS material recipe (double hairline border, two diagonal inset rim highlights, inner shade, and the blurred, downward-offset inner ring that reads as glass thickness) onto the decorative `.lg-optical-layer` child that every glass surface already has. Text and links stay outside that layer, so nothing about the theme's layout changes.
