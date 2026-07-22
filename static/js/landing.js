/* Landing page: in-page nav highlighting.
   The modal, the language toggle and the chibi are handled globally (ui.js,
   i18n.js, chibi.js). */
(function () {
  'use strict';

  var links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var targets = links
    .map(function (link) { return document.querySelector(link.getAttribute('href')); })
    .filter(Boolean);

  if (!targets.length || !('IntersectionObserver' in window)) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      links.forEach(function (link) {
        link.classList.toggle('is-active', link.getAttribute('href') === '#' + entry.target.id);
      });
    });
    // rootMargin pulls the trigger line up to roughly a third down the viewport,
    // so a section counts as "current" once it is genuinely being read rather
    // than the moment its top pixel appears.
  }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });

  targets.forEach(function (target) { observer.observe(target); });
})();
