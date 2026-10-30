/* Butterfly adapter for xiaojiaenen/liquid-glass, pinned at
 * d61ba1109a62f505b71f517470e8597e6dbfc268. The imported map generator and
 * tokens are the upstream code with types removed. SVG primitives mirror
 * LiquidGlassFilter.tsx. See /vendor/liquid-glass/NOTICE.md.
 *
 * Real lenses go on the floating chrome (nav, selection lenses, docks,
 * player), headers and every card. Cards have no pre-blur: crystal-clear
 * glass that bends and magnifies what is behind it at its rim. Reading
 * slabs (document-height) and anything nested inside a lens use the CSS
 * material (adapted from LGOS-Studio/LiquidGlass). */
import { generateLiquidGlassMaps } from '/vendor/liquid-glass/displacement-map.js';
import { glassPresets } from '/vendor/liquid-glass/tokens.js';
import { supportsSvgBackdrop } from '/vendor/liquid-glass/capabilities.js';

const root = document.documentElement;
if (root.dataset.liquidGlass !== 'upstream') {
  const READING = '.layout > div:first-child:not(#recent-posts):not(.nc)';
  const selector = [
    '#nav', '#nav .liquid-nav-indicator', '.liquid-tab-indicator',
    '#sidebar-menus', '#sidebar-menus .liquid-menu-indicator',
    '.recent-post-item', '#aside-content .card-widget', READING,
    '#page-header #post-info', '#page-header #page-site-info',
    '#footer .footer-other', '#rightside > div', '#aplayer .aplayer-body',
    '.search-dialog', '#nav .menus_item_child'
  ].join(',');

  // Optics per kind. `magnify` is a separate x/y magnification encoded in
  // one displacement stage. A selection pill has two optical layers: `pill`
  // (resting: a quiet bead over the selected label) and `lens` (lifted on
  // press and while it travels: the iOS 26 tab-bar lens, which magnifies the
  // labels it floats over and splits colour slightly at its rim).
  const KINDS = {
    pill: { ...glassPresets.pill, bezelWidth: 8, refractionScale: 0.8, magnify: { x: 1.04, y: 1.06 } },
    lens: {
      bezelWidth: 10, glassThickness: 64, refractionScale: 1.1, blur: 0, saturate: 1.12,
      magnify: { x: 1.16, y: 1.22 }, dispersion: 0.1, specular: 1.6
    },
    nav: { ...glassPresets.card, refractionScale: 1, magnify: { x: 1, y: 1.5 } },
    // Dock.tsx and GlassMusicPlayer.tsx; bezels are clamped to these radii.
    dock: { bezelWidth: 14, glassThickness: 90, refractionScale: 1, blur: 0.2, saturate: 1.2 },
    player: { bezelWidth: 30, glassThickness: 130, refractionScale: 1.1, blur: 0.2 },
    // Cards: many are on screen at once, so they use the lean chain (one
    // displacement pass; the rim light comes from the CSS material).
    card: { ...glassPresets.card, blur: 0, refractionScale: 1, lean: true },
    header: { ...glassPresets.card, blur: 0, refractionScale: 1 },
    control: { ...glassPresets.control, blur: 0 },
    reading: { css: true }
  };
  // Small floating surfaces whose specular rim follows the pointer.
  // The wide nav is excluded: each step would regenerate a 1200px map (~11ms).
  const PARALLAX = new Set(['pill', 'dock', 'player']);
  const DEFAULT_ANGLE = 60;
  const NS = 'http://www.w3.org/2000/svg';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const forcedColors = matchMedia('(forced-colors: active)');
  const svgBackdrop = supportsSvgBackdrop();
  const records = new Map();
  const visible = new Set();
  const pending = new Set();
  const filters = new Map(); // key -> { filter, refs }; equal surfaces share one
  const mapCache = new Map();
  let sequence = 0;
  let frame = 0;
  let glowFrame = 0;
  let pointer;
  let lastGlow;

  function svg(name, attributes = {}) {
    const element = document.createElementNS(NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  const filterSvg = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
  filterSvg.classList.add('lg-filter-definitions');
  const definitions = svg('defs');
  filterSvg.appendChild(definitions);

  function kindFor(element) {
    if (element.matches('.liquid-nav-indicator, .liquid-menu-indicator, .liquid-tab-indicator')) return 'pill';
    if (element.id === 'nav') return 'nav';
    if (element.matches('#rightside > div')) return 'dock';
    if (element.matches('#aplayer .aplayer-body')) return 'player';
    if (element.matches(READING)) return 'reading';
    if (element.matches('#post-info, #page-site-info')) return 'header';
    if (element.matches('#sidebar-menus, .search-dialog, .menus_item_child, .footer-other')) return 'control';
    return 'card';
  }

  // data-lg-magnify="x y" (or one number) overrides a kind's magnification.
  function magnifyFrom(value, fallback) {
    const [x, y] = String(value || '').trim().split(/\s+/).map(Number);
    if (!(x > 0)) return fallback;
    return { x, y: y > 0 ? y : x };
  }

  // Ramp for the magnification stage. One feDisplacementMap has a single
  // scale S = max(w(1-1/mx), h(1-1/my)), so each axis gets its own channel
  // amplitude: R falls from 128+127·ax to 128-127·ax left to right, G
  // likewise top to bottom; every pixel samples from nearer the centre. A
  // 32px image is stretched to the surface (bilinear keeps a ramp exact);
  // amplitudes are bucketed to 1/32 so pills of similar aspect share one.
  const ramps = new Map();
  function magnifyRamp(ax, ay) {
    const key = `${ax}:${ay}`;
    if (ramps.has(key)) return ramps.get(key);
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        image.data[i] = Math.round(128 + 127 * ax * (1 - 2 * (x + 0.5) / size));
        image.data[i + 1] = Math.round(128 + 127 * ay * (1 - 2 * (y + 0.5) / size));
        image.data[i + 2] = 128;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const url = canvas.toDataURL();
    ramps.set(key, url);
    return url;
  }

  const bucket = value => Math.round(value * 32) / 32;
  // feColorMatrix rows that keep one channel (alpha stays 1 for the sum).
  const KEEP = [
    '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
    '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
    '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
  ];

  function createFilter(id, maps, optics, magnify) {
    const filter = svg('filter', {
      id, x: '-50%', y: '-50%', width: '200%', height: '200%',
      'color-interpolation-filters': 'sRGB'
    });
    const add = (name, attributes) => filter.appendChild(svg(name, attributes));
    if (optics.lean) {
      // The refraction itself and nothing else: the bezel bends the backdrop.
      add('feImage', {
        href: maps.displacementUrl, x: 0, y: 0, width: maps.width, height: maps.height,
        result: 'displacement_map', preserveAspectRatio: 'none'
      });
      add('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'displacement_map',
        scale: (2 * optics.bezelWidth * optics.refractionScale).toFixed(2),
        xChannelSelector: 'R', yChannelSelector: 'G'
      });
      return filter;
    }
    let source = 'SourceGraphic';
    if (optics.blur > 0) {
      add('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: optics.blur, result: 'blurred' });
      source = 'blurred';
    }
    add('feImage', {
      href: maps.displacementUrl, x: 0, y: 0, width: maps.width, height: maps.height,
      result: 'displacement_map', preserveAspectRatio: 'none'
    });
    // Outside the feImage the map is transparent black, which would shift the
    // backdrop by -scale/2 while a surface is mid-resize. Neutral grey = no shift.
    add('feFlood', { 'flood-color': 'rgb(128,128,128)', result: 'neutral' });
    add('feComposite', { in: 'displacement_map', in2: 'neutral', operator: 'over', result: 'displacement_safe' });
    // A shift of ±size/2·(1 - 1/m) at the edges magnifies by m about the centre.
    const shiftX = maps.width * (1 - 1 / (magnify?.x || 1));
    const shiftY = maps.height * (1 - 1 / (magnify?.y || 1));
    const magnifyScale = Math.max(shiftX, shiftY);
    if (magnifyScale > 0.5) {
      add('feImage', {
        href: magnifyRamp(bucket(shiftX / magnifyScale), bucket(shiftY / magnifyScale)),
        x: 0, y: 0, width: maps.width, height: maps.height,
        result: 'magnify_map', preserveAspectRatio: 'none'
      });
      add('feComposite', { in: 'magnify_map', in2: 'neutral', operator: 'over', result: 'magnify_safe' });
      add('feDisplacementMap', {
        in: source, in2: 'magnify_safe', scale: magnifyScale.toFixed(2),
        xChannelSelector: 'R', yChannelSelector: 'G', result: 'magnified'
      });
      source = 'magnified';
    }
    const bend = 2 * optics.bezelWidth * optics.refractionScale;
    const displace = (scale, result) => add('feDisplacementMap', {
      in: source, in2: 'displacement_safe', scale: scale.toFixed(2),
      xChannelSelector: 'R', yChannelSelector: 'G', result
    });
    if (optics.dispersion) {
      // Rim dispersion: red bends a little less than green, blue a little
      // more; the three single-channel passes are summed back together.
      [1 - optics.dispersion, 1, 1 + optics.dispersion].forEach((k, i) => {
        displace(bend * k, `bent_${i}`);
        add('feColorMatrix', { in: `bent_${i}`, type: 'matrix', values: KEEP[i], result: `channel_${i}` });
      });
      add('feComposite', { in: 'channel_0', in2: 'channel_1', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'channels_01' });
      add('feComposite', { in: 'channels_01', in2: 'channel_2', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'displaced' });
    } else {
      displace(bend, 'displaced');
    }
    add('feColorMatrix', { in: 'displaced', type: 'saturate', values: optics.saturate ?? 1.3, result: 'displaced_saturated' });
    add('feImage', {
      href: maps.specularUrl, x: 0, y: 0, width: maps.width, height: maps.height,
      result: 'specular_layer', preserveAspectRatio: 'none'
    });
    let specular = 'specular_layer';
    if (optics.specular > 1) {
      const gain = add('feComponentTransfer', { in: 'specular_layer', result: 'specular_gain' });
      gain.appendChild(svg('feFuncA', { type: 'linear', slope: optics.specular }));
      specular = 'specular_gain';
    }
    add('feBlend', { in: specular, in2: 'displaced_saturated', mode: 'screen' });
    return filter;
  }

  // Each frame hands every lens's map bitmaps to the compositor again, so
  // scrolling costs in proportion to their pixels (measured on the home page:
  // 43 ms a frame at full size, 6 ms at a quarter). The displacement field is
  // smooth, so it is generated at 1/scale with every length scaled alike (the
  // normalised map is the same) and feImage stretches it back. The 1.5px
  // specular rim would smear, so it stays full size; lean surfaces have none.
  function mapScale(width, height, optics) {
    if (width * height < 20000) return 1;
    return Math.max(1, Math.min(4, Math.floor(optics.bezelWidth / 6)));
  }

  function mapsFor(width, height, radius, optics, angle) {
    const scale = mapScale(width, height, optics);
    const key = [width, height, radius.toFixed(1), optics.bezelWidth, optics.glassThickness,
      optics.lean ? 'lean' : angle].join(':');
    let maps = mapCache.get(key);
    if (maps) {
      mapCache.delete(key); // refresh LRU position
    } else {
      const generate = s => generateLiquidGlassMaps({
        width: width / s, height: height / s, radius: radius / s,
        bezelWidth: optics.bezelWidth / s, glassThickness: optics.glassThickness / s,
        refractiveIndex: 1.5, specularAngleDeg: angle, specularRimWidth: 1.5, profile: 'convex_squircle'
      });
      const small = generate(scale);
      let specularUrl = '';
      if (!optics.lean) specularUrl = scale === 1 ? small.specularUrl : generate(1).specularUrl;
      // width/height are the surface's: feImage stretches the map to them.
      maps = { displacementUrl: small.displacementUrl, specularUrl, width, height };
      // Encoded maps only, bounded; parallax revisits up to 12 angles.
      if (mapCache.size >= 96) mapCache.delete(mapCache.keys().next().value);
    }
    mapCache.set(key, maps);
    return maps;
  }

  function release(slot) {
    const entry = slot.key && filters.get(slot.key);
    slot.key = '';
    if (entry && --entry.refs <= 0) {
      entry.filter.remove();
      filters.delete(entry.key);
    }
  }

  function useMaterial(record, renderer) {
    record.slots.forEach(slot => {
      release(slot);
      slot.layer.style.removeProperty('--lg-filter');
    });
    record.element.classList.remove('is-glass');
    record.element.classList.add('is-fallback');
    record.element.dataset.lgRenderer = renderer;
  }

  function render(record) {
    const { element, slots } = record;
    if (!element.isConnected || !visible.has(element)) return;
    const base = slots[0];
    if (base.optics.css || !svgBackdrop || forcedColors.matches) {
      useMaterial(record, base.optics.css ? 'css-material' : 'css-fallback');
      return;
    }
    // Layout size, not the transformed rect: hover lifts, the lens lift and
    // its travel (all transforms) must not resize the map.
    const width = Math.ceil(base.layer.offsetWidth);
    const height = Math.ceil(base.layer.offsetHeight);
    if (width < 2 || height < 2) return;
    // Huge surfaces exceed practical texture sizes and block the main thread.
    if (width * height > 4000000 || height > 4000 || width > 4096) {
      useMaterial(record, 'large-surface-fallback');
      return;
    }
    const parsed = parseFloat(getComputedStyle(base.layer).borderTopLeftRadius);
    const radius = Math.min(Number.isFinite(parsed) ? parsed : 24, width / 2, height / 2);
    try {
      slots.forEach(slot => {
        const key = [width, height, radius.toFixed(1), slot.name, record.angle,
          slot.magnify ? `${slot.magnify.x}x${slot.magnify.y}` : '1'].join(':');
        if (slot.key === key) return;
        let entry = filters.get(key);
        if (!entry) {
          const maps = mapsFor(width, height, radius, slot.optics, record.angle);
          const id = `lg-upstream-${++sequence}`;
          entry = { key, id, refs: 0, filter: createFilter(id, maps, slot.optics, slot.magnify) };
          definitions.appendChild(entry.filter);
          filters.set(key, entry);
        }
        entry.refs++;
        release(slot);
        slot.key = key;
        slot.layer.style.setProperty('--lg-filter', `url("#${entry.id}")`);
      });
      element.classList.remove('is-fallback');
      element.classList.add('is-glass');
      element.dataset.lgRenderer = 'upstream-svg';
    } catch (error) {
      useMaterial(record, 'css-fallback');
      console.warn('Liquid Glass: using the CSS material for this surface.', error);
    }
  }

  function flush() {
    frame = 0;
    // Spend at most ~8ms per frame so a page full of cards doesn't jank.
    const start = performance.now();
    for (const element of pending) {
      pending.delete(element);
      const record = records.get(element);
      if (record) render(record);
      if (performance.now() - start > 8) break;
    }
    if (pending.size) frame = requestAnimationFrame(flush);
    // Lets a page switch lift its veil once the new surfaces have their glass.
    else document.dispatchEvent(new CustomEvent('liquid-glass:idle'));
  }

  function schedule(element) {
    if (!visible.has(element)) return;
    pending.add(element);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  // Zero-area edge contacts (the closed drawer parked just off-screen) count
  // as intersecting, so require a positive ratio.
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio > 0) {
        visible.add(entry.target);
        schedule(entry.target);
      } else {
        visible.delete(entry.target);
        pending.delete(entry.target);
      }
    });
  }, { rootMargin: '100px 0px' }) : null;

  // A selection lens is resized once per move (its travel is a transform),
  // so it re-fits at the next frame; larger surfaces debounce.
  const ro = new ResizeObserver(entries => entries.forEach(entry => {
    const record = records.get(entry.target);
    if (!record) return;
    clearTimeout(record.timer);
    if (record.kind === 'pill') schedule(entry.target);
    else record.timer = setTimeout(() => schedule(entry.target), 100);
  }));

  function opticalLayer(className) {
    const layer = document.createElement('span');
    layer.className = className;
    layer.setAttribute('aria-hidden', 'true');
    return layer;
  }

  function refresh() {
    records.forEach((record, element) => {
      if (element.isConnected) return;
      clearTimeout(record.timer);
      ro.unobserve(element);
      io?.unobserve(element);
      record.slots.forEach(release);
      visible.delete(element);
      pending.delete(element);
      records.delete(element);
    });
    // Read every computed position before the first DOM write.
    const fresh = Array.from(document.querySelectorAll(selector))
      .filter(element => !records.has(element))
      .map(element => ({ element, static: getComputedStyle(element).position === 'static' }));
    fresh.forEach(({ element, static: isStatic }) => {
      const kind = kindFor(element);
      element.classList.add('lg-surface', 'has-border-glow', 'is-fallback');
      element.dataset.lgKind = kind;
      element.dataset.lgRenderer = 'css-fallback';
      if (isStatic) element.classList.add('lg-positioned');
      const layer = opticalLayer('lg-optical-layer');
      element.prepend(layer);
      const optics = KINDS[kind];
      const slots = [{ name: kind, layer, optics, magnify: magnifyFrom(element.dataset.lgMagnify, optics.magnify), key: '' }];
      if (kind === 'pill') {
        // Lifted optics on a second layer, cross-faded by CSS (.is-lifted).
        const lens = opticalLayer('lg-lens-layer');
        layer.after(lens);
        slots.push({ name: 'lens', layer: lens, optics: KINDS.lens, magnify: magnifyFrom(element.dataset.lgLensMagnify, KINDS.lens.magnify), key: '' });
      }
      const glow = opticalLayer('border-glow-effect');
      element.appendChild(glow);
      records.set(element, { element, slots, glow, kind, angle: DEFAULT_ANGLE, timer: 0 });
      io?.observe(element);
      ro.observe(element);
      if (!io) {
        visible.add(element);
        schedule(element);
      }
    });
  }

  function aim(record, angle) {
    if (record.angle === angle) return;
    record.angle = angle;
    schedule(record.element);
  }

  function paintGlow() {
    glowFrame = 0;
    if (!pointer || reducedMotion.matches) return;
    const element = pointer.target.closest('.lg-surface');
    const record = element && records.get(element);
    if (lastGlow && lastGlow !== record) {
      lastGlow.glow.style.setProperty('--border-glow-proximity', '0');
      aim(lastGlow, DEFAULT_ANGLE);
    }
    lastGlow = record;
    if (!record) return;
    const rect = element.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = pointer.x - rect.left - cx;
    const dy = pointer.y - rect.top - cy;
    // Same edge proximity and cursor angle as upstream useBorderGlow. The
    // values go on the glow span itself: custom properties inherit, and
    // writing them on the surface would restyle its whole subtree per frame.
    const kx = dx !== 0 ? cx / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? cy / Math.abs(dy) : Infinity;
    const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;
    record.glow.style.setProperty('--border-glow-proximity', (edge * 100).toFixed(3));
    record.glow.style.setProperty('--border-glow-angle', `${angle.toFixed(3)}deg`);
    if (PARALLAX.has(record.kind)) {
      // useGlassParallax measures y-down, but the specular map is y-up, which
      // mirrors the light on diagonals upstream. Negate dy; the map takes
      // |cos|, so 0-180° covers every direction. 15° steps -> 12 cached maps.
      const light = ((Math.atan2(-dy, dx) * 180 / Math.PI) % 180 + 180) % 180;
      aim(record, (Math.round(light / 15) * 15) % 180);
    }
  }

  function boot() {
    root.dataset.liquidGlass = 'upstream';
    root.dataset.liquidGlassSource = 'd61ba1109a62';
    document.body.appendChild(filterSvg);
    if (!document.getElementById('web_bg')) {
      const background = document.createElement('div');
      background.id = 'web_bg';
      background.setAttribute('aria-hidden', 'true');
      document.body.prepend(background);
    }
    refresh();
    document.addEventListener('pjax:complete', refresh);
    document.addEventListener('liquid-glass:refresh', refresh);
    document.addEventListener('pointermove', event => {
      if (!(event.target instanceof Element) || event.pointerType === 'touch') return;
      pointer = { target: event.target, x: event.clientX, y: event.clientY };
      if (!glowFrame) glowFrame = requestAnimationFrame(paintGlow);
    }, { passive: true });
    document.addEventListener('pointerout', event => {
      if (event.relatedTarget || !lastGlow) return;
      lastGlow.glow.style.setProperty('--border-glow-proximity', '0');
      aim(lastGlow, DEFAULT_ANGLE);
      lastGlow = null;
      pointer = null;
    }, { passive: true });
    forcedColors.addEventListener('change', () => visible.forEach(schedule));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
