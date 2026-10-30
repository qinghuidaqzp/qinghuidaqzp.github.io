/* Sliding optical controls, pjax page switches and adaptive glass tone for
 * Butterfly. Decorative layers never wrap text or change the document's layout. */
(() => {
  'use strict';
  if (document.documentElement.dataset.liquidControls === 'ready') return;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let header;
  let nav;
  let navAnchor;
  let track;
  let navPill;
  let navLinks = [];
  let sidePanel;
  let sideTrack;
  let sidePill;
  let sideLinks = [];
  let currentSideNav;
  let currentNav;
  let pointedNav;
  let pointedSideNav;
  let toc;
  let tocCard;
  let tocPill;
  let doubanHost;
  let doubanPill;
  let intro;
  let veil;
  let handoff = null;
  let scrollFrame = 0;
  let measureFrame = 0;
  let navigationTimer = 0;
  let restoreTimer = 0;

  // --- Selection lens motion ------------------------------------------------
  // The lens never animates width/height (each new size costs a displacement
  // map). Its box jumps to the target once; what you see travelling is a
  // compositor-only transform: translate + scale (old size / new size -> 1)
  // + a droplet stretch from the spring's speed, all sampled from one spring.
  function spring(response, damping) {
    const omega = 2 * Math.PI / response;
    const decay = damping * omega;
    const wd = omega * Math.sqrt(1 - damping * damping);
    const duration = Math.min(1.2, Math.log(500) / decay); // to within 0.2%
    const steps = Math.ceil(duration * 60);
    const samples = [];
    for (let i = 0; i <= steps; i++) {
      const t = duration * i / steps;
      const e = Math.exp(-decay * t);
      samples.push({
        offset: i / steps,
        p: i === steps ? 1 : 1 - e * (Math.cos(wd * t) + decay / wd * Math.sin(wd * t)),
        v: i === steps ? 0 : e * omega * omega / wd * Math.sin(wd * t) // dp/dt, 1/s
      });
    }
    return { duration: duration * 1000, samples };
  }
  const MOVE = spring(0.44, 0.74); // ~0.59s to rest, 3% overshoot
  const STRETCH_PER_SPEED = 0.00028; // droplet stretch per px/s of travel
  const MAX_STRETCH = 0.22;
  const LIFT_HOLD_MS = 220; // a quick tap still shows the lens lift
  const DROP_AT = 0.42; // a travelling lens settles onto the glass at 42%
  // Without pjax, navigation leaves once the lift reads; the next page
  // finishes the slide from where this one left off (saveHandoff).
  const NAV_DELAY_MS = 160;
  const HANDOFF_KEY = 'liquid-lens-handoff';
  // With pjax the request starts on click; the new page replaces the content
  // behind the veil once the lens has most of its travel behind it. The
  // slide itself runs on the compositor, so the swap cannot stall it.
  const SLIDE_MS = 260;
  const VEIL_MS = 180;
  let pressedAt = -Infinity;
  let slideUntil = 0;
  let swapAt = 0;
  let pendingSwap = 0;
  let navToken = 0;
  let readingContent = false;
  // Lens rectangles relative to the selected label. The nav lens covers the
  // label's capsule shell exactly (its ::before uses inset: -5px -6px -3px).
  const NAV_INSET = { top: 5, right: 6, bottom: 3, left: 6 };
  const SIDE_INSET = { top: 1, right: 6, bottom: 1, left: 6 };
  const TAB_INSET = { top: 3, right: 4, bottom: 3, left: 4 };
  const NO_INSET = { top: 0, right: 0, bottom: 0, left: 0 };
  const lenses = new WeakMap();

  function lensState(pill) {
    let state = lenses.get(pill);
    if (!state) lenses.set(pill, state = { x: 0, y: 0, w: 0, h: 0 });
    return state;
  }

  function createPill(parent, className, magnify) {
    let pill = parent.querySelector(`:scope > .${className}`);
    if (!pill) {
      pill = document.createElement('span');
      pill.className = `liquid-glass-pill ${className}`;
      pill.setAttribute('aria-hidden', 'true');
      // Read by liquid-glass.js when it adopts the pill: "x y" for the
      // resting and the lifted optics.
      if (magnify) {
        pill.dataset.lgMagnify = magnify.rest;
        pill.dataset.lgLensMagnify = magnify.lifted;
      }
      parent.appendChild(pill);
    }
    return pill;
  }

  function hidePill(pill) {
    if (!pill) return;
    const state = lensState(pill);
    state.animation?.cancel();
    state.target = null;
    pill.classList.remove('is-visible', 'is-lifted');
  }

  function scheduleDrop(pill, state, delay) {
    clearTimeout(state.dropTimer);
    state.dropTimer = setTimeout(() => {
      if (!state.pressed) pill.classList.remove('is-lifted');
    }, Math.max(0, delay));
  }

  // iOS lift: the resting bead becomes the clear magnifying lens.
  function pressLens(pill) {
    if (!pill || reducedMotion.matches || !pill.classList.contains('lg-surface')) return;
    const state = lensState(pill);
    state.pressed = true;
    state.pressedAt = performance.now();
    clearTimeout(state.dropTimer);
    pill.classList.add('is-lifted');
  }

  function releaseLens(pill) {
    const state = pill && lenses.get(pill);
    if (!state?.pressed) return;
    state.pressed = false;
    const held = performance.now() - state.pressedAt;
    const animation = state.animation;
    const travel = animation?.playState === 'running'
      ? MOVE.duration * DROP_AT - animation.currentTime : 0;
    scheduleDrop(pill, state, Math.max(LIFT_HOLD_MS - held, travel));
  }

  // options.from: a screen rect to start from (handoff from the last page).
  // options.animate: false places without travel (e.g. the closed drawer:
  // an off-screen animation has no visible effect, so Chromium would run it
  // on the main thread for nothing).
  function movePill(pill, container, target, inset = NO_INSET, { from = null, animate = true } = {}) {
    if (!pill || !container || !target) return hidePill(pill);
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return hidePill(pill);
    const state = lensState(pill);
    const shown = pill.classList.contains('is-visible');
    // All reads first: where the lens is on screen right now (mid-flight
    // included: getBoundingClientRect sees the running transform).
    const parent = container.getBoundingClientRect();
    const before = from || (shown ? pill.getBoundingClientRect() : null);
    // Whole pixels, so equal labels share one cached map.
    const rawWidth = bounds.width + inset.left + inset.right;
    const rawHeight = bounds.height + inset.top + inset.bottom;
    const width = Math.round(rawWidth);
    const height = Math.round(rawHeight);
    const left = bounds.left - inset.left + (rawWidth - width) / 2;
    const top = bounds.top - inset.top + (rawHeight - height) / 2;
    const x = left - parent.left + container.scrollLeft - container.clientLeft;
    const y = top - parent.top + container.scrollTop - container.clientTop;
    const retarget = Boolean(from) || (state.target && state.target !== target);
    state.target = target;
    if (shown && !from && Math.abs(x - state.x) < 0.5 && Math.abs(y - state.y) < 0.5
      && width === state.w && height === state.h) return;
    Object.assign(state, { x, y, w: width, h: height });
    state.animation?.cancel();
    pill.style.setProperty('--pill-x', `${x.toFixed(2)}px`);
    pill.style.setProperty('--pill-y', `${y.toFixed(2)}px`);
    pill.style.setProperty('--pill-width', `${width}px`);
    pill.style.setProperty('--pill-height', `${height}px`);
    pill.classList.add('is-visible');
    // First placement on a page appears in place; reduced motion jumps.
    if (!before || !animate || reducedMotion.matches) return;
    const dx = before.left + before.width / 2 - (left + width / 2);
    const dy = before.top + before.height / 2 - (top + height / 2);
    const rx = before.width / width;
    const ry = before.height / height;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.5 && Math.abs(rx - 1) < 0.01 && Math.abs(ry - 1) < 0.01) return;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const frames = MOVE.samples.map(({ offset, p, v }) => {
      // A drop stretches along its velocity and thins across it.
      const stretch = Math.min(MAX_STRETCH, Math.abs(distance * v) * STRETCH_PER_SPEED);
      const along = 1 + stretch;
      const across = 1 - stretch * 0.45;
      const sx = (rx + (1 - rx) * p) * (horizontal ? along : across);
      const sy = (ry + (1 - ry) * p) * (horizontal ? across : along);
      return {
        offset,
        transform: `translate(${(dx * (1 - p)).toFixed(2)}px, ${(dy * (1 - p)).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      };
    });
    state.animation = pill.animate(frames, { duration: MOVE.duration, easing: 'linear' });
    // A selection change travels lifted (magnifying what it passes over)
    // and settles back onto the glass before it lands. Layout nudges
    // (fonts, resize) just glide.
    if (retarget && pill.classList.contains('lg-surface')) {
      pill.classList.add('is-lifted');
      scheduleDrop(pill, state, MOVE.duration * DROP_AT);
    }
  }

  function normalizedPath(path) {
    try { path = decodeURI(path); } catch (_) { /* Keep malformed encoded paths usable. */ }
    return path.replace(/index\.html$/, '').replace(/\/?$/, '/');
  }

  // Without pjax: hand the travelling lens to the next page, so a click
  // navigates at once and the slide continues there.
  function saveHandoff(destination) {
    if (!navPill?.classList.contains('is-visible') || !track) return;
    const lens = navPill.getBoundingClientRect();
    const box = track.getBoundingClientRect();
    try {
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
        at: Date.now(),
        to: normalizedPath(destination.pathname),
        x: lens.left - box.left, y: lens.top - box.top, w: lens.width, h: lens.height
      }));
    } catch (_) { /* Storage blocked: the next page simply places its lens. */ }
  }

  function takeHandoff() {
    let data = null;
    try {
      data = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
      sessionStorage.removeItem(HANDOFF_KEY);
    } catch (_) { return null; }
    if (!data || Date.now() - data.at > 4000 || data.to !== normalizedPath(location.pathname)) return null;
    return data;
  }

  function selectCurrentNav() {
    const path = normalizedPath(location.pathname);
    function select(links) {
      let best = null;
      let longest = 0;
      links.forEach(link => {
        link.classList.remove('is-current');
        link.removeAttribute('aria-current');
        if (!(link instanceof HTMLAnchorElement)) return;
        const href = normalizedPath(new URL(link.href, location.href).pathname);
        if ((path === href || (href !== '/' && path.startsWith(href))) && href.length > longest) {
          best = link;
          longest = href.length;
        }
      });
      // Pages outside the menu (posts) show no selection rather than a wrong one.
      if (best) {
        best.classList.add('is-current');
        const exact = path === normalizedPath(new URL(best.href, location.href).pathname);
        best.setAttribute('aria-current', exact ? 'page' : 'location');
      }
      return best;
    }
    currentNav = select(navLinks);
    currentSideNav = select(sideLinks);
  }

  function measurePills() {
    measureFrame = 0;
    let from = null;
    if (handoff && track) {
      const box = track.getBoundingClientRect();
      from = { left: box.left + handoff.x, top: box.top + handoff.y, width: handoff.w, height: handoff.h };
      handoff = null;
    }
    movePill(navPill, track, pointedNav || currentNav, NAV_INSET, { from });
    movePill(sidePill, sideTrack, pointedSideNav || currentSideNav, SIDE_INSET, { animate: drawerOpen() });
    movePill(tocPill, toc, toc?.querySelector('.toc-link.active'));
    movePill(doubanPill, doubanHost, doubanHost?.querySelector('#idouban .idouban-tab-active'), TAB_INSET);
  }

  function scheduleMeasure() {
    if (!measureFrame) measureFrame = requestAnimationFrame(measurePills);
  }

  function updatePinnedNav() {
    if (!header || !navAnchor) return;
    // Only reflect the browser's native sticky state. The browser owns the
    // position; scroll handlers never assign top, transform, or scroll speed.
    const pinned = navAnchor.getBoundingClientRect().top <= 0.5;
    header.classList.toggle('liquid-nav-pinned', pinned);
    navAnchor.classList.toggle('is-pinned', pinned);
  }

  // Liquid glass adapts its tone to what is underneath it. Over the bright
  // yellow intro poster, the small floating controls switch to the light
  // material with dark icons. The nav stays clear glass throughout, so the
  // poster and then the posts visibly bend through it as they slide past.
  function updateTone() {
    nav?.classList.remove('lg-on-light');
    const adaptive = Array.from(document.querySelectorAll('#rightside > div, #aplayer .aplayer-body'));
    if (!intro) {
      adaptive.forEach(element => element?.classList.remove('lg-on-light'));
      return;
    }
    const poster = intro.getBoundingClientRect();
    // The poster's bottom 5% is clipped into a V; treat it as already dark.
    const posterBottom = poster.bottom - poster.height * 0.05;
    adaptive.forEach(element => {
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const middle = bounds.top + bounds.height / 2;
      element.classList.toggle('lg-on-light', bounds.height > 0 && middle > poster.top && middle < posterBottom);
    });
  }

  function mountNativeNavigation() {
    if (!nav) return;
    const bodyWrap = document.getElementById('body-wrap');
    navAnchor = document.getElementById('liquid-nav-anchor');
    if (!navAnchor) {
      navAnchor = document.createElement('div');
      navAnchor.id = 'liquid-nav-anchor';
    }
    // A zero-height sticky sibling placed just before #body-wrap (outside it):
    // pjax replaces #body-wrap on every page switch, while this anchor, the nav
    // and its lens stay mounted and keep animating. Its static position is the
    // same as before (right after the poster), so the pinned state is unchanged.
    // Being first in document order, it is also the #nav Butterfly re-binds.
    if (bodyWrap) {
      if (navAnchor.nextElementSibling !== bodyWrap) bodyWrap.before(navAnchor);
    } else if (header && navAnchor.nextElementSibling !== header) {
      header.before(navAnchor);
    }
    if (nav.parentElement !== navAnchor) navAnchor.appendChild(nav);
    // Safety net: a swap that was not filtered must never leave a second #nav.
    document.querySelectorAll('#body-wrap #nav').forEach(copy => {
      if (copy !== nav) copy.remove();
    });
    nav.style.removeProperty('--lg-nav-top');
  }

  /* ---- pjax ------------------------------------------------------------ */

  // Where a page switch lands when the reader was already below the poster:
  // the new page's title card (posts) or first content, just under the nav.
  function contentTop() {
    const navBottom = nav ? nav.getBoundingClientRect().bottom : 70;
    const target = ['#page-header #post-info', '#page-header #page-site-info', '#content-inner']
      .map(selector => document.querySelector(selector))
      .find(element => element && element.offsetHeight > 0
        && getComputedStyle(element).visibility !== 'hidden');
    return target ? Math.max(0, target.getBoundingClientRect().top + scrollY - navBottom - 16) : 0;
  }

  // The veil covers only what is below the visible part of the poster, so the
  // poster itself never changes during a switch.
  function placeVeil() {
    if (!veil) return;
    const poster = intro?.getBoundingClientRect();
    const top = poster ? Math.min(Math.max(poster.bottom - poster.height * 0.05, 0), innerHeight) : 0;
    veil.style.setProperty('--lg-veil-top', `${Math.round(top)}px`);
  }

  // Butterfly's switch for '#body-wrap' would be outerHTML: it re-serialises
  // the page (1.4 MB on /movies/) and brings a second #nav. This one keeps the
  // live nav (lens, glass filter, pjax-bound links) and takes only the
  // per-page title from the incoming copy, then adopts the new node as is.
  function switchBodyWrap(oldEl, newEl, options) {
    const liveNav = document.getElementById('nav');
    const nextNav = newEl.querySelector('#nav');
    if (liveNav && nextNav && !oldEl.contains(liveNav)) {
      const liveInfo = liveNav.querySelector('#blog-info');
      const nextInfo = nextNav.querySelector('#blog-info');
      if (liveInfo && nextInfo) {
        liveInfo.replaceWith(nextInfo);
        this.refresh(nextInfo); // attach pjax to the site/post title links
      }
      nextNav.remove();
    }
    if (sidePanel?.classList.contains('open')) document.getElementById('menu-mask')?.click();
    oldEl.replaceWith(newEl);
    // Forward navigation only; back/forward restores the saved offset, and a
    // #hash is scrolled to by pjax itself. Only body has scroll-behavior:
    // smooth, which does not apply to the viewport, so this jump is instant.
    let hash = '';
    try { hash = new URL(this.state.href || location.href, location.href).hash; } catch (_) { /* keep '' */ }
    if (options && options.history !== false && !hash && readingContent) {
      window.scrollTo(0, contentTop());
    }
    this.onSwitch();
  }

  // #rightside-config-hide/-show are glass docks. Swapping only their buttons
  // keeps the host with its optical layer and filter, so the dock (which sits
  // above the veil) never drops to the fallback material for a frame.
  function switchKeepGlass(oldEl, newEl) {
    const layer = oldEl.querySelector(':scope > .lg-optical-layer');
    const glow = oldEl.querySelector(':scope > .border-glow-effect');
    oldEl.replaceChildren(...[layer, ...newEl.childNodes, glow].filter(Boolean));
    this.onSwitch();
  }

  function liftVeil() {
    const token = navToken;
    let lifted = false;
    const lift = () => {
      if (lifted) return;
      lifted = true;
      document.removeEventListener('liquid-glass:idle', lift);
      if (token === navToken) root.classList.remove('lg-pjax-busy');
    };
    if (reducedMotion.matches) {
      lift();
      return;
    }
    // Let the engine fit the new surfaces under the veil (its
    // IntersectionObserver reports next frame, the first flush runs the frame
    // after), but never hold the page longer than 260 ms.
    setTimeout(lift, 260);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!lifted) document.addEventListener('liquid-glass:idle', lift);
    }));
  }

  function installPjax() {
    const pjax = window.pjax;
    if (!pjax || !pjax.options || pjax.liquidInstalled) return;
    pjax.liquidInstalled = true;
    const options = pjax.options;
    options.switches['#body-wrap'] = switchBodyWrap;
    options.switches['#rightside-config-hide'] = switchKeepGlass;
    options.switches['#rightside-config-show'] = switchKeepGlass;
    // With comments.use: Giscus the theme also swaps og:* metas. giscus maps by
    // pathname and never reads them, and /movies/ and /books/ have no
    // og:description: a count mismatch aborts the switch into a full reload.
    options.selectors = options.selectors.filter(selector => !selector.startsWith('meta['));
    options.scrollTo = false;          // switchBodyWrap decides where to land
    options.scrollRestoration = true;  // back/forward return to the saved offset
    options.timeout = 10000;           // pjax 0.2.8 has no timeout by default
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    // Hold a response that arrives mid-slide until the veil is up.
    const loadContent = pjax.loadContent;
    pjax.loadContent = function (html, loadOptions) {
      const wait = swapAt - performance.now();
      if (typeof html !== 'string' || wait <= 0) return loadContent.call(this, html, loadOptions);
      clearTimeout(pendingSwap);
      pendingSwap = setTimeout(() => {
        pendingSwap = 0;
        try {
          loadContent.call(this, html, loadOptions);
        } catch (error) {
          // Same fallback as pjax's own latestChance().
          console.error('Pjax switch fail: ', error);
          location.assign(this.state.href || location.href);
        }
      }, wait);
      return undefined;
    };

    document.addEventListener('pjax:send', () => {
      navToken++;
      clearTimeout(pendingSwap);
      pendingSwap = 0;
      clearTimeout(navigationTimer);
      const poster = intro?.getBoundingClientRect();
      readingContent = !poster || poster.bottom <= innerHeight / 2;
      swapAt = reducedMotion.matches ? 0 : Math.max(slideUntil, performance.now() + VEIL_MS);
      placeVeil();
      root.classList.add('lg-pjax-busy');
    });
    document.addEventListener('pjax:complete', liftVeil);
    document.addEventListener('pjax:error', event => {
      root.classList.remove('lg-pjax-busy');
      // Network error or timeout (status 0): fall back to a normal load. 404 is
      // handled by Butterfly's own pjax:error listener.
      if (event.request && event.request.status === 0) {
        location.assign(event.triggerElement?.href || event.url || location.href);
      }
    });
  }

  function onScrollFrame() {
    scrollFrame = 0;
    updatePinnedNav();
    updateTone();
  }

  function onScroll() {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(onScrollFrame);
  }

  const tocObserver = new MutationObserver(records => {
    if (records.some(record => record.target === toc || record.target === tocCard
      || record.target.matches('.toc-link, .toc-item'))) {
      scheduleMeasure();
    }
  });
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleMeasure) : null;
  const menuObserver = new MutationObserver(scheduleMeasure);
  // The movie/book tabs are rendered and re-rendered by idouban's React; its
  // lens lives beside the React root so React never sees a foreign node.
  const doubanObserver = new MutationObserver(scheduleMeasure);

  function refresh() {
    tocObserver.disconnect();
    menuObserver.disconnect();
    doubanObserver.disconnect();
    resizeObserver?.disconnect();
    toc?.removeEventListener('scroll', scheduleMeasure);
    tocCard?.removeEventListener('transitionend', scheduleMeasure);
    sidePanel?.removeEventListener('transitionend', scheduleMeasure);
    header = document.getElementById('page-header');
    nav = document.getElementById('nav');
    intro = document.getElementById('saul-intro');
    mountNativeNavigation();
    track = nav?.querySelector('.menus_items');
    navLinks = track ? Array.from(track.querySelectorAll(':scope > .menus_item > .site-page')) : [];
    navPill = track ? createPill(track, 'liquid-nav-indicator', { rest: '1.04 1.06', lifted: '1.16 1.22' }) : null;
    sidePanel = document.getElementById('sidebar-menus');
    sideTrack = sidePanel?.querySelector('.menus_items');
    sideLinks = sideTrack ? Array.from(sideTrack.querySelectorAll('a.site-page')) : [];
    // Wide, short rows: magnify mostly across the row, barely along it, so
    // the left-aligned icon and label do not slide sideways.
    sidePill = sideTrack ? createPill(sideTrack, 'liquid-menu-indicator', { rest: '1.01 1.05', lifted: '1.04 1.2' }) : null;
    pointedNav = null;
    pointedSideNav = null;
    selectCurrentNav();
    handoff = takeHandoff();
    toc = document.querySelector('#card-toc .toc-content');
    tocCard = document.getElementById('card-toc');
    tocPill = toc ? createPill(toc, 'liquid-toc-indicator') : null;
    const douban = document.getElementById('idouban');
    doubanHost = douban?.parentElement || null;
    doubanPill = doubanHost ? createPill(doubanHost, 'liquid-tab-indicator', { rest: '1.04 1.06', lifted: '1.14 1.2' }) : null;
    if (douban) {
      doubanObserver.observe(douban, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    }
    if (toc) {
      tocObserver.observe(toc, { attributes: true, attributeFilter: ['class'], subtree: true });
      tocObserver.observe(tocCard, { attributes: true, attributeFilter: ['class'] });
      toc.addEventListener('scroll', scheduleMeasure, { passive: true });
      tocCard.addEventListener('transitionend', scheduleMeasure);
      resizeObserver?.observe(toc);
    }
    if (track) resizeObserver?.observe(track);
    if (sideTrack) resizeObserver?.observe(sideTrack);
    if (sidePanel) {
      menuObserver.observe(sidePanel, { attributes: true, attributeFilter: ['class'] });
      sidePanel.addEventListener('transitionend', scheduleMeasure);
    }
    const coverLink = intro?.querySelector('.scroll-indicator');
    if (coverLink) {
      coverLink.setAttribute('role', 'button');
      coverLink.setAttribute('tabindex', '0');
      coverLink.setAttribute('aria-label', '向下浏览博客内容');
    }
    onScrollFrame();
    scheduleMeasure();
    document.dispatchEvent(new CustomEvent('liquid-glass:refresh'));
  }

  function navLinkFromEvent(event) {
    const link = event.target instanceof Element ? event.target.closest('a.site-page') : null;
    return navLinks.includes(link) || sideLinks.includes(link) ? link : null;
  }

  function isPlainPrimary(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function selectNav(link) {
    const path = normalizedPath(new URL(link.href, location.href).pathname);
    [currentNav, currentSideNav].forEach(item => item?.classList.remove('is-current'));
    currentNav = navLinks.find(item => item instanceof HTMLAnchorElement
      && normalizedPath(new URL(item.href, location.href).pathname) === path) || currentNav;
    currentSideNav = sideLinks.find(item => normalizedPath(new URL(item.href, location.href).pathname) === path) || currentSideNav;
    [currentNav, currentSideNav].forEach(item => item?.classList.add('is-current'));
    pointedNav = null;
    pointedSideNav = null;
    movePill(navPill, track, currentNav, NAV_INSET);
    movePill(sidePill, sideTrack, currentSideNav, SIDE_INSET, { animate: drawerOpen() });
  }

  function drawerOpen() {
    return Boolean(sidePanel?.classList.contains('open'));
  }

  function scrollToContent() {
    const content = document.getElementById('content-inner');
    if (content) window.scrollTo({ top: Math.max(0, content.getBoundingClientRect().top + scrollY
      - (nav?.offsetHeight || 60) - 16), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  function boot() {
    root.dataset.liquidControls = 'ready';
    root.dataset.liquidControlsVersion = '20261030-lg21';
    veil = document.getElementById('lg-page-veil');
    if (!veil) {
      veil = document.createElement('div');
      veil.id = 'lg-page-veil';
      veil.setAttribute('aria-hidden', 'true');
      document.body.appendChild(veil);
    }
    refresh();
    document.addEventListener('pjax:complete', refresh);
    // Butterfly's inline pjax script has already run (this file is deferred).
    installPjax();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => {
      onScroll();
      scheduleMeasure();
    }, { passive: true });
    // A restored back/forward-cache page keeps the pill where the last press
    // left it; re-derive the selection from the URL.
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      clearTimeout(navigationTimer);
      root.classList.remove('lg-pjax-busy');
      [navPill, sidePill, doubanPill].forEach(pill => {
        if (!pill) return;
        lensState(pill).pressed = false;
        pill.classList.remove('is-lifted');
      });
      selectCurrentNav();
      onScroll();
      scheduleMeasure();
    });
    document.addEventListener('focusin', event => {
      const link = navLinkFromEvent(event);
      if (!link) return;
      if (sideLinks.includes(link)) pointedSideNav = link;
      else pointedNav = link;
      scheduleMeasure();
    });
    document.addEventListener('focusout', () => {
      queueMicrotask(() => {
        if (!track?.contains(document.activeElement)) pointedNav = null;
        if (!sideTrack?.contains(document.activeElement)) pointedSideNav = null;
        scheduleMeasure();
      });
    });
    // The lens lifts and starts its spring on press, before the click.
    document.addEventListener('pointerdown', event => {
      if (!isPlainPrimary(event) || !(event.target instanceof Element)) return;
      const link = navLinkFromEvent(event);
      if (link) {
        pressedAt = performance.now();
        pressLens(sideLinks.includes(link) ? sidePill : navPill);
        selectNav(link);
        return;
      }
      const tab = event.target.closest('#idouban .idouban-tab');
      if (tab && doubanPill) {
        pressLens(doubanPill);
        movePill(doubanPill, doubanHost, tab, TAB_INSET);
      }
    }, { passive: true });
    // A press that did not become a click (dragged off the item) returns to
    // the real selection. The click, when there is one, fires right after
    // pointerup in the same task, so it cancels this before it runs.
    const restoreSelection = () => {
      restoreTimer = 0;
      selectCurrentNav();
      scheduleMeasure();
    };
    const releaseAll = event => {
      [navPill, sidePill, doubanPill].forEach(releaseLens);
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(restoreSelection, event?.type === 'pointercancel' ? 0 : 50);
    };
    document.addEventListener('pointerup', releaseAll, { passive: true });
    document.addEventListener('pointercancel', releaseAll, { passive: true });

    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('#saul-intro .scroll-indicator')) scrollToContent();
    });
    document.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element
        && event.target.matches('#saul-intro .scroll-indicator')) {
        event.preventDefault();
        scrollToContent();
      }
    });

    // Warm the next page while the pointer is on its menu item.
    const prefetched = new Set();
    document.addEventListener('pointerover', event => {
      const link = navLinkFromEvent(event);
      if (!(link instanceof HTMLAnchorElement) || prefetched.has(link.href)) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin || destination.pathname === location.pathname) return;
      prefetched.add(link.href);
      const hint = document.createElement('link');
      hint.rel = 'prefetch';
      hint.href = destination.href;
      document.head.appendChild(hint);
    }, { passive: true });

    // Menu clicks run in the capture phase, i.e. before pjax's own click
    // listener on the <a>. With pjax this handler never navigates: pjax starts
    // the request at once and the swap waits for the slide (swapAt).
    // Selecting the current page returns to its beginning; the preventDefault
    // makes pjax skip it (it checks defaultPrevented). Without pjax (CDN
    // failure, excluded URL) the lens is handed to the next page instead.
    document.addEventListener('click', event => {
      const link = navLinkFromEvent(event);
      if (!link) return;
      clearTimeout(restoreTimer);
      if (!(link instanceof HTMLAnchorElement) || !isPlainPrimary(event)
        || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin) return;
      const samePage = destination.pathname === location.pathname
        && destination.search === location.search && destination.hash === location.hash;
      clearTimeout(navigationTimer);
      selectNav(link);
      if (samePage) {
        event.preventDefault();
        if (sidePanel?.classList.contains('open')) document.getElementById('menu-mask')?.click();
        window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        return;
      }
      const pjax = window.pjax;
      if (pjax && pjax.liquidInstalled && link.hasAttribute('data-pjax-state')
        && link.matches(pjax.options.elements)) {
        const now = performance.now();
        slideUntil = (now - pressedAt < SLIDE_MS ? pressedAt : now) + SLIDE_MS;
        return;
      }
      if (reducedMotion.matches) return;
      event.preventDefault();
      navigationTimer = setTimeout(() => {
        saveHandoff(destination);
        location.assign(destination.href);
      }, NAV_DELAY_MS);
    }, true);

    // The theme scrolls headings to y=0 in its bubbling click handler. Intercept
    // only TOC links, leaving an offset for the permanently visible reading bar.
    document.addEventListener('click', event => {
      const link = event.target instanceof Element ? event.target.closest('.toc-link') : null;
      if (!link || !toc?.contains(link) || !link.hash || !isPlainPrimary(event)) return;
      let id;
      try { id = decodeURIComponent(link.hash.slice(1)); } catch (_) { return; }
      const heading = document.getElementById(id);
      if (!heading) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const top = heading.getBoundingClientRect().top + scrollY - (nav?.offsetHeight || 60) - 16;
      // Keep pjax's state object ({url, title, uid, scrollPos}); a null state
      // makes pjax ignore the popstate that returns to this entry.
      history.replaceState(history.state, '', link.hash);
      window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      if (innerWidth < 900) document.getElementById('card-toc')?.classList.remove('open');
    }, true);

    // APlayer builds its fixed body after this script; tone it once it exists.
    setTimeout(onScroll, 600);
    document.fonts?.ready.then(() => {
      onScroll();
      scheduleMeasure();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
