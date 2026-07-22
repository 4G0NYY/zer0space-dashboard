/* Standalone loading screen.

   The progress bar is honest about being an estimate: it eases toward 92% and
   stops there. It only reaches 100% when /healthz actually answers, at which
   point the page moves on. A bar that animates to 100% and then sits there is
   worse than no bar — it says "done" while nothing has happened. */
(function () {
  'use strict';

  var bar = document.getElementById('loading-bar');
  var pct = document.getElementById('loading-pct');
  var meter = document.getElementById('loading-progress');
  if (!bar) return;

  var value = 0;
  var arrived = false;

  function paint(next) {
    value = next;
    bar.style.width = value + '%';
    if (pct) pct.textContent = Math.round(value) + '%';
    if (meter) meter.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  var timer = window.setInterval(function () {
    if (arrived) return;
    // Decelerating approach to the ceiling: fast while there is a lot of room
    // left, slower as it runs out.
    var step = Math.max(0.4, (92 - value) * 0.08);
    paint(Math.min(92, value + step));
  }, 220);

  async function probe() {
    try {
      var response = await fetch('/healthz', { cache: 'no-store' });
      if (!response.ok) throw new Error('not ready');
      arrived = true;
      window.clearInterval(timer);
      paint(100);
      window.setTimeout(function () {
        window.location.href = '/dashboard';
      }, 420);
    } catch (err) {
      window.setTimeout(probe, 1500);
    }
  }

  paint(6);
  probe();
})();
