# Vendored Liquid Glass sources

Upstream project: [xiaojiaenen/liquid-glass](https://github.com/xiaojiaenen/liquid-glass)

Pinned revision: `d61ba1109a62f505b71f517470e8597e6dbfc268`

Package: `@xiaojiaenen/liquid-glass`, version `0.1.4` at this revision.

## License declaration and attribution

The upstream `package.json` declares `"license": "MIT"`, and the upstream README's License section states `MIT`. The pinned repository does not contain a `LICENSE` file. This directory preserves the original source comments and package metadata; no copyright holder or missing license text has been invented. Consult the upstream project for the complete license notice if one is supplied subsequently.

The original displacement generator explicitly credits `github.com/Bhavya-Goswami/liquid-glass`; that attribution remains in both the original TypeScript and the browser JavaScript.

## Unmodified source resources

The following files under `upstream/` are byte-for-byte copies from the pinned revision:

- [`displacementMap.ts`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/displacementMap.ts)
- [`tokens.ts`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/tokens.ts)
- [`capabilities.ts`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/capabilities.ts)
- [`LiquidGlass.css`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/LiquidGlass.css)
- [`BorderGlow.css`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/BorderGlow.css)
- [`LiquidGlassFilter.tsx`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/src/lib/LiquidGlassFilter.tsx)
- [`package.json`](https://github.com/xiaojiaenen/liquid-glass/blob/d61ba1109a62f505b71f517470e8597e6dbfc268/package.json)

The root `LiquidGlass.css` and `BorderGlow.css` are additional byte-identical copies for direct stylesheet loading.

## Browser ES modules

`displacement-map.js`, `tokens.js`, and `capabilities.js` were generated directly from their corresponding original TypeScript files using Node.js 24.11.1's built-in `stripTypeScriptTypes` with `{ mode: 'strip' }`. Only type syntax was removed; executable expressions, numerical constants, comments, map generation, presets, and capability detection remain unchanged. A provenance comment was prepended to each generated module.

One deliberate deviation: `imageDataToDataURL` in `displacement-map.js` requests `getContext('2d', { willReadFrequently: true })` instead of `getContext('2d')`. The pixels and the encoded PNG are identical; only the canvas is CPU-backed, which avoids GPU canvas initialisation and a readback on every `toDataURL` (first map about 160 ms down to about 19 ms in testing). The upstream copy in `upstream/` is unchanged.

These modules have no runtime framework dependency. The surrounding blog integration is maintained separately from these vendored files.

```js
import { generateLiquidGlassMaps } from '/vendor/liquid-glass/displacement-map.js';
import { glassPresets } from '/vendor/liquid-glass/tokens.js';
import { supportsSvgBackdrop } from '/vendor/liquid-glass/capabilities.js';
```

The React SVG component is retained as an unmodified source resource. The blog adapter creates the equivalent SVG DOM chain without introducing a React layout wrapper.
