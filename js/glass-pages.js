// 独立页面（封面 /cover-demo/、唱片架 /records/、海报墙 /posters/）共用：
// 提示条、液态玻璃导航的滑块、珍珠流动背景。页面自己的脚本通过
// window.GlassPages 用到 say()（提示条）、still（是否减少动态效果）和
// holdBackdrop()（大动画期间暂停背景流动）。
(() => {
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  // 提示条
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  let toastTimer;
  function say(text, ms = 2200) {
    toast.textContent = text;
    toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toast.classList.remove('is-shown'), ms);
  }

  // 导航滑块（照 GlassSegmented.tsx）：点哪一项，滑块就用弹簧曲线滑过去
  // （transform + width，0.35s），滑到了再跳转
  const segTrack = document.querySelector('.seg-track');
  if (segTrack) {
    const indicator = segTrack.querySelector('.seg-indicator');
    const here = segTrack.querySelector('.seg.is-current');
    let active = here, leaving = 0;

    const place = (seg, animate = true) => {
      if (!seg) return;
      if (!animate) indicator.style.transition = 'none';
      indicator.style.width = seg.offsetWidth + 'px';
      indicator.style.transform = `translateX(${seg.offsetLeft}px)`;
      if (!animate) {
        void indicator.offsetWidth;
        indicator.style.transition = '';
      }
    };
    const select = seg => {
      if (seg === active) return;
      active?.classList.remove('is-current');
      active?.removeAttribute('aria-current');
      seg.classList.add('is-current');
      seg.setAttribute('aria-current', 'page');
      active = seg;
      place(seg);
    };
    segTrack.addEventListener('click', e => {
      const seg = e.target.closest('.seg');
      // 新标签页打开等修饰键点击交给浏览器
      if (!seg || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      select(seg);
      clearTimeout(leaving);
      if (seg !== here) leaving = setTimeout(() => location.assign(seg.href), still.matches ? 0 : 350);
    });
    // 左右方向键在各项之间移动焦点
    segTrack.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const segs = [...segTrack.querySelectorAll('.seg')].filter(seg => seg.offsetWidth > 0);
      const i = segs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      segs[(i + (e.key === 'ArrowRight' ? 1 : segs.length - 1)) % segs.length].focus();
    });
    const placeActive = () => place(active, false);
    addEventListener('resize', placeActive);
    document.fonts?.ready.then(placeActive);
    // 从别的页面后退回来时（bfcache）回到本页
    addEventListener('pageshow', e => {
      if (!e.persisted) return;
      clearTimeout(leaving);
      if (here) select(here);
      placeActive();
    });
    placeActive();
  }

  // 背景（珍珠配色）：几团柔和的色块按各自的轨迹慢慢漂，边缘再加一点液体般的扭曲（mesh gradient）。
  // 渐变很平滑，按半分辨率渲染看不出差别；30fps；减少动态时只画一帧
  const PEARL = { base: [.969, .961, .984], colors: [[1, .82, .74], [.82, .78, 1], [.72, .86, 1], [.74, .95, .87], [1, .94, .72]] };
  const bgHost = document.getElementById('web_bg');
  const bgCanvas = bgHost?.querySelector('.pearl-flow');
  const BG_EPOCH = performance.now();
  let bg = null, bgFrame = 0, lastBgDraw = 0, held = false;

  function cssFallback() {
    const rgb = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
    const spots = [[18, 22], [82, 25], [70, 80], [25, 78], [50, 50]];
    bgHost.style.setProperty('background', spots.map(([x, y], i) =>
      `radial-gradient(circle at ${x}% ${y}%, ${rgb(PEARL.colors[i])} 0%, transparent 45%)`).join(',') + `, ${rgb(PEARL.base)}`, 'important');
  }
  function startBg() {
    const gl = bgCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return false;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `attribute vec2 a;
      void main() { gl_Position = vec4(a, 0.0, 1.0); }`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `precision mediump float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform vec3 u_base;
      uniform vec3 u_c[5];
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void spot(inout vec3 col, inout float sum, vec2 p, vec2 c, float r, vec3 k) {
        vec2 d = p - c;
        float w = exp(-dot(d, d) / (r * r));
        col += k * w;
        sum += w;
      }
      void main() {
        float aspect = u_res.x / u_res.y;
        vec2 uv = gl_FragCoord.xy / u_res;
        vec2 p = vec2(uv.x * aspect, 1.0 - uv.y);
        float t = u_time;
        p += 0.06 * vec2(sin(p.y * 3.1 + t * 0.21), cos(p.x * 2.7 - t * 0.17));
        vec3 col = u_base * 0.6;
        float sum = 0.6;
        spot(col, sum, p, vec2(aspect * (0.18 + 0.10 * sin(t * 0.13)), 0.22 + 0.10 * cos(t * 0.11)), 0.42, u_c[0]);
        spot(col, sum, p, vec2(aspect * (0.82 + 0.08 * cos(t * 0.09)), 0.26 + 0.12 * sin(t * 0.14)), 0.40, u_c[1]);
        spot(col, sum, p, vec2(aspect * (0.68 + 0.12 * sin(t * 0.07 + 1.0)), 0.80 + 0.08 * cos(t * 0.12)), 0.46, u_c[2]);
        spot(col, sum, p, vec2(aspect * (0.24 + 0.10 * cos(t * 0.10 + 2.0)), 0.78 + 0.10 * sin(t * 0.08)), 0.40, u_c[3]);
        spot(col, sum, p, vec2(aspect * (0.50 + 0.16 * sin(t * 0.06 + 3.0)), 0.50 + 0.14 * cos(t * 0.09)), 0.36, u_c[4]);
        col /= sum;
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // 抖动，避免渐变出现色带
        gl_FragColor = vec4(col, 1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_base'), PEARL.base);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_c'), PEARL.colors.flat());
    bg = { gl, res: gl.getUniformLocation(program, 'u_res'), time: gl.getUniformLocation(program, 'u_time') };
    fitBg();
    return true;
  }
  function fitBg() {
    if (!bg) return;
    bgCanvas.width = Math.max(1, Math.round(innerWidth * 0.5));
    bgCanvas.height = Math.max(1, Math.round(innerHeight * 0.5));
    bg.gl.viewport(0, 0, bgCanvas.width, bgCanvas.height);
    drawBg(performance.now());
  }
  function drawBg(now) {
    const { gl } = bg;
    gl.uniform2f(bg.res, bgCanvas.width, bgCanvas.height);
    gl.uniform1f(bg.time, still.matches ? 0 : (now - BG_EPOCH) / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function loopBg(now) {
    bgFrame = 0;
    if (held) return;
    if (now - lastBgDraw >= 1000 / 30 - 1) {
      lastBgDraw = now;
      drawBg(now);
    }
    if (!still.matches) bgFrame = requestAnimationFrame(loopBg);
  }
  const wakeBg = () => { if (bg && !bgFrame && !held) bgFrame = requestAnimationFrame(loopBg); };
  // 页面在做大动画时（比如唱片架翻动）先停住背景，停稳再继续流动
  function holdBackdrop(on) {
    held = Boolean(on);
    if (!held) wakeBg();
  }

  if (bgCanvas) {
    let bgReady = false;
    try { bgReady = startBg(); } catch (error) { console.warn('背景：WebGL 不可用，改用静态渐变。', error); }
    if (bgReady) {
      addEventListener('resize', fitBg);
      still.addEventListener('change', wakeBg);
      wakeBg();
    } else cssFallback();
  }

  window.GlassPages = { say, still, holdBackdrop };
})();
