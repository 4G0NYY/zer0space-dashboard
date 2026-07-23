/* Tabler icon helpers for service tiles.

   Any icon from https://tabler.io/icons is usable — the webfont is vendored
   under static/vendor/tabler/ (the CSP forbids a CDN). A service stores just the
   icon NAME (e.g. "server", "brand-docker"); it is rendered as a `ti ti-<name>`
   class, never as markup.

   That is the safety boundary: the name is sanitised to [a-z0-9-], so it can
   only ever produce a class token — there is nothing to inject even though the
   value is admin-controlled and reaches innerHTML. An unknown name renders as an
   empty glyph, which is why the editor shows a live preview before saving.

   Defines window.ZS_ICONS. */
(function () {
  'use strict';

  // A short list of common homelab picks, shown as quick-pick chips under the
  // input. Not a limit — just shortcuts. Every one is a real Tabler outline name.
  var SUGGEST = [
    'server', 'database', 'cloud', 'world', 'network', 'topology-star-3',
    'gauge', 'chart-line', 'activity', 'shield-lock', 'lock', 'key',
    'terminal-2', 'brand-docker', 'git-branch', 'folder', 'file-text', 'photo',
    'movie', 'music', 'mail', 'bell', 'rss', 'camera', 'cpu', 'device-desktop',
    'wifi', 'download', 'book-2', 'home', 'settings', 'robot'
  ];

  /* Reduce whatever the user typed to a bare icon name. Tolerates pasting the
     full class ("ti ti-server"), a leading "ti-", stray spaces and case. */
  function sanitize(value) {
    return String(value || '')
      .toLowerCase()
      .trim()
      .replace(/^ti\s+ti-/, '')
      .replace(/^ti-/, '')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 60);
  }

  /* The class attribute for a name, or '' when there is no usable name. */
  function cls(name) {
    var slug = sanitize(name);
    return slug ? 'ti ti-' + slug : '';
  }

  window.ZS_ICONS = {
    sanitize: sanitize,
    cls: cls,
    suggest: SUGGEST
  };
})();
