/* Applies the stored theme before first paint.

   Loaded with `defer` in <head>, ahead of everything else. Without it the page
   renders one frame in the default accent and then snaps to the user's colour,
   which is more noticeable than it sounds on a dark UI.

   The accent is stored per browser (localStorage) AND per account
   (users.theme). localStorage wins here because it is available synchronously;
   app.js reconciles it with the server value once /api/me answers. */
(function () {
  'use strict';

  var PRESETS = ['aurora', 'cyan', 'violet', 'ember', 'mint', 'rose'];

  function apply(value) {
    if (!value) return;
    var root = document.documentElement;
    if (PRESETS.indexOf(value) !== -1) {
      root.setAttribute('data-theme', value);
      root.style.removeProperty('--accent');
    } else if (/^#[0-9a-f]{6}$/i.test(value)) {
      // A custom hex has no preset to select, so the variable is set directly
      // and data-theme is parked on a name that defines nothing else.
      root.setAttribute('data-theme', 'custom');
      root.style.setProperty('--accent', value);
    }
  }

  try {
    apply(localStorage.getItem('zs-theme'));
  } catch (e) { /* storage blocked — the default accent is a fine outcome */ }

  window.ZS_THEME = {
    presets: PRESETS,
    apply: apply,
    save: function (value) {
      apply(value);
      try { localStorage.setItem('zs-theme', value); } catch (e) { /* ignore */ }
    },
    current: function () {
      try { return localStorage.getItem('zs-theme') || 'aurora'; } catch (e) { return 'aurora'; }
    }
  };
})();
