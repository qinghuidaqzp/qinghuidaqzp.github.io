/* 博客首屏的星图（思路来自 Shopify Editions 的知识星图，内容和画法是自己的）：
 * 中间一个原点，向外连着几个「分区」——文章的分类，以及唱片、电影、书籍；
 * 文章挂在自己的分类上，再用标签互相牵线；唱片、电影、书籍各挂一圈封面（/img/star/atlas.webp 一张图集）。
 * 画在玻璃面板里的 canvas 上，布局是一个小的力导向模拟（弹簧 + 互斥 + 往中间收），
 * 展开时从分区炸开，停下后每个点轻轻漂，鼠标附近有一点视差。
 * 悬停高亮一整簇并显示详情，拖动节点会带着一簇晃，点击打开（文章、分区在本站，电影和书籍去豆瓣）。
 * 左边目录悬停也会高亮对应分区。看不见（滚走、切到别的标签页）时停画；减少动态时只画静止的一帧。 */
(() => {
  const host = document.querySelector('.atlas-map');
  if (!host) return;
  const canvas = host.querySelector('.atlas-canvas');
  const tip = host.querySelector('.atlas-tip');
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const SANS = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", sans-serif';
  // 分区配色：暖橙是主题的强调色，其余取晚霞照片里能站得住的颜色
  const PALETTE = ['#ffc58a', '#8fd3ff', '#ffd36e', '#ffa9a0', '#9fb4ff'];
  const MEDIA = {
    album: { name: '唱片', href: '/records/', color: '#ff9fc6' },
    movie: { name: '电影', href: '/posters/', color: '#c7a6ff' },
    book: { name: '书籍', href: '/bookshelf/', color: '#7ff0c4' }
  };
  const SIZE = { album: [22, 22], movie: [18, 26], book: [18, 26], post: [26, 19] };

  const nodes = [], links = [];
  let W = 0, H = 0, L = 1, dpr = 1;
  let atlas = null, hover = null, lit = null, drag = null, pointer = null;
  let alpha = 1, alphaTarget = 0, raf = 0, shown = true, frame = 0, tipFor = null;
  const hubs = new Map(); // id -> hub node（左边目录用）

  const node = o => {
    const n = { x: 0, y: 0, vx: 0, vy: 0, rx: 0, ry: 0, fixed: false, deg: 0, phase: Math.random() * Math.PI * 2, ...o };
    nodes.push(n);
    return n;
  };
  // len 是相对长度（乘以面板短边），k 是弹簧硬度
  const link = (a, b, len, k) => {
    links.push({ a, b, len, k });
    a.deg++; b.deg++;
  };

  function build(data) {
    const root = node({ kind: 'root', charge: -80 });
    const posts = data.posts || [];
    const cats = [];
    posts.forEach(p => { if (p.c && !cats.includes(p.c)) cats.push(p.c); });
    cats.sort((a, b) => posts.filter(p => p.c === b).length - posts.filter(p => p.c === a).length);
    cats.forEach((c, i) => {
      const first = posts.find(p => p.c === c);
      hubs.set('cat:' + c, node({
        kind: 'hub', id: 'cat:' + c, label: c, count: posts.filter(p => p.c === c).length,
        color: PALETTE[i % PALETTE.length], href: first.cu, charge: -160
      }));
    });
    const media = data.media || {};
    // 手机这种窄面板放不下近百个封面：每类只挂 12 个
    const narrow = host.clientWidth < 600;
    const seen = {};
    const items = (media.items || []).filter(it => !narrow || (seen[it.k] = (seen[it.k] || 0) + 1) <= 12);
    Object.keys(MEDIA).forEach(k => {
      if (!items.some(it => it.k === k)) return;
      hubs.set(k, node({
        kind: 'hub', id: k, label: MEDIA[k].name, count: (media.counts || {})[k] || 0,
        color: MEDIA[k].color, href: MEDIA[k].href, charge: -160
      }));
    });
    hubs.forEach(h => link(root, h, 0, 0)); // 只画线；分区的位置由 seed() 里的锚点管

    const tags = new Map();
    posts.forEach(p => {
      const hub = hubs.get('cat:' + p.c);
      const n = node({ kind: 'post', item: p, hub, charge: -130 });
      if (hub) link(hub, n, 0.13 + Math.random() * 0.06, 0.5);
      (p.g || []).forEach(g => {
        if (!tags.has(g)) tags.set(g, node({ kind: 'tag', label: '#' + g, hub, charge: -20 }));
        link(n, tags.get(g), 0.06, 0.4);
      });
    });
    items.forEach(it => {
      const hub = hubs.get(it.k);
      link(hub, node({ kind: it.k, item: it, hub, charge: -14 }), 0.07 + Math.random() * 0.1, 0.5);
    });
    if (media.atlas) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { atlas = img; kick(); };
      img.src = media.atlas;
    }
  }

  // 起点：原点在中间，分区等距排在一个椭圆上（唱片、电影、书籍和文章分类交错，大簇不挤在一边），
  // 每个分区有个锚点拉着，拖开松手会弹回去；挂在分区上的点从分区身上炸开
  function anchor() {
    const cx = W / 2, cy = H / 2;
    const media = [...hubs.values()].filter(h => !h.id.startsWith('cat:'));
    const cats = [...hubs.values()].filter(h => h.id.startsWith('cat:'));
    const list = [];
    for (let i = 0; i < Math.max(media.length, cats.length); i++) {
      if (media[i]) list.push(media[i]);
      if (cats[i]) list.push(cats[i]);
    }
    list.forEach((h, i) => {
      // 从正右方起每隔一份放一个：六个分区时没有正上、正下的，大簇落在左右两侧，宽面板放得开
      const a = (i / list.length) * Math.PI * 2;
      h.ax = cx + Math.cos(a) * W * 0.33;
      h.ay = cy + Math.sin(a) * H * 0.27;
    });
  }
  function seed() {
    const cx = W / 2, cy = H / 2;
    anchor();
    hubs.forEach(h => { h.x = cx + (h.ax - cx) * 0.4; h.y = cy + (h.ay - cy) * 0.4; });
    nodes.forEach(n => {
      if (n.kind === 'root') { n.x = cx; n.y = cy; }
      else if (n.kind !== 'hub') {
        const from = n.hub || { x: cx, y: cy };
        n.x = from.x + (Math.random() - 0.5) * 8;
        n.y = from.y + (Math.random() - 0.5) * 8;
      }
    });
  }

  function tick() {
    // 弹簧（d3-force 的做法：度数大的那头少动一点）
    for (const { a, b, len, k } of links) {
      let dx = b.x + b.vx - a.x - a.vx, dy = b.y + b.vy - a.y - a.vy;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - len * L) / d * alpha * k;
      dx *= f; dy *= f;
      const bias = a.deg / (a.deg + b.deg);
      b.vx -= dx * bias; b.vy -= dy * bias;
      a.vx += dx * (1 - bias); a.vy += dy * (1 - bias);
    }
    // 互斥：两两推开（一百来个点，直接两两算）
    const max2 = (L * 0.28) ** 2; // 只推近处的：各簇之间不互相顶
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > max2) continue;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const w = alpha / d2;
        a.vx += dx * b.charge * w; a.vy += dy * b.charge * w;
        b.vx -= dx * a.charge * w; b.vy -= dy * a.charge * w;
      }
    }
    // 往中间收（横向收得松一点，铺满宽面板），再撞墙
    const cx = W / 2, cy = H / 2, pad = 26;
    for (const n of nodes) {
      if (n.fixed) { n.vx = n.vy = 0; continue; }
      if (n.kind === 'hub') { n.vx += (n.ax - n.x) * 0.05; n.vy += (n.ay - n.y) * 0.05; }
      else { n.vx += (cx - n.x) * 0.002 * alpha; n.vy += (cy - n.y) * 0.003 * alpha; }
      n.vx *= 0.6; n.vy *= 0.6;
      n.x = Math.min(W - pad, Math.max(pad, n.x + n.vx));
      n.y = Math.min(H - pad, Math.max(pad, n.y + n.vy));
    }
    alpha += (alphaTarget - alpha) * 0.0228;
  }

  // 高亮：悬停的点、它的分区和同簇的点、牵着的标签
  function litSet(n) {
    if (!n) return null;
    const set = new Set([n]);
    const hub = n.kind === 'hub' ? n : n.hub;
    if (hub && (n.kind === 'hub' || n.kind === 'tag')) {
      set.add(hub);
      links.forEach(l => { if (l.a === hub && l.b.kind !== 'hub') set.add(l.b); });
    }
    links.forEach(l => {
      if (l.a === n) set.add(l.b);
      if (l.b === n) set.add(l.a);
    });
    if (hub) set.add(hub);
    return set;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const short = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 漂动 + 视差（只影响画的位置，不影响模拟）
    const t = now * 0.00055;
    const px = pointer && !drag ? (pointer.x / W - 0.5) : 0;
    const py = pointer && !drag ? (pointer.y / H - 0.5) : 0;
    for (const n of nodes) {
      const depth = n.kind === 'hub' || n.kind === 'root' ? 3 : 9;
      const amp = still || n === drag?.node ? 0 : (n.kind === 'hub' ? 1.2 : 2.2);
      n.rx = n.x + Math.sin(t + n.phase) * amp - px * depth;
      n.ry = n.y + Math.cos(t * 0.9 + n.phase) * amp - py * depth;
    }
    const on = lit;
    const fade = n => (!on || on.has(n) ? 1 : 0.16);

    // 连线
    ctx.lineWidth = 1;
    for (const l of links) {
      const both = on && on.has(l.a) && on.has(l.b);
      let color, a;
      if (l.a.kind === 'root') { color = '255,255,255'; a = 0.16; }
      else if (l.b.kind === 'tag') { color = '255,255,255'; a = 0.2; }
      else { color = l.a.rgb; a = 0.3; }
      if (on) a = both ? 0.85 : 0.05;
      ctx.strokeStyle = `rgba(${color},${a})`;
      ctx.beginPath();
      ctx.moveTo(l.a.rx, l.a.ry);
      ctx.lineTo(l.b.rx, l.b.ry);
      ctx.stroke();
    }

    // 点
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      ctx.globalAlpha = fade(n);
      const big = n === hover ? 1.35 : 1;
      if (n.kind === 'root') {
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.beginPath(); ctx.arc(n.rx, n.ry, 5, 0, Math.PI * 2); ctx.stroke();
      } else if (n.kind === 'tag') {
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.beginPath(); ctx.arc(n.rx, n.ry, 3.2 * big, 0, Math.PI * 2); ctx.stroke();
        if (on && on.has(n)) {
          ctx.font = `11px ${MONO}`;
          ctx.fillStyle = 'rgba(255,255,255,.8)';
          ctx.fillText(n.label, n.rx + 7, n.ry);
        }
      } else if (n.kind === 'hub') {
        const g = ctx.createRadialGradient(n.rx, n.ry, 0, n.rx, n.ry, 18 * big);
        g.addColorStop(0, `rgba(${n.rgb},.55)`);
        g.addColorStop(1, `rgba(${n.rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(n.rx, n.ry, 18 * big, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = n.color;
        ctx.beginPath(); ctx.arc(n.rx, n.ry, 4.5 * big, 0, Math.PI * 2); ctx.fill();
        // 名字 + 右上角的数量；靠右放不下就画在点的左边
        ctx.font = `12.5px ${MONO}`;
        const w = ctx.measureText(n.label).width;
        ctx.font = `10px ${MONO}`;
        const cw = ctx.measureText(String(n.count)).width;
        const lx = n.rx + 14 + w + cw > W - 8 ? n.rx - 14 - cw - w : n.rx + 11;
        ctx.fillStyle = 'rgba(255,255,255,.6)';
        ctx.fillText(String(n.count), lx + w + 3, n.ry - 13);
        ctx.font = `12.5px ${MONO}`;
        ctx.fillStyle = '#fff';
        ctx.fillText(n.label, lx, n.ry - 9);
      } else if (n.kind === 'post') {
        const [w, h] = SIZE.post.map(v => v * big);
        roundRect(n.rx - w / 2, n.ry - h / 2, w, h, 3);
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.fill();
        ctx.fillStyle = 'rgba(20,22,32,.55)';
        ctx.fillRect(n.rx - w / 2 + 4, n.ry - h / 2 + 5, w * 0.55, 1.6);
        ctx.fillRect(n.rx - w / 2 + 4, n.ry - h / 2 + 9, w - 8, 1.2);
        ctx.fillRect(n.rx - w / 2 + 4, n.ry - h / 2 + 12.5, w - 12, 1.2);
        ctx.font = `12px ${SANS}`;
        ctx.fillStyle = 'rgba(255,255,255,.88)';
        // 靠右边的标题画在左侧，不出面板
        const label = short(n.item.t, 14), right = n.rx > W - 170;
        ctx.textAlign = right ? 'right' : 'left';
        ctx.fillText(label, right ? n.rx - w / 2 - 6 : n.rx + w / 2 + 6, n.ry);
        ctx.textAlign = 'left';
      } else {
        const [w, h] = SIZE[n.kind].map(v => v * big);
        const x = n.rx - w / 2, y = n.ry - h / 2;
        if (atlas) {
          const it = n.item;
          ctx.drawImage(atlas, it.x, it.y, it.w, it.h, x, y, w, h);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,.18)';
          ctx.fillRect(x, y, w, h);
        }
        ctx.strokeStyle = n === hover ? '#fff' : 'rgba(255,255,255,.45)';
        ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    raf = 0;
    if (!shown) return;
    const settling = alpha > 0.004 || alphaTarget > 0;
    if (settling) tick();
    // 停下来以后只剩轻轻漂：没有鼠标时 30fps 就够
    if (settling || pointer || drag || (frame++ & 1) === 0) draw(now);
    if (tipFor) placeTip(tipFor);
    if (!still || settling) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (!raf && shown) raf = requestAnimationFrame(loop);
  }

  // --- 交互 -------------------------------------------------------------
  // 后画的在上面，所以倒着找
  function hit(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], size = SIZE[n.kind];
      if (size ? Math.abs(x - n.rx) <= size[0] / 2 + 3 && Math.abs(y - n.ry) <= size[1] / 2 + 3
        : Math.hypot(x - n.rx, y - n.ry) < (n.kind === 'hub' ? 14 : 9)) return n;
    }
    return null;
  }

  function setHover(n) {
    if (n === hover) return;
    hover = n;
    lit = litSet(n);
    canvas.style.cursor = n && n.kind !== 'root' ? 'pointer' : '';
    document.querySelectorAll('.atlas-index a[data-hub]').forEach(a => {
      const hub = n && (n.kind === 'hub' ? n : n.hub);
      a.classList.toggle('is-hot', !!hub && a.dataset.hub === hub.id);
    });
    showTip(n);
    kick();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  const stars = r => (r ? '★'.repeat(r) + '☆'.repeat(5 - r) : '');

  function showTip(n) {
    tipFor = n && n.kind !== 'root' ? n : null;
    if (!tipFor) { tip.hidden = true; return; }
    tip.replaceChildren();
    const text = el('div', 'atlas-tip-text');
    if (n.item && SIZE[n.kind] && n.kind !== 'post') {
      const it = n.item, art = el('div', 'atlas-tip-art');
      const scale = 2;
      art.style.width = it.w / scale * 1.4 + 'px';
      art.style.height = it.h / scale * 1.4 + 'px';
      art.style.backgroundImage = `url(${atlas ? atlas.src : ''})`;
      const k = 1.4 / scale;
      art.style.backgroundSize = `${host.__atlasW * k}px auto`;
      art.style.backgroundPosition = `${-it.x * k}px ${-it.y * k}px`;
      tip.append(art);
      text.append(el('small', '', `${MEDIA[n.kind].name}${it.y ? ' · ' + it.y : ''}`), el('strong', '', it.t));
      if (it.s) text.append(el('span', '', it.s));
      const meta = [stars(it.r), it.n].filter(Boolean).join('  ');
      if (meta) text.append(el('em', '', meta));
    } else if (n.kind === 'post') {
      const p = n.item;
      text.append(el('small', '', `${p.c || '文章'} · ${p.d}`), el('strong', '', p.t));
      if (p.e) text.append(el('span', '', p.e));
    } else if (n.kind === 'hub') {
      text.append(el('small', '', '分区'), el('strong', '', `${n.label} · ${n.count}`), el('span', '', '点击进入'));
    } else if (n.kind === 'tag') {
      text.append(el('small', '', '标签'), el('strong', '', n.label));
    }
    tip.append(text);
    tip.hidden = false;
    tipSize = [tip.offsetWidth, tip.offsetHeight]; // 量一次，之后每帧只写位置
    placeTip(n);
  }
  let tipSize = [0, 0];
  function placeTip(n) {
    const [w, h] = tipSize;
    let x = n.rx + 18, y = n.ry - h / 2;
    if (x + w > W - 10) x = n.rx - 18 - w;
    y = Math.min(H - h - 10, Math.max(10, y));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function open(n) {
    if (!n || n.kind === 'root' || n.kind === 'tag') return;
    if (n.kind === 'hub') location.href = n.href;
    else if (n.kind === 'post' || n.kind === 'album') location.href = n.item.u;
    else window.open(n.item.u, '_blank', 'noopener');
  }

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointermove', e => {
    pointer = pos(e);
    if (drag) {
      if (Math.hypot(pointer.x - drag.sx, pointer.y - drag.sy) > 4) drag.moved = true;
      drag.node.x = pointer.x;
      drag.node.y = pointer.y;
    } else if (e.pointerType !== 'touch') setHover(hit(pointer.x, pointer.y));
    kick();
  });
  canvas.addEventListener('pointerdown', e => {
    const p = pos(e), n = hit(p.x, p.y);
    if (e.pointerType === 'touch') {
      // 手机：第一下看详情，再点一下同一个才打开；不拖动，页面照常滚
      if (n && n === hover) open(n);
      else setHover(n);
      return;
    }
    if (!n || n.kind === 'root') return;
    drag = { node: n, sx: p.x, sy: p.y, moved: false };
    n.fixed = true;
    alphaTarget = 0.22;
    canvas.setPointerCapture(e.pointerId);
    kick();
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    const { node: n, moved } = drag;
    n.fixed = false;
    drag = null;
    alphaTarget = 0;
    if (!moved) open(n);
  });
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    setHover(null);
  });

  document.querySelectorAll('.atlas-index a[data-hub]').forEach(a => {
    a.addEventListener('mouseenter', () => setHover(hubs.get(a.dataset.hub) || null));
    a.addEventListener('mouseleave', () => setHover(null));
  });

  // --- 尺寸、可见性 -------------------------------------------------------
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    if (W && H) nodes.forEach(n => { n.x *= w / W; n.y *= h / H; });
    W = w; H = h; L = Math.min(W, H * 1.25);
    if (hubs.size && nodes[0].x) anchor();
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (nodes.length) { alpha = Math.max(alpha, 0.15); kick(); }
  }
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => {
    shown = entry.isIntersecting && !document.hidden;
    kick();
  }).observe(host);
  document.addEventListener('visibilitychange', () => {
    shown = !document.hidden;
    kick();
  });

  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)).join(',');
  fetch(host.dataset.src)
    .then(r => r.json())
    .then(data => {
      host.__atlasW = data.media?.w || 1024;
      build(data);
      nodes.forEach(n => { if (n.color) n.rgb = hex(n.color); });
      // 文章、标签挂在分区上的连线用分区的颜色
      links.forEach(l => { if (!l.a.rgb && l.a.hub) l.a.rgb = l.a.hub.rgb; });
      document.querySelectorAll('.atlas-index a[data-hub]').forEach(a => {
        const h = hubs.get(a.dataset.hub);
        if (h) a.style.setProperty('--hub', h.color);
      });
      resize();
      seed();
      if (still) { for (let i = 0; i < 320; i++) tick(); alpha = 0; }
      host.classList.add('is-ready');
      kick();
    })
    .catch(error => console.warn('星图：数据没加载出来', error));
})();
