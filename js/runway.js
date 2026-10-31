/* 文章跑道（思路来自 Shopify Editions 的 explore 模式）：文章列表本身就是一条 3D 跑道，跟着页面滚动走，不用点按钮。
 * 滚到这一段时，平铺的卡片随滚动向后倒下去（0° → 62°）；这一段吸在屏幕上，继续往下滚就沿着跑道往前走，
 * 列表里排第一的在脚下，越往后越远，走过脚下的卡片淡出；走到头这一段松开，接着是页脚。
 * 滚动本身是浏览器原生的（触控板、手指、键盘、滚动条都照常），这里只把滚动位置换算成倾角和前进距离。
 * 博客首页（index.ejs，最新的在脚下）和小说目录（category.ejs，第一章在脚下）共用；
 * 版面是服务端渲染的普通链接，没有脚本或减少动态时就是一列普通卡片。 */
(() => {
  const section = document.querySelector('.runway-inline');
  if (!section || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const plane = section.querySelector('.runway-plane');
  const hint = section.querySelector('.runway-hint');
  const TILT = 62;
  const cards = [...plane.children];
  let near = [], maxY = 0, frame = 0;

  section.classList.add('is-3d');

  // 版面不随滚动变：每张卡片离跑道近端多远、跑道多长，只在尺寸变化时量
  function measure() {
    const h = plane.offsetHeight;
    maxY = Math.max(0, h - innerHeight * 0.9);
    near = cards.map(c => h - c.offsetTop - c.offsetHeight / 2);
    section.style.height = Math.round(innerHeight + maxY) + 'px'; // 多出来的高度 = 跑道能走的距离
    update();
  }

  function update() {
    frame = 0;
    const top = section.getBoundingClientRect().top;
    // 这一段从屏幕底下升上来的过程中慢慢倒下去，顶到屏幕上沿时正好倒平
    const enter = Math.min(1, Math.max(0, 1 - top / innerHeight));
    const tilt = TILT * (1 - (1 - enter) ** 3);
    const y = Math.min(maxY, Math.max(0, -top));
    plane.style.setProperty('--tilt', tilt.toFixed(2) + 'deg');
    plane.style.setProperty('--y', y.toFixed(1) + 'px');
    hint.style.opacity = y > 40 ? 0 : 1;
    cards.forEach((c, i) => {
      const fromNear = near[i] - y; // 负数 = 已经走过脚下（再往前透视会把它放得很大）
      const o = fromNear >= 0 ? 1 : Math.max(0, 1 + fromNear / 240);
      if (c._o === o) return;
      c._o = o;
      c.style.opacity = o.toFixed(3);
      c.style.visibility = o > 0 ? '' : 'hidden';
    });
  }

  addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  addEventListener('resize', measure);
  document.fonts?.ready.then(measure);
  measure();

  // 用 Tab 走到远处的卡片时，把页面滚到它走到跟前的位置
  plane.addEventListener('focusin', e => {
    const i = cards.indexOf(e.target.closest('.runway-card'));
    if (i < 0) return;
    const sectionTop = section.getBoundingClientRect().top + scrollY;
    scrollTo({ top: sectionTop + Math.min(maxY, Math.max(0, near[i] - innerHeight * 0.3)), behavior: 'smooth' });
  });
})();
