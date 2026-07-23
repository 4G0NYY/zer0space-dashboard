/* A small, curated icon set for service tiles.

   Stored as the inner markup of a 24×24 stroke SVG, keyed by a short name. The
   name is what lands in the database (services.icon) — never the markup — so the
   stored value stays a harmless slug and rendering is this file's job.

   Why a fixed set rather than "paste any SVG" or an emoji field: an SVG field is
   a stored-XSS hole the moment it reaches innerHTML, and emoji render
   inconsistently across platforms. A name that indexes into this map is safe by
   construction — an unknown name simply falls back to the service's initials.

   Every path uses currentColor, so the tiles pick up the accent for free.

   Defines window.ZS_ICONS. */
(function () {
  'use strict';

  // Each value is stroke-drawn unless it sets its own fill.
  var PATHS = {
    grid:     '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    server:   '<rect x="3.5" y="4" width="17" height="6" rx="1.6"/><rect x="3.5" y="14" width="17" height="6" rx="1.6"/><path d="M7 7h.01M7 17h.01M11 7h5M11 17h5"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
    cloud:    '<path d="M7 18.5a4.2 4.2 0 0 1-.4-8.38A5.6 5.6 0 0 1 17.4 9.9 3.8 3.8 0 0 1 17 18.5Z"/>',
    shield:   '<path d="M12 3.2 5 6v5.4c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6Z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
    lock:     '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7M12 14.6v2.2"/>',
    media:    '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="m10 9.5 5 2.5-5 2.5Z"/>',
    download: '<path d="M12 3.5v11M8 11l4 3.6 4-3.6M5 19.5h14"/>',
    chart:    '<path d="M4 20V4M4 20h16M8 16.5v-4M12 16.5V8M16 16.5v-6"/>',
    network:  '<circle cx="12" cy="5" r="2.3"/><circle cx="5.5" cy="19" r="2.3"/><circle cx="18.5" cy="19" r="2.3"/><path d="M12 7.3v3.2M12 10.5 6.4 17M12 10.5 17.6 17"/>',
    terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"/>',
    docker:   '<path d="M4 12h15.5a2.5 2.5 0 0 1-2.5 5H8a4 4 0 0 1-4-4Z"/><path d="M7 11.5V9M10 11.5V9M13 11.5V9M10 8.2V6M13 8.2V6"/>',
    git:      '<circle cx="7" cy="7" r="2.2"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 9.2v5.6M9.1 8.4l6 2.6"/>',
    mail:     '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5"/>',
    file:     '<path d="M6.5 3.5h7l4.5 4.5v12a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M13 3.5V8h4.5"/>',
    folder:   '<path d="M4 6.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2.2h7A1.5 1.5 0 0 1 20 8.7v9.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18Z"/>',
    home:     '<path d="M3.6 10.4 12 3.7l8.4 6.7V20a1 1 0 0 1-1 1h-4.6v-6H9.2v6H4.6a1 1 0 0 1-1-1Z"/>',
    cpu:      '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3.5v3M15 3.5v3M9 17.5v3M15 17.5v3M3.5 9h3M3.5 15h3M17.5 9h3M17.5 15h3"/>',
    globe:    '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.2 3.6 5.1 3.6 8.2S14.4 18 12 20.2C9.6 18 8.4 15.1 8.4 12S9.6 6 12 3.8Z"/>',
    book:     '<path d="M5 4.5h9a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 0 5 22Z"/><path d="M16.5 7H19v15H7.5"/>',
    music:    '<path d="M9 17.5V6l9-2v9.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="15.5" cy="15.5" r="2.5"/>',
    image:    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4.5 17 4.5-4 3 2.5 3.5-3.5 4 4"/>',
    key:      '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20l-1.8 2M16 12v2.5"/>',
    rss:      '<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="5.6" cy="18.4" r="1.4" fill="currentColor" stroke="none"/>',
    bell:     '<path d="M6.5 10.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    camera:   '<path d="M4.5 8.5h3l1.5-2h6l1.5 2h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3"/>',
    gauge:    '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l3.5-3.5"/><circle cx="12" cy="15" r="1"/>',
    wifi:     '<path d="M4 9a12 12 0 0 1 16 0M7 12.5a7 7 0 0 1 10 0M9.8 16a3 3 0 0 1 4.4 0"/><circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none"/>',
    ai:       '<rect x="4.5" y="7" width="15" height="12" rx="3"/><path d="M12 7V4M9 12.5h.01M15 12.5h.01M9.5 16h5M2.4 12.5h2M19.6 12.5h2"/>',
    box:      '<path d="M12 3.5 4 7.5v9l8 4 8-4v-9Z"/><path d="m4 7.5 8 4 8-4M12 11.5v9"/>',
    play:     '<circle cx="12" cy="12" r="8.2"/><path d="m10 8.5 5 3.5-5 3.5Z"/>'
  };

  // Alias a few obvious synonyms so a name the user reaches for still resolves.
  var ALIAS = {
    layout: 'grid', dashboard: 'grid', apps: 'grid',
    db: 'database', postgres: 'database', sql: 'database',
    vault: 'lock', password: 'lock', secure: 'shield', security: 'shield',
    video: 'media', movie: 'media', jellyfin: 'media', plex: 'media',
    metrics: 'chart', stats: 'chart', grafana: 'chart',
    console: 'terminal', shell: 'terminal', ssh: 'terminal',
    container: 'docker', portainer: 'docker',
    photos: 'image', gallery: 'image', pdf: 'file', docs: 'file',
    files: 'folder', storage: 'folder', nas: 'folder',
    email: 'mail', smtp: 'mail', feed: 'rss', notify: 'bell',
    speed: 'gauge', status: 'gauge', uptime: 'gauge',
    web: 'globe', dns: 'globe', wiki: 'book', notes: 'book'
  };

  // The order the picker shows them in — deliberate, common ones first.
  var ORDER = [
    'grid', 'server', 'database', 'cloud', 'network', 'gauge', 'chart',
    'shield', 'lock', 'key', 'terminal', 'docker', 'box', 'git',
    'media', 'play', 'image', 'music', 'camera', 'globe', 'wifi',
    'mail', 'bell', 'rss', 'file', 'folder', 'book', 'home', 'cpu', 'ai'
  ];

  function resolve(name) {
    if (!name) return null;
    var key = String(name).toLowerCase().trim();
    if (PATHS[key]) return key;
    if (ALIAS[key]) return ALIAS[key];
    return null;
  }

  /* Full <svg> string for a name, or null if it is not in the set. */
  function svg(name, size) {
    var key = resolve(name);
    if (!key) return null;
    var s = size || 22;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
           'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
           'stroke-linejoin="round" aria-hidden="true">' + PATHS[key] + '</svg>';
  }

  window.ZS_ICONS = {
    svg: svg,
    resolve: resolve,
    names: ORDER,
    has: function (name) { return resolve(name) !== null; }
  };
})();
