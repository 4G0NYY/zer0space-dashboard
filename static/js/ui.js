/* Small interactions that appear on more than one page.

   All of it is delegated from `document`, so it works for markup that JavaScript
   renders later — the vault list and the service tables are built after this
   script has already run, and neither needs to register anything.

   Defines window.ZS_UI. */
(function () {
  'use strict';

  /* --- Password reveal --------------------------------------------------- */

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-toggle-password]');
    if (!toggle) return;
    var input = document.getElementById(toggle.getAttribute('data-toggle-password'));
    if (!input) return;
    var revealing = input.type === 'password';
    input.type = revealing ? 'text' : 'password';
    toggle.setAttribute('aria-label', window.I18N.t(revealing ? 'common.hidePassword' : 'common.showPassword'));
    toggle.setAttribute('aria-pressed', String(revealing));
  });

  /* --- Modals ------------------------------------------------------------ */

  var lastFocused = null;

  function openModal(id) {
    var modal = document.getElementById('modal-' + id);
    if (!modal) return null;
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    var focusable = modal.querySelector('input:not([type=hidden]), textarea, select, button');
    if (focusable) focusable.focus();
    return modal;
  }

  function closeModal(modal) {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    // Return focus to whatever opened the dialog. Without this, a keyboard user
    // lands back at the top of the document every time they close one.
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  }

  function closeAll() {
    document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-modal-open]');
    if (opener) {
      event.preventDefault();
      openModal(opener.getAttribute('data-modal-open'));
      return;
    }
    if (event.target.closest('[data-modal-close]')) {
      closeModal(event.target.closest('.modal'));
      return;
    }
    // A click on the backdrop itself — but not on the card inside it.
    if (event.target.classList.contains('modal')) closeModal(event.target);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAll();
  });

  /* --- Clipboard --------------------------------------------------------- */

  /* navigator.clipboard is unavailable on plain HTTP (non-secure context), and
     the dashboard is routinely reached over http://node:8080 on the LAN — so
     the textarea fallback is the path that actually runs there, not a legacy
     nicety. Returns a promise for a boolean. */
  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) { /* fall through to the manual path */ }
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  /* Copy, then say so on the button that was pressed. The confirmation has to
     land where the eye already is — a toast in the corner gets missed. */
  async function copyWithFeedback(text, button) {
    var ok = await copy(text);
    if (!button) return ok;
    var original = button.textContent;
    button.textContent = window.I18N.t(ok ? 'common.copied' : 'err.INTERNAL');
    button.disabled = true;
    window.setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
    return ok;
  }

  /* --- Formatting -------------------------------------------------------- */

  function bytes(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var n = Number(value);
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
  }

  function rate(bytesPerSecond) {
    if (bytesPerSecond === null || bytesPerSecond === undefined || isNaN(bytesPerSecond)) return '—';
    return bytes(bytesPerSecond) + '/s';
  }

  function percent(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return Math.round(Number(value)) + '%';
  }

  function dateTime(iso) {
    if (!iso) return window.I18N.t('common.never');
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(window.I18N.lang === 'de' ? 'de-CH' : 'en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function relative(iso) {
    if (!iso) return window.I18N.t('common.never');
    var then = new Date(iso).getTime();
    if (isNaN(then)) return String(iso);
    var minutes = Math.round((Date.now() - then) / 60000);
    var fmt = new Intl.RelativeTimeFormat(window.I18N.lang === 'de' ? 'de' : 'en', { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return fmt.format(-minutes, 'minute');
    if (Math.abs(minutes) < 60 * 24) return fmt.format(-Math.round(minutes / 60), 'hour');
    return fmt.format(-Math.round(minutes / 1440), 'day');
  }

  /* --- Escaping ---------------------------------------------------------- */

  /* Every string that comes from the database or from the Docker API goes
     through this before it reaches innerHTML. Service names, hostnames and
     vault titles are all user-controlled. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* A URL is only safe to put in href= if it is http(s) or a site-relative
     path. javascript: and data: are the two that turn a service tile into an
     XSS vector. */
  function safeUrl(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\//.test(raw) && !/^\/\//.test(raw)) return raw;
    try {
      var parsed = new URL(raw, window.location.origin);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
    } catch (err) {
      return '';
    }
  }

  window.ZS_UI = {
    openModal: openModal,
    closeModal: closeModal,
    closeAll: closeAll,
    copy: copy,
    copyWithFeedback: copyWithFeedback,
    bytes: bytes,
    rate: rate,
    percent: percent,
    dateTime: dateTime,
    relative: relative,
    esc: esc,
    safeUrl: safeUrl
  };
})();
