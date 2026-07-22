/* The drifting starfield behind everything.

   A canvas rather than hundreds of DOM nodes: this runs on every page including
   the dashboard, where the browser already has plenty to lay out.

   Three things keep it from being a battery tax:
   - it stops entirely when the tab is hidden,
   - it does not run at all under prefers-reduced-motion,
   - it caps the device pixel ratio at 2, because a 3x retina canvas costs 2.25x
     the fill rate for no visible gain on a field of 1 px dots. */
(function () {
  'use strict';

  var canvas = document.getElementById('starfield');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  var stars = [];
  var width = 0;
  var height = 0;
  var dpr = 1;
  var running = true;
  var frame = null;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    // Density by area, not a fixed count: a fixed count is sparse on a 32:9
    // ultrawide and crowded on a phone.
    var count = Math.round(Math.min(260, Math.max(70, (width * height) / 9000)));
    stars = [];
    for (var i = 0; i < count; i++) {
      var depth = Math.random();
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.45 + depth * 1.15,
        // Parallax: distant stars are smaller, dimmer and slower.
        vy: 0.012 + depth * 0.055,
        alpha: 0.18 + depth * 0.55,
        twinkle: Math.random() * Math.PI * 2,
        speed: 0.6 + Math.random() * 1.4
      });
    }
  }

  function draw(now) {
    frame = null;
    if (!running) return;

    ctx.clearRect(0, 0, width, height);
    var time = now / 1000;

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.y -= s.vy;
      if (s.y < -2) {
        s.y = height + 2;
        s.x = Math.random() * width;
      }
      var flicker = 0.72 + 0.28 * Math.sin(time * s.speed + s.twinkle);
      ctx.globalAlpha = s.alpha * flicker;
      ctx.fillStyle = '#cfe1ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    schedule();
  }

  function schedule() {
    if (running && frame === null) frame = window.requestAnimationFrame(draw);
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 160);
  });

  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    if (running) schedule();
  });

  resize();
  schedule();
})();
