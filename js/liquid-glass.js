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
    // The approved nav (2026-10-29): rim refraction only. A later 1.5x
    // vertical magnification over-stretched the text passing under it.
    nav: { ...glassPresets.card, refractionScale: 1 },
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
  // Safari and every iOS browser are WebKit: no SVG backdrop filters. The
  // vendored UA test lets iOS Edge ("EdgiOS") through, so check here too.
  // ?lg-mirror previews the WebKit path in Chromium.
  const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
  const svgBackdrop = supportsSvgBackdrop() && !webkit && !new URLSearchParams(location.search).has('lg-mirror');
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
  // 43 ms a frame at full size, 6 ms at a quarter). Cards are most of those
  // pixels and their lean bezel survives a map generated at 1/scale (every
  // length scaled alike, so the normalised map is the same) and stretched
  // back by feImage. The nav and other chrome keep full-size maps: there a
  // coarse map visibly softens the rim and the magnified band.
  function mapScale(width, height, optics) {
    if (!optics.lean || width * height < 20000) return 1;
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

  // --- Nav mirror (WebKit) -------------------------------------------------
  // WebKit cannot use an SVG filter as a backdrop, but it can filter an
  // element's own content. So on phones without SVG backdrops the nav
  // refracts a mirror: a copy of the page (in a shadow root, so ids and
  // document queries stay unique), kept in register with the real page as it
  // scrolls, clipped to the nav and run through the nav's lens.
  //
  // WebKit runs that filter on the CPU, and re-running it every scroll frame
  // stuttered on a real iPhone even at its leanest. So the lens rests: while
  // the page scrolls the mirror is hidden and the nav is plain clear glass
  // (scrolling stays on the system's fast path); once scrolling stops the
  // mirror is placed and fades in, so the filter runs once per stop.
  // It is also kept cheap: the lens is the displacement pass alone (the rim
  // light is the CSS material's), the copy is moved by a transform, and
  // nothing inside it animates, blurs or blends. A full rebuild clones the
  // page, so it only runs when scrolling is quiet; lazy images sync in place.
  const XLINK = 'http://www.w3.org/1999/xlink';
  const MIRROR_BLANK = 'iframe, video, audio, canvas, embed, object';
  const MIRROR_STRIP = '#nav, #rightside, #sidebar, .search-dialog, #search-mask, script, noscript';
  // Every effect inside the copy would be re-rendered inside the software
  // filter each frame; under a 60px lens they are not visible anyway.
  const MIRROR_CALM = `*, *::before, *::after {
    animation: none !important; transition: none !important; filter: none !important;
    -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
    mix-blend-mode: normal !important; will-change: auto !important;
  }
  .lg-optical-layer::before, .border-glow-effect, .saul-noise { display: none !important; }`;
  // What scrolls under the nav: the poster and the page.
  const MIRROR_SOURCES = ['saul-intro', 'body-wrap'];
  const MIRROR_QUIET = 800; // ms after the last scroll before a rebuild may run
  const MIRROR_SETTLE = 150; // ms after the last scroll before the lens returns
  let mirror = null;
  let mirrorTimer = 0;
  let settleTimer = 0;
  let mirrorObserver = null;
  let lastScroll = 0;

  function placeMirror() {
    if (!mirror?.copies) return;
    const nav = mirror.host.parentElement;
    if (!nav) return;
    const n = nav.getBoundingClientRect();
    mirror.copies.forEach(({ original, copy }) => {
      const p = original.getBoundingClientRect();
      copy.style.transform = `translate(${p.left - n.left}px, ${p.top - n.top}px)`;
    });
    const view = `${-n.left}:${-n.top}:${innerWidth}:${innerHeight}`;
    if (mirror.view === view) return;
    mirror.view = view;
    mirror.backdrop.style.setProperty('left', `${-n.left}px`, 'important');
    mirror.backdrop.style.setProperty('top', `${-n.top}px`, 'important');
    mirror.backdrop.style.setProperty('width', `${innerWidth}px`, 'important');
    mirror.backdrop.style.setProperty('height', `${innerHeight}px`, 'important');
  }

  function mirrorHost(nav) {
    if (mirror?.host.parentElement === nav) return mirror;
    mirror?.host.remove();
    const host = document.createElement('div');
    host.className = 'lg-nav-mirror';
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    const root = host.attachShadow({ mode: 'open' });
    // The page's own stylesheets (cached), so the copy lays out as the page.
    const sheets = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))
      .map(node => node.cloneNode(true));
    const calm = document.createElement('style');
    calm.textContent = MIRROR_CALM;
    root.append(...sheets, calm);
    const loaded = Promise.all(sheets.filter(sheet => sheet.tagName === 'LINK')
      .map(link => new Promise(done => { link.onload = link.onerror = done; })));
    const layer = nav.querySelector(':scope > .lg-optical-layer');
    if (layer) layer.after(host);
    else nav.prepend(host);
    nav.classList.add('lg-mirrored');
    mirror = { host, root, loaded, key: '', view: '', mapImages: [], filter: null, shell: null, copies: null, backdrop: null };
    return mirror;
  }

  function copyForMirror(original) {
    // Embeds would load twice and canvases copy blank: keep their boxes only.
    const blanks = Array.from(original.querySelectorAll(MIRROR_BLANK));
    const copy = original.cloneNode(true);
    // Image pairs, so lazy loading can be mirrored without a rebuild.
    const media = new Map();
    const copied = copy.querySelectorAll('img, source');
    original.querySelectorAll('img, source').forEach((element, i) => media.set(element, copied[i]));
    copy.querySelectorAll(MIRROR_BLANK).forEach((node, i) => {
      const box = document.createElement('div');
      const source = blanks[i];
      box.style.cssText = `display:${source ? getComputedStyle(source).display : 'block'};` +
        `width:${source?.offsetWidth || 0}px;height:${source?.offsetHeight || 0}px`;
      node.replaceWith(box);
    });
    copy.querySelectorAll(MIRROR_STRIP).forEach(node => node.remove());
    copy.style.setProperty('position', 'absolute', 'important');
    copy.style.setProperty('left', '0', 'important');
    copy.style.setProperty('top', '0', 'important');
    copy.style.setProperty('margin', '0', 'important');
    copy.style.setProperty('width', `${original.offsetWidth}px`, 'important');
    copy.style.setProperty('height', `${original.offsetHeight}px`, 'important');
    return { original, copy, media };
  }

  function buildMirror() {
    clearTimeout(mirrorTimer);
    const nav = document.getElementById('nav');
    const sources = MIRROR_SOURCES.map(id => document.getElementById(id)).filter(Boolean);
    if (!nav || !sources.length) return;
    const state = mirrorHost(nav);
    const copies = sources.map(copyForMirror);
    const backdrop = document.getElementById('web_bg')?.cloneNode(true) || document.createElement('div');
    backdrop.style.setProperty('position', 'absolute', 'important');
    backdrop.style.setProperty('inset', 'auto', 'important');
    // Inside the shadow root the copy inherits from the nav, not from body.
    const body = getComputedStyle(document.body);
    const shell = document.createElement('div');
    shell.style.cssText = 'all:initial;display:block;position:absolute;left:0;top:0;';
    ['font-family', 'font-size', 'color', 'letter-spacing', 'word-break', '-webkit-font-smoothing']
      .forEach(name => shell.style.setProperty(name, body.getPropertyValue(name)));
    // Computed line-height is in px; children must inherit body's ratio.
    const lineHeight = parseFloat(body.lineHeight) / parseFloat(body.fontSize);
    shell.style.setProperty('line-height', Number.isFinite(lineHeight) ? lineHeight.toFixed(4) : 'normal');
    shell.append(backdrop, ...copies.map(entry => entry.copy));
    state.shell?.remove();
    state.root.append(shell);
    Object.assign(state, { shell, copies, backdrop, view: '' });

    const width = nav.offsetWidth;
    const height = nav.offsetHeight;
    const parsed = parseFloat(getComputedStyle(nav).borderTopLeftRadius);
    const radius = Math.min(Number.isFinite(parsed) ? parsed : height / 2, width / 2, height / 2);
    const key = `${width}x${height}:${radius.toFixed(1)}`;
    if (width > 1 && height > 1 && state.key !== key) {
      state.filter?.remove();
      state.mapImages.forEach(image => image.remove());
      state.mapImages = [];
      // The nav's full-size map, through the lean chain (displacement only).
      const maps = mapsFor(width, height, radius, KINDS.nav, DEFAULT_ANGLE);
      const filter = createFilter(`lg-mirror-${++sequence}`, maps, { ...KINDS.nav, lean: true });
      // The lens only pulls inward, so the input never needs to reach past
      // the nav: the smallest region keeps WebKit's software filter cheap.
      filter.setAttribute('x', '0');
      filter.setAttribute('y', '0');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      filter.querySelectorAll('feImage').forEach((image, i) => {
        const href = image.getAttribute('href');
        if (!webkit) {
          image.setAttributeNS(XLINK, 'xlink:href', href);
          return;
        }
        // WebKit renders nothing for an feImage with a data: URL in a filter
        // on HTML content, but it renders an in-page <image> referenced by id.
        const source = svg('image', {
          id: `${filter.id}-map-${i}`, x: 0, y: 0, width: image.getAttribute('width'),
          height: image.getAttribute('height'), preserveAspectRatio: 'none', href
        });
        source.setAttributeNS(XLINK, 'xlink:href', href);
        definitions.appendChild(source);
        state.mapImages.push(source);
        ['x', 'y', 'width', 'height', 'preserveAspectRatio'].forEach(name => image.removeAttribute(name));
        image.setAttribute('href', `#${source.id}`);
        image.setAttributeNS(XLINK, 'xlink:href', `#${source.id}`);
      });
      definitions.appendChild(filter);
      state.filter = filter;
      state.key = key;
      state.host.style.setProperty('--lg-mirror-filter', `url("#${filter.id}")`);
      state.host.style.setProperty('--lg-mirror-radius', `${radius}px`);
    }
    placeMirror();
    state.loaded.then(() => {
      if (state.copies === copies) state.host.classList.add('is-ready');
    });
  }

  // A rebuild clones the whole page: wait until scrolling has been quiet.
  function scheduleMirror(delay = 600) {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
      const quiet = performance.now() - lastScroll;
      if (quiet < MIRROR_QUIET) scheduleMirror(MIRROR_QUIET - quiet);
      else buildMirror();
    }, delay);
  }

  // Lazy images are copied across in place; other content changes (Douban
  // lists, a pjax swap) rebuild. Engine bookkeeping (classes, glow) is ignored.
  function onMirrorMutations(records) {
    let rebuild = false;
    for (const record of records) {
      if (record.type !== 'attributes') {
        rebuild = true;
        continue;
      }
      const twin = mirror?.copies?.map(entry => entry.media.get(record.target)).find(Boolean);
      if (!twin) continue;
      const value = record.target.getAttribute(record.attributeName);
      if (value == null) twin.removeAttribute(record.attributeName);
      else twin.setAttribute(record.attributeName, value);
    }
    if (rebuild) scheduleMirror();
  }

  function watchMirror() {
    mirrorObserver ??= new MutationObserver(onMirrorMutations);
    mirrorObserver.disconnect();
    MIRROR_SOURCES.map(id => document.getElementById(id)).filter(Boolean).forEach(source => mirrorObserver.observe(source, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset']
    }));
  }

  // Scrolling hides the lens at once; it comes back placed once quiet. On
  // iOS the page scrolls before the page's script hears about it, so a moving
  // finger hides the lens too, before the first scrolled frame shows a stale
  // copy; momentum after the finger lifts keeps it hidden until it stops.
  function hideLens() {
    lastScroll = performance.now();
    mirror?.host.classList.add('is-scrolling');
    clearTimeout(settleTimer);
  }

  function settleLens() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!mirror?.copies) return;
      placeMirror();
      mirror.host.classList.remove('is-scrolling');
    }, MIRROR_SETTLE);
  }

  function onMirrorScroll() {
    hideLens();
    settleLens();
  }

  function startMirror() {
    // Nothing is copied while the page is still loading; the first build
    // waits for a quiet moment after load.
    watchMirror();
    window.addEventListener('scroll', onMirrorScroll, { passive: true });
    window.addEventListener('touchmove', hideLens, { passive: true });
    window.addEventListener('touchend', settleLens, { passive: true });
    window.addEventListener('touchcancel', settleLens, { passive: true });
    window.addEventListener('resize', () => { placeMirror(); scheduleMirror(200); }, { passive: true });
    if (document.readyState === 'complete') scheduleMirror(600);
    else window.addEventListener('load', () => scheduleMirror(600), { once: true });
    document.addEventListener('pjax:send', () => mirror?.host.classList.remove('is-ready'));
    document.addEventListener('pjax:complete', () => { watchMirror(); scheduleMirror(450); });
  }

  // --- Flowing backdrop -------------------------------------------------------
  // The page backdrop (computers and phones): a soft pastel gradient crossed
  // by thin lines that flow slowly, drawn by a WebGL shader in #web_bg. Glass
  // only shows its bend where there is detail behind it; the lines give it
  // that without competing with the text. The phone nav lens runs the same
  // GLSL on the same clock, so its refracted lines stay in step with the
  // page's. 30 fps; a single still frame for reduced motion; without WebGL the
  // CSS backdrop stays.
  const FLOW_FPS = 30;
  const FLOW_EPOCH = performance.now();
  const FLOW_GLSL = `vec3 flowBackdrop(vec2 p, vec2 size, float t, float aa) {
      float g = clamp((p.x / size.x + p.y / size.y) * 0.5, 0.0, 1.0);
      vec3 pink = vec3(0.984, 0.914, 0.953), sky = vec3(0.918, 0.949, 1.0), mint = vec3(0.918, 0.980, 0.949);
      vec3 color = g < 0.5 ? mix(pink, sky, g * 2.0) : mix(sky, mint, g * 2.0 - 1.0);
      float spacing = size.x < 700.0 ? 22.0 : 26.0;
      float k0 = floor((p.y + 60.0) / spacing);
      for (int j = -3; j <= 3; j++) {
        float k = k0 + float(j);
        float a1 = p.x * 0.011 + t * 0.35 + k * 0.35;
        float a2 = p.x * 0.0045 - t * 0.22 + k * 0.2;
        float y = k * spacing - 60.0 + sin(a1) * 22.0 + sin(a2) * 34.0;
        float slope = cos(a1) * 0.242 + cos(a2) * 0.153;
        float d = abs(p.y - y) / sqrt(1.0 + slope * slope);
        float strong = step(mod(k, 3.0), 0.5);
        float half_width = mix(0.5, 0.7, strong);
        float cover = 1.0 - smoothstep(half_width - aa, half_width + aa, d);
        color = mix(color, vec3(0.275, 0.353, 0.549), cover * mix(0.19, 0.34, strong));
      }
      return color;
    }`;
  let flow = null;

  function flowTime() {
    const step = 1000 / FLOW_FPS;
    return reducedMotion.matches ? 0 : Math.floor((performance.now() - FLOW_EPOCH) / step) * step / 1000;
  }

  function drawFlow() {
    const { gl, canvas, at } = flow;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(at.u_size, flow.width, flow.height);
    gl.uniform1f(at.u_ratio, flow.ratio);
    gl.uniform1f(at.u_time, flowTime());
    gl.uniform1f(at.u_aa, 0.6 / flow.ratio);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // The phone lens refracts the same lines: redraw it on the same frame.
    if (lens) drawLens();
  }

  function fitFlow() {
    const { canvas } = flow;
    const width = canvas.clientWidth || innerWidth;
    const height = canvas.clientHeight || innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    if (width === flow.width && height === flow.height && ratio === flow.ratio) return;
    Object.assign(flow, { width, height, ratio });
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    drawFlow();
  }

  function startFlow() {
    const host = document.getElementById('web_bg');
    if (!host || flow) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'lg-flow';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    try {
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, `attribute vec2 a_position;
        void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `precision highp float;
        uniform vec2 u_size;
        uniform float u_ratio, u_time, u_aa;
        ${FLOW_GLSL}
        void main() {
          vec2 p = vec2(gl_FragCoord.x, u_size.y * u_ratio - gl_FragCoord.y) / u_ratio;
          gl_FragColor = vec4(flowBackdrop(p, u_size, u_time, u_aa), 1.0);
        }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const at = {};
      ['u_size', 'u_ratio', 'u_time', 'u_aa'].forEach(name => { at[name] = gl.getUniformLocation(program, name); });
      host.prepend(canvas);
      host.classList.add('is-flowing');
      flow = { canvas, gl, at, width: 0, height: 0, ratio: 0, frame: 0, last: 0 };
    } catch (error) {
      console.warn('Liquid Glass: flowing backdrop unavailable.', error);
      return;
    }
    fitFlow();
    window.addEventListener('resize', () => flow && fitFlow(), { passive: true });
    canvas.addEventListener('webglcontextlost', () => {
      cancelAnimationFrame(flow.frame);
      canvas.remove();
      host.classList.remove('is-flowing');
      flow = null;
    });
    // 30 fps while the page is visible (rAF stops in background tabs).
    const tick = now => {
      if (!flow) return;
      flow.frame = requestAnimationFrame(tick);
      if (reducedMotion.matches || now - flow.last < 1000 / FLOW_FPS - 2) return;
      flow.last = now;
      drawFlow();
    };
    flow.frame = requestAnimationFrame(tick);
    reducedMotion.addEventListener('change', () => flow && drawFlow());
  }

  // --- Nav lens (WebGL, phones) ----------------------------------------------
  // The computer nav refracts its backdrop with an SVG filter on the GPU.
  // iPhone browsers (all WebKit) can neither use that filter on a backdrop
  // nor run SVG filters fast enough to follow scrolling. So on phones the
  // page is photographed with html2canvas (the backdrop, the poster and the
  // page in tiles, only while scrolling is quiet) and a WebGL canvas in the
  // nav refracts those pictures with the computer nav's own maps and steps:
  // displacement, 1.3x saturation, specular screen. A scroll frame only moves
  // the pictures, which the GPU keeps up with. Wherever a picture is missing
  // (not taken yet) the nav is plain clear glass. Without WebGL, or if the
  // pictures cannot be taken, the nav falls back to the resting mirror above.
  const LENS_TILE = 3072; // CSS px of page per picture
  const LENS_SCALE = 2; // picture resolution, device px per CSS px
  const LENS_QUIET = 400; // ms without scrolling before a picture is taken
  const LENS_TILES_KEPT = 4;
  const LENS_SKIP = '#nav, #liquid-nav-anchor, #rightside, #aplayer, #sidebar, #menu-mask, .search-dialog, ' +
    '#search-mask, .lg-filter-definitions, #lg-page-veil, script, noscript';
  // html2canvas copies the whole document into an iframe and waits for every
  // image and font there before drawing: a slow external avatar held a
  // picture for 12 s, the icon font re-download for 2-3 s each time. So the
  // copy leaves out preload hints, the icon font, and images still loading
  // (they are blank on the page too; a picture is retaken once they load).
  const LENS_SKIP_LOADING = 'link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], ' +
    'link[href*="fontawesome"], link[href*="font-awesome"]';
  // Backdrop and poster are the same on every page: kept across reloads.
  const LENS_STORE = `lg-lens:${(import.meta.url.match(/[?&]v=([^&]+)/) || [])[1] || '0'}`;
  // html2canvas cannot draw these: negative-spread shadows come out as thick
  // frames, blurred rings as hard lines, and the poster's SVG noise blacks it
  // out entirely. Under a 60px lens they would not show anyway. It turns
  // ::before/::after into html2canvaspseudoelement nodes (styled inline from
  // the page) before onclone runs, so those are hidden by tag.
  const LENS_CAPTURE_CSS = `.lg-optical-layer { box-shadow: none !important; }
    .lg-optical-layer > html2canvaspseudoelement, .lg-lens-layer > html2canvaspseudoelement { display: none !important; }
    .border-glow-effect, .saul-noise { display: none !important; }
    *, *::before, *::after { animation: none !important; transition: none !important; }`;
  const LENS_VERTEX = `attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_position.x + 1.0, 1.0 - a_position.y) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }`;
  // Same steps as createFilter's chain for the nav (sRGB, premultiplied).
  const LENS_FRAGMENT = `precision highp float;
    ${FLOW_GLSL}
    varying vec2 v_uv;
    uniform vec2 u_navSize, u_navPos, u_bgSize, u_viewSize;
    uniform float u_scroll, u_scale, u_saturate, u_flow, u_time, u_aa;
    uniform vec4 u_posterRect, u_tileARect, u_tileBRect;
    uniform sampler2D u_map, u_specular, u_bg, u_poster, u_tileA, u_tileB;
    vec4 inRect(sampler2D picture, vec4 rect, vec2 point) {
      vec2 uv = (point - rect.xy) / rect.zw;
      if (rect.w <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
      return texture2D(picture, uv);
    }
    void main() {
      vec4 map = texture2D(u_map, v_uv);
      vec2 view = u_navPos + v_uv * u_navSize + (map.rg - 0.5) * u_scale;
      vec2 page = view + vec2(0.0, u_scroll);
      // The flowing backdrop is computed, not photographed, on the page's clock.
      vec4 color = u_flow > 0.5 ? vec4(flowBackdrop(view, u_viewSize, u_time, u_aa), 1.0)
        : texture2D(u_bg, clamp(view / u_bgSize, 0.0, 1.0));
      vec4 poster = inRect(u_poster, u_posterRect, page);
      color = poster + color * (1.0 - poster.a);
      vec4 content = inRect(u_tileA, u_tileARect, page) + inRect(u_tileB, u_tileBRect, page);
      color = content + color * (1.0 - content.a);
      float luma = dot(color.rgb, vec3(0.213, 0.715, 0.072));
      color.rgb = clamp(mix(vec3(luma), color.rgb, u_saturate), 0.0, 1.0);
      vec4 light = texture2D(u_specular, v_uv);
      color.rgb = color.rgb + light.rgb - color.rgb * light.rgb;
      gl_FragColor = vec4(color.rgb, 1.0);
    }`;
  let lens = null;
  let html2canvasLoad = null;

  function loadHtml2canvas() {
    html2canvasLoad ??= new Promise((resolve, reject) => {
      if (window.html2canvas) return resolve(window.html2canvas);
      const script = document.createElement('script');
      script.src = '/vendor/html2canvas/html2canvas.min.js';
      script.onload = () => (window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas missing')));
      script.onerror = () => reject(new Error('html2canvas failed to load'));
      document.head.appendChild(script);
    });
    return html2canvasLoad;
  }

  // Canvas gradients interpolate unpremultiplied, so a stop of 'transparent'
  // (black at zero alpha) greys a fade that CSS keeps clean: the backdrop's
  // pastel glows and white sheens came out grey. Each such stop takes its
  // neighbour's colour at zero alpha instead.
  function cleanFades(value) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth--;
      else if (value[i] === ',' && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(value.slice(start));
    return parts.map(gradient => {
      const colors = [...gradient.matchAll(/rgba?\([^)]*\)/g)];
      const clear = color => color[0].replace(/\s/g, '') === 'rgba(0,0,0,0)';
      for (let i = colors.length - 1; i >= 0; i--) {
        if (!clear(colors[i])) continue;
        const near = colors.slice(0, i).reverse().find(c => !clear(c)) || colors.slice(i + 1).find(c => !clear(c));
        if (!near) continue;
        const [r, g, b] = near[0].match(/[\d.]+/g);
        gradient = gradient.slice(0, colors[i].index) + `rgba(${r}, ${g}, ${b}, 0)` + gradient.slice(colors[i].index + colors[i][0].length);
      }
      return gradient;
    }).join(',');
  }

  async function photograph(element, options = {}) {
    const html2canvas = await loadHtml2canvas();
    return html2canvas(element, {
      backgroundColor: null, scale: LENS_SCALE, logging: false, useCORS: true, imageTimeout: 1500,
      ignoreElements: node => Boolean(node.matches?.(LENS_SKIP) || node.matches?.(LENS_SKIP_LOADING) ||
        (node.tagName === 'IMG' && !node.complete)),
      onclone: (doc, root) => {
        const style = doc.createElement('style');
        style.textContent = LENS_CAPTURE_CSS;
        doc.head.appendChild(style);
        // Gradients live on the captured root and on pseudo-elements, which
        // html2canvas has already turned into inline-styled nodes.
        [root, ...root.querySelectorAll('html2canvaspseudoelement')].forEach(node => {
          const value = node.style.backgroundImage || doc.defaultView.getComputedStyle(node).backgroundImage;
          if (value && value.includes('gradient') && /rgba\(0,\s*0,\s*0,\s*0\)/.test(value)) node.style.backgroundImage = cleanFades(value);
        });
      },
      ...options
    });
  }

  // html2canvas ignores clip-path; the poster's V-cut bottom is redrawn here.
  function clipToShape(canvas, element) {
    const match = /^polygon\((.*)\)$/.exec(getComputedStyle(element).clipPath || '');
    if (!match) return canvas;
    const length = (value, size) => (value.endsWith('%') ? parseFloat(value) / 100 * size : parseFloat(value) * LENS_SCALE);
    const points = match[1].split(',').map(pair => {
      const [x, y] = pair.trim().split(/\s+/);
      return [length(x, canvas.width), length(y, canvas.height)];
    });
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const context = out.getContext('2d');
    context.beginPath();
    points.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
    context.closePath();
    context.clip();
    context.drawImage(canvas, 0, 0);
    freeCanvas(canvas);
    return out;
  }

  function freeCanvas(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  function createLensGl(canvas) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    if (!gl) return null;
    const shader = (type, source) => {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
      return result;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, LENS_VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, LENS_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const at = {};
    ['u_navSize', 'u_navPos', 'u_bgSize', 'u_viewSize', 'u_scroll', 'u_scale', 'u_saturate', 'u_flow', 'u_time', 'u_aa',
      'u_posterRect', 'u_tileARect',
      'u_tileBRect', 'u_map', 'u_specular', 'u_bg', 'u_poster', 'u_tileA', 'u_tileB']
      .forEach(name => { at[name] = gl.getUniformLocation(program, name); });
    ['u_map', 'u_specular', 'u_bg', 'u_poster', 'u_tileA', 'u_tileB'].forEach((name, unit) => gl.uniform1i(at[name], unit));
    const blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return { gl, at, blank };
  }

  function upload(source, premultiply, texture) {
    const { gl } = lens.gl;
    texture ||= gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  // The canvas follows the nav's size; the maps are the computer nav's.
  async function fitLens() {
    const { nav, canvas } = lens;
    const width = nav.offsetWidth;
    const height = nav.offsetHeight;
    const parsed = parseFloat(getComputedStyle(nav).borderTopLeftRadius);
    const radius = Math.min(Number.isFinite(parsed) ? parsed : height / 2, width / 2, height / 2);
    const key = `${width}x${height}:${radius.toFixed(1)}`;
    if (width < 2 || height < 2 || lens.key === key) return;
    lens.key = key;
    const ratio = Math.min(devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.setProperty('--lg-lens-radius', `${radius}px`);
    const maps = mapsFor(width, height, radius, KINDS.nav, DEFAULT_ANGLE);
    const [displacement, specular] = await Promise.all([loadImage(maps.displacementUrl), loadImage(maps.specularUrl)]);
    if (lens.key !== key) return;
    lens.map = upload(displacement, false, lens.map);
    lens.specular = upload(specular, true, lens.specular);
    requestLensDraw();
  }

  function requestLensDraw() {
    if (lens && !lens.frame) lens.frame = requestAnimationFrame(drawLens);
  }

  function drawLens() {
    if (!lens) return;
    lens.frame = 0;
    const { nav, canvas, gl: { gl, at, blank } } = lens;
    const n = nav.getBoundingClientRect();
    const reach = KINDS.nav.bezelWidth * KINDS.nav.refractionScale;
    const top = scrollY + n.top - reach;
    const bottom = scrollY + n.bottom + reach;
    // The page pictures must cover the band the lens samples from.
    const page = document.getElementById('body-wrap');
    const box = page ? page.getBoundingClientRect() : { top: 0, height: 0 };
    const needTop = Math.max(top, box.top + scrollY);
    const needBottom = Math.min(bottom, box.top + scrollY + box.height);
    // Only pictures of this page: after a pjax swap the old ones are void.
    const tiles = [...lens.tiles.values()]
      .filter(tile => tile.page === page && tile.top < bottom && tile.top + tile.height > top)
      .sort((a, b) => a.top - b.top);
    let covered = needTop >= needBottom;
    if (!covered && tiles.length && tiles.length <= 2) {
      covered = tiles[0].top <= needTop && tiles[tiles.length - 1].top + tiles[tiles.length - 1].height >= needBottom &&
        (tiles.length === 1 || Math.abs(tiles[0].top + tiles[0].height - tiles[1].top) < 1);
    }
    const ready = Boolean(lens.map && (flow || lens.bg) && (lens.poster || !lens.posterElement) && covered);
    canvas.classList.toggle('is-ready', ready);
    if (!ready) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(at.u_navSize, n.width, n.height);
    gl.uniform2f(at.u_navPos, n.left, n.top);
    gl.uniform2f(at.u_bgSize, lens.bg?.width || 1, lens.bg?.height || 1);
    gl.uniform1f(at.u_flow, flow ? 1 : 0);
    gl.uniform2f(at.u_viewSize, flow?.width || innerWidth, flow?.height || innerHeight);
    gl.uniform1f(at.u_time, flowTime());
    gl.uniform1f(at.u_aa, 0.6 * n.width / canvas.width);
    gl.uniform1f(at.u_scroll, scrollY);
    gl.uniform1f(at.u_scale, 2 * KINDS.nav.bezelWidth * KINDS.nav.refractionScale);
    gl.uniform1f(at.u_saturate, KINDS.nav.saturate ?? 1.3);
    const rect = (name, item) => gl.uniform4f(at[name], item ? item.left : 0, item ? item.top : 0, item ? item.width : 0, item ? item.height : 0);
    rect('u_posterRect', lens.poster);
    rect('u_tileARect', tiles[0]);
    rect('u_tileBRect', tiles[1]);
    [lens.map, lens.specular, lens.bg?.texture, lens.poster?.texture, tiles[0]?.texture, tiles[1]?.texture]
      .forEach((texture, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture || blank);
      });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Pictures to take, most urgent first: backdrop, poster, the page under
  // the nav, then the pictures either side of it.
  function nextPicture() {
    if (!flow && !lens.bg) return { kind: 'bg' };
    if (lens.posterElement && !lens.poster) return { kind: 'poster' };
    const page = document.getElementById('body-wrap');
    if (!page) return null;
    const pageTop = page.getBoundingClientRect().top + scrollY;
    const count = Math.max(1, Math.ceil(page.offsetHeight / LENS_TILE));
    const navTop = scrollY + lens.nav.getBoundingClientRect().top;
    const here = Math.min(count - 1, Math.max(0, Math.floor((navTop - pageTop) / LENS_TILE)));
    for (const index of [here, here + 1, here - 1]) {
      if (index < 0 || index >= count) continue;
      const tile = lens.tiles.get(index);
      if (!tile || tile.stale || tile.page !== page) return { kind: 'tile', index };
    }
    if (lens.posterStale) return { kind: 'poster' };
    return null;
  }

  // Backdrop and poster pictures kept in localStorage across page loads,
  // keyed by asset version and size; older ones are dropped when replaced.
  function storedPicture(kind, element) {
    const key = `${LENS_STORE}:${kind}:${innerWidth}x${element.offsetHeight}`;
    try {
      return { key, url: localStorage.getItem(key) };
    } catch {
      return { key, url: null };
    }
  }

  function storePicture(key, kind, canvas) {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const name = localStorage.key(i);
        if (name && name !== key && name.startsWith('lg-lens:') && name.includes(`:${kind}:`)) localStorage.removeItem(name);
      }
      localStorage.setItem(key, kind === 'bg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png'));
    } catch {
      // Storage full or disabled: the picture is simply retaken next time.
    }
  }

  // A stored picture if there is one, else a fresh one (then stored).
  async function backdropPicture(kind, element) {
    const { key, url } = storedPicture(kind, element);
    const stored = url ? await loadImage(url).catch(() => null) : null;
    if (stored) return { source: stored, done: () => {} };
    let canvas = await photograph(element);
    if (kind === 'poster') canvas = clipToShape(canvas, element);
    return {
      source: canvas,
      done: () => {
        storePicture(key, kind, canvas);
        freeCanvas(canvas);
      }
    };
  }

  async function takePicture(job) {
    const generation = lens.generation;
    if (job.kind === 'bg') {
      const { source, done } = await backdropPicture('bg', document.getElementById('web_bg'));
      if (lens?.generation !== generation) return done();
      lens.bg = { texture: upload(source, true, lens.bg?.texture), width: source.width / LENS_SCALE, height: source.height / LENS_SCALE };
      done();
      return;
    }
    if (job.kind === 'poster') {
      const element = lens.posterElement;
      // A changed poster is retaken fresh; otherwise the stored one will do.
      let picture;
      if (lens.posterStale) {
        const canvas = clipToShape(await photograph(element), element);
        picture = { source: canvas, done: () => freeCanvas(canvas) };
      } else {
        picture = await backdropPicture('poster', element);
      }
      const { source, done } = picture;
      if (lens?.generation !== generation) return done();
      const box = element.getBoundingClientRect();
      lens.poster = {
        texture: upload(source, true, lens.poster?.texture),
        left: box.left + scrollX, top: box.top + scrollY, width: source.width / LENS_SCALE, height: source.height / LENS_SCALE
      };
      lens.posterStale = false;
      done();
      return;
    }
    const page = document.getElementById('body-wrap');
    const offset = job.index * LENS_TILE;
    const height = Math.min(LENS_TILE, page.offsetHeight - offset);
    if (height <= 0) return;
    // html2canvas crops relative to the element, not the document.
    const canvas = await photograph(page, { x: 0, y: offset, width: page.offsetWidth, height });
    // A pjax swap during the picture: it shows the old page, so drop it.
    if (lens?.generation !== generation || document.getElementById('body-wrap') !== page) {
      freeCanvas(canvas);
      return;
    }
    const box = page.getBoundingClientRect();
    const pageTop = box.top + scrollY;
    const tile = lens.tiles.get(job.index) || {};
    Object.assign(tile, {
      texture: upload(canvas, true, tile.texture), left: box.left + scrollX, top: pageTop + offset,
      width: canvas.width / LENS_SCALE, height: canvas.height / LENS_SCALE, stale: false, page
    });
    freeCanvas(canvas);
    lens.tiles.set(job.index, tile);
    // Keep the pictures nearest the nav; free the rest.
    const navTop = scrollY + lens.nav.getBoundingClientRect().top;
    [...lens.tiles.values()]
      .sort((a, b) => Math.abs(a.top + a.height / 2 - navTop) - Math.abs(b.top + b.height / 2 - navTop))
      .slice(LENS_TILES_KEPT)
      .forEach(old => {
        lens.gl.gl.deleteTexture(old.texture);
        lens.tiles.forEach((value, key) => { if (value === old) lens.tiles.delete(key); });
      });
  }

  function scheduleLensPicture(delay = LENS_QUIET) {
    if (!lens) return;
    clearTimeout(lens.timer);
    lens.timer = setTimeout(runLensPicture, delay);
  }

  // One picture at a time, and only while scrolling is quiet: html2canvas
  // holds the main thread while it draws.
  async function runLensPicture() {
    if (!lens || lens.busy) return;
    // Mid page switch the old page is still in place: nothing to take yet.
    if (lens.switching > performance.now()) return scheduleLensPicture(lens.switching - performance.now());
    const quiet = performance.now() - lastScroll;
    if (quiet < LENS_QUIET) return scheduleLensPicture(LENS_QUIET - quiet);
    const job = nextPicture();
    if (!job) return;
    lens.busy = true;
    try {
      await takePicture(job);
      lens.failures = 0;
    } catch (error) {
      lens.failures = (lens.failures || 0) + 1;
      console.warn('Liquid Glass: could not photograph the page for the nav lens.', error);
    } finally {
      if (lens) lens.busy = false;
    }
    if (!lens) return;
    if (lens.failures >= 3) {
      stopLens();
      startMirror();
      return;
    }
    requestLensDraw();
    scheduleLensPicture(80);
  }

  // A pjax swap replaces the page (the poster outside it stays); a resize
  // changes every picture's layout, so it also drops the poster and backdrop.
  function resetLens(everything = false) {
    if (!lens) return;
    const { gl } = lens.gl;
    lens.generation++;
    lens.tiles.forEach(tile => gl.deleteTexture(tile.texture));
    lens.tiles.clear();
    const posterElement = document.getElementById('saul-intro');
    if ((everything || posterElement !== lens.posterElement) && lens.poster) {
      gl.deleteTexture(lens.poster.texture);
      lens.poster = null;
    }
    if (everything && lens.bg) {
      gl.deleteTexture(lens.bg.texture);
      lens.bg = null;
    }
    lens.posterElement = posterElement;
    lens.posterStale = false;
    lens.canvas.classList.remove('is-ready');
  }

  function watchLens() {
    lens.observer ??= new MutationObserver(records => {
      if (!lens) return;
      let poster = false;
      records.forEach(record => {
        if (lens.posterElement?.contains(record.target)) poster = true;
      });
      if (poster) lens.posterStale = true;
      else lens.tiles.forEach(tile => { tile.stale = true; });
      scheduleLensPicture();
    });
    lens.observer.disconnect();
    [lens.posterElement, document.getElementById('body-wrap')].filter(Boolean).forEach(target => lens.observer.observe(target, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset']
    }));
  }

  function stopLens() {
    if (!lens) return;
    clearTimeout(lens.timer);
    cancelAnimationFrame(lens.frame);
    lens.observer?.disconnect();
    lens.canvas.remove();
    lens.nav.classList.remove('lg-lensed');
    lens.listeners.forEach(([target, type, handler, capture]) => target.removeEventListener(type, handler, capture));
    lens = null;
  }

  function startLens() {
    const nav = document.getElementById('nav');
    const canvas = document.createElement('canvas');
    canvas.className = 'lg-nav-lens';
    canvas.setAttribute('aria-hidden', 'true');
    let lensGl = null;
    try {
      lensGl = nav && createLensGl(canvas);
    } catch (error) {
      console.warn('Liquid Glass: WebGL lens unavailable.', error);
    }
    if (!lensGl) {
      startMirror();
      return;
    }
    const layer = nav.querySelector(':scope > .lg-optical-layer');
    if (layer) layer.after(canvas);
    else nav.prepend(canvas);
    nav.classList.add('lg-lensed');
    lens = {
      nav, canvas, gl: lensGl, key: '', map: null, specular: null, bg: null, poster: null, posterStale: false,
      posterElement: document.getElementById('saul-intro'), tiles: new Map(), generation: 0, busy: false, failures: 0, timer: 0, frame: 0, observer: null, listeners: [],
      switching: 0
    };
    const on = (target, type, handler) => {
      target.addEventListener(type, handler, { passive: true });
      lens.listeners.push([target, type, handler]);
    };
    // Redraw on every scroll event, and keep following scrollY frame by frame
    // until it has been still for a while, in case momentum scrolling sends
    // fewer events than frames.
    let follow = 0;
    let still = 0;
    let followedY = -1;
    const followScroll = () => {
      follow = 0;
      if (!lens) return;
      if (scrollY !== followedY) {
        followedY = scrollY;
        still = 0;
        drawLens();
      } else {
        still++;
      }
      if (still < 20) follow = requestAnimationFrame(followScroll);
    };
    const onScroll = () => {
      lastScroll = performance.now();
      followedY = scrollY;
      still = 0;
      drawLens();
      if (!follow) follow = requestAnimationFrame(followScroll);
      scheduleLensPicture();
    };
    on(window, 'scroll', onScroll);
    on(window, 'touchmove', () => {
      lastScroll = performance.now();
      still = 0;
      if (!follow) follow = requestAnimationFrame(followScroll);
    });
    // iOS fires resize as its toolbar slides in and out; only a change of
    // width (rotation) moves the layout.
    let width = innerWidth;
    on(window, 'resize', () => {
      if (innerWidth === width) {
        requestLensDraw();
        return;
      }
      width = innerWidth;
      resetLens(true);
      fitLens().catch(() => {});
      scheduleLensPicture();
    });
    // A menu switch: pictures pause until the new page is in (pjax:complete;
    // at most 10 s if it never comes), and everything taken meanwhile is void.
    // An image that finishes loading after its picture was taken (lazy
    // Douban covers, link avatars) is blank in it: retake that picture.
    const imageLoaded = event => {
      const image = event.target;
      if (!lens || image.tagName !== 'IMG') return;
      if (lens.posterElement?.contains(image)) {
        if (lens.poster) lens.posterStale = true;
      } else if (document.getElementById('body-wrap')?.contains(image)) {
        const box = image.getBoundingClientRect();
        const top = box.top + scrollY;
        const bottom = box.bottom + scrollY;
        lens.tiles.forEach(tile => {
          if (tile.top < bottom && tile.top + tile.height > top) tile.stale = true;
        });
      } else {
        return;
      }
      scheduleLensPicture();
    };
    document.addEventListener('load', imageLoaded, true);
    lens.listeners.push([document, 'load', imageLoaded, true]);
    on(document, 'pjax:send', () => {
      resetLens();
      lens.switching = performance.now() + 10000;
    });
    on(document, 'pjax:complete', () => {
      lens.switching = 0;
      resetLens();
      watchLens();
      fitLens().catch(() => {});
      scheduleLensPicture(LENS_QUIET);
    });
    canvas.addEventListener('webglcontextlost', () => {
      stopLens();
      startMirror();
    });
    watchLens();
    fitLens().catch(error => console.warn('Liquid Glass: lens maps failed.', error));
    // Start as soon as the page is laid out (fonts get at most 1.5 s), not at
    // window load, which slow external images can hold back for many
    // seconds. Once everything has loaded, the pictures are retaken.
    Promise.race([document.fonts?.ready, new Promise(done => setTimeout(done, 1500))])
      .then(() => scheduleLensPicture(300));
    const loaded = () => {
      if (!lens) return;
      lens.tiles.forEach(tile => { tile.stale = true; });
      scheduleLensPicture();
    };
    if (document.readyState !== 'complete') window.addEventListener('load', loaded, { once: true });
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
    startFlow();
    // Phones only: computers without SVG backdrops keep the CSS material.
    const phone = matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (phone && !svgBackdrop && !forcedColors.matches && CSS.supports('clip-path', 'inset(0 round 1px)')) startLens();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
