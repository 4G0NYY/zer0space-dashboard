/* Monitoring wall.

   A self-contained, always-on view. Unlike the dashboard it polls even when the
   tab is not focused (that is the whole point — it lives on a screen nobody
   clicks), and it never navigates: a failed poll shows a banner and the last
   good numbers stay on screen rather than blanking, because a wall display going
   empty is indistinguishable from the thing it monitors going down.

   Renders with the same .tile / .host classes as the dashboard (styled by
   dashboard.css), so the two never drift apart in how a host card looks. */
(function () {
  'use strict';

  var UI = window.ZS_UI;
  var API = window.API;
  var t = window.t;
  var esc = UI.esc;

  var POLL = 12000;
  var lastGood = null;

  function $(id) { return document.getElementById(id); }

  /* --- Clock ------------------------------------------------------------- */

  function tickClock() {
    var now = new Date();
    var el = $('wall-clock');
    if (el) el.textContent = now.toLocaleTimeString(window.I18N.lang === 'de' ? 'de-CH' : 'en-GB');
  }

  /* --- Tiles (mirrors app.js, kept compact) ------------------------------ */

  function tile(label, valueHtml, detail, state) {
    return '<div class="tile" data-state="' + esc(state || 'unknown') + '">' +
             '<span class="tile-label">' + esc(label) + '</span>' +
             '<span class="tile-value">' + valueHtml + '</span>' +
             '<span class="tile-detail">' + esc(detail) + '</span>' +
           '</div>';
  }

  function renderTiles(data) {
    var box = $('wall-tiles');
    if (!box) return;
    var T = data.tiles;
    var backupDetail = T.backup.lastRun
      ? UI.relative(T.backup.lastRun) + ' · ' + t('backup.' + T.backup.detail)
      : t('tile.backupNever');
    var managers = (T.cluster.managersTotal !== null && T.cluster.managersTotal !== undefined)
      ? T.cluster.managersReachable + '/' + T.cluster.managersTotal + ' Manager · ' : '';

    box.innerHTML = [
      tile(t('tile.nodes'), T.nodes.value + '<small>/' + T.nodes.total + '</small>', t('tile.nodesDetail'), T.nodes.state),
      tile(t('tile.services'), T.services.value === null ? '—' : String(T.services.value), t('tile.servicesDetail'), T.services.state),
      tile(t('tile.cluster'), esc(t('cluster.' + T.cluster.state)), managers + t('cluster.' + T.cluster.detail), T.cluster.state),
      tile(t('tile.infrastructure'), T.infrastructure.value + '<small>/' + T.infrastructure.total + '</small>', t('tile.infraDetail'), T.infrastructure.state),
      tile(t('tile.backup'), esc(t('backup.' + T.backup.detail)), backupDetail, T.backup.state)
    ].join('');

    // Worst tile state becomes the top-line verdict.
    var order = { critical: 3, warning: 2, unknown: 1, healthy: 0 };
    var worst = 'healthy';
    [T.nodes.state, T.services.state, T.cluster.state, T.infrastructure.state, T.backup.state].forEach(function (s) {
      if ((order[s] || 0) > (order[worst] || 0)) worst = s;
    });
    var overall = $('wall-overall');
    if (overall) {
      overall.setAttribute('data-state', worst);
      $('wall-overall-text').textContent = t('mon.overall.' + worst);
    }
  }

  /* --- Hosts (mirrors app.js) -------------------------------------------- */

  function barClass(p) {
    if (p === null || p === undefined) return 'bar';
    if (p >= 90) return 'bar is-crit';
    if (p >= 75) return 'bar is-warn';
    return 'bar';
  }

  function metric(name, percent, detail) {
    var w = (percent === null || percent === undefined || isNaN(percent)) ? 0 : Math.max(0, Math.min(100, Number(percent)));
    return '<div class="metric"><div class="metric-top">' +
             '<span class="metric-name">' + esc(name) + '</span>' +
             '<span class="metric-val">' + esc(detail) + '</span></div>' +
             '<div class="' + barClass(percent) + '"><i style="width:' + w + '%"></i></div></div>';
  }

  function hostCard(host) {
    var badges = '';
    if (host.label) badges += '<span class="badge">' + esc(host.label) + '</span>';
    if (host.role === 'manager') badges += '<span class="badge badge-accent">' + (host.isLeader ? 'Leader' : 'Manager') + '</span>';

    if (!host.online) {
      return '<article class="host is-offline"><div class="host-head">' +
               '<span class="dot" style="color:var(--crit)"></span>' +
               '<span class="host-name">' + esc(host.hostname || '?') + '</span>' + badges +
               '<span class="badge badge-crit">' + esc(t('common.offline')) + '</span></div>' +
               '<p class="host-offline-note">' + esc(t('metric.offline')) + '</p></article>';
    }
    var mem = host.mem || {}, disk = host.disk || {}, net = host.net || {};
    return '<article class="host"><div class="host-head">' +
             '<span class="dot dot-live" style="color:var(--ok)"></span>' +
             '<span class="host-name">' + esc(host.hostname) + '</span>' + badges + '</div>' +
             metric(t('metric.cpu'), host.cpu, UI.percent(host.cpu)) +
             metric(t('metric.ram'), mem.percent, UI.bytes(mem.used) + ' / ' + UI.bytes(mem.total)) +
             metric(t('metric.disk'), disk.percent, UI.bytes(disk.used) + ' / ' + UI.bytes(disk.total)) +
             '<div class="host-net"><span>↓ ' + esc(UI.rate(net.rx_rate)) + '</span>' +
             '<span>↑ ' + esc(UI.rate(net.tx_rate)) + '</span></div></article>';
  }

  function renderHosts(data) {
    var nodes = data.nodes || [];
    if ($('wall-nodes')) {
      $('wall-nodes').innerHTML = nodes.length
        ? nodes.map(hostCard).join('')
        : '<p class="empty">' + esc(t('home.noNodes')) + '</p>';
    }
    var extra = data.extraHosts || [];
    if ($('wall-extra-section')) $('wall-extra-section').hidden = extra.length === 0;
    if ($('wall-extra')) $('wall-extra').innerHTML = extra.map(hostCard).join('');
  }

  function render(data) {
    renderTiles(data);
    renderHosts(data);
    if ($('wall-updated')) $('wall-updated').textContent = t('mon.updated', { time: new Date().toLocaleTimeString(window.I18N.lang === 'de' ? 'de-CH' : 'en-GB') });
    $('wall-banner').hidden = !data.error;
    if (data.error) $('wall-banner').textContent = t('err.' + data.error);
  }

  async function poll() {
    try {
      var data = await API.get('/api/overview');
      lastGood = data;
      render(data);
    } catch (err) {
      if (err.status === 401) { window.location.href = '/login'; return; }
      // Keep the last good numbers up; just flag that we lost contact.
      var banner = $('wall-banner');
      banner.textContent = err.message;
      banner.hidden = false;
      var overall = $('wall-overall');
      if (overall && !lastGood) {
        overall.setAttribute('data-state', 'unknown');
        $('wall-overall-text').textContent = t('mon.overall.unknown');
      }
    }
  }

  /* --- Fullscreen -------------------------------------------------------- */

  if ($('wall-fullscreen')) {
    $('wall-fullscreen').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    });
  }

  window.addEventListener('languagechange:zs', function () {
    tickClock();
    if (lastGood) render(lastGood);
  });

  tickClock();
  setInterval(tickClock, 1000);
  poll();
  // Polls unconditionally — no visibility check. This screen is meant to be left
  // running, and pausing it when unfocused defeats the purpose.
  setInterval(poll, POLL);
})();
