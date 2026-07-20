'use strict';

// Animated starfield for the login page.
//
// This lives in its own file rather than in a <script> block in login.html
// because CSP script-src has no 'unsafe-inline' (see server.js) — an inline
// version is silently blocked by the browser and the background stays black.
//
// Stars drift across three parallax layers (far/mid/near) so the field reads as
// depth rather than as flat noise, and now and then a shooting star crosses the
// view.
//
// Performance notes, since this runs behind the login form on every visit:
//   - The backing store is capped at 2× DPR. On a 3× phone screen an uncapped
//     canvas costs ~2.25× the pixels for no visible gain.
//   - Star count scales with viewport area, so a phone does not pay a desktop's
//     draw call count.
//   - fillStyle strings are looked up from a table instead of being built per
//     star per frame. At ~200 stars × 60 fps that removed ~12k string
//     allocations a second, which was the single largest source of GC churn.
//   - The loop stops entirely when the tab is hidden, and never starts if the
//     user asked for reduced motion (one static frame is drawn instead).
(function () {
  const canvas = document.getElementById('star-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Alpha lookup: 0.00 … 1.00 in 0.02 steps. Quantising the twinkle to 50 levels
  // is invisible at these sizes and lets the style strings be built once.
  const ALPHA_STEPS = 50;
  const FILL = Array.from(
    { length: ALPHA_STEPS + 1 },
    (_, i) => `rgba(255,255,255,${(i / ALPHA_STEPS).toFixed(2)})`
  );

  // Far stars are small, dim and slow; near stars are larger, brighter, faster.
  const LAYERS = [
    { scale: 0.55, drift: 0.012, alpha: 0.30 },
    { scale: 0.85, drift: 0.030, alpha: 0.55 },
    { scale: 1.20, drift: 0.060, alpha: 0.85 },
  ];

  let W = 0, H = 0, dpr = 1;
  let stars = [], shooting = [];
  let rafId = null, resizeTimer = null;

  function build() {
    // ~1 star per 9k CSS px², clamped so neither a phone nor an ultrawide gets
    // an absurd count.
    const count = Math.max(70, Math.min(220, Math.round((W * H) / 9000)));
    stars = new Array(count);
    for (let i = 0; i < count; i++) {
      const layer = LAYERS[i % LAYERS.length];
      const angle = Math.random() * Math.PI * 2;
      stars[i] = {
        x:     Math.random() * W,
        y:     Math.random() * H,
        r:     (Math.random() * 0.9 + 0.3) * layer.scale,
        a:     (Math.random() * 0.55 + 0.20) * layer.alpha,
        speed: Math.random() * 0.40 + 0.15,
        phase: Math.random() * Math.PI * 2,
        vx:    Math.cos(angle) * layer.drift,
        vy:    Math.sin(angle) * layer.drift,
      };
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    // Draw in CSS pixels; the transform handles the device ratio.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    if (reduceMotion) drawStatic();
  }

  function maybeSpawnShootingStar() {
    if (shooting.length < 2 && Math.random() < 0.004) {
      shooting.push({
        x: Math.random() * W * 0.6 + W * 0.15,
        y: Math.random() * H * 0.35,
        angle: Math.PI * 0.2 + Math.random() * 0.18,
        speed: 8 + Math.random() * 5,
        life: 0,
        maxLife: 35 + Math.random() * 20,
      });
    }
  }

  function drawStatic() {
    ctx.clearRect(0, 0, W, H);
    let fill = '';
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const next = FILL[(s.a * ALPHA_STEPS) | 0];
      if (next !== fill) { fill = next; ctx.fillStyle = fill; }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);

    let fill = '';
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.x += s.vx; s.y += s.vy;
      if (s.x < -2) s.x = W + 2; else if (s.x > W + 2) s.x = -2;
      if (s.y < -2) s.y = H + 2; else if (s.y > H + 2) s.y = -2;

      const tw = 0.55 + 0.45 * Math.sin(t * 0.0008 * s.speed + s.phase);
      const next = FILL[(s.a * tw * ALPHA_STEPS) | 0];
      if (next !== fill) { fill = next; ctx.fillStyle = fill; }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    maybeSpawnShootingStar();
    if (shooting.length) {
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      for (let i = 0; i < shooting.length; i++) {
        const s = shooting[i];
        s.life++;
        const dx = Math.cos(s.angle) * s.speed;
        const dy = Math.sin(s.angle) * s.speed;
        s.x += dx; s.y += dy;
        const fade = Math.max(0, 1 - s.life / s.maxLife);
        const grad = ctx.createLinearGradient(s.x, s.y, s.x - dx * 5, s.y - dy * 5);
        grad.addColorStop(0, `rgba(255,255,255,${(fade * 0.85).toFixed(2)})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - dx * 5, s.y - dy * 5);
        ctx.strokeStyle = grad;
        ctx.stroke();
      }
      shooting = shooting.filter(s => s.life < s.maxLife && s.x < W + 60 && s.y < H + 60);
    }

    rafId = requestAnimationFrame(draw);
  }

  function start() {
    if (rafId === null && !reduceMotion) rafId = requestAnimationFrame(draw);
  }
  function stop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  window.addEventListener('resize', () => {
    // Mobile browsers fire resize on every address-bar nudge; rebuilding the
    // star array on each one is wasted work.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // A login page left open in a background tab should not keep a rAF loop alive.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  resize();
  start();
})();
