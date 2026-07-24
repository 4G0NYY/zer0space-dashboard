/* Sign-in form, plus the optional 2FA step. */
(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var errorBox = document.getElementById('login-error');
  var submit = document.getElementById('login-submit');
  var username = document.getElementById('username');
  var password = document.getElementById('password');
  var remember = document.getElementById('remember');
  if (!form) return;

  var twofaForm = document.getElementById('twofa-form');
  var twofaError = document.getElementById('twofa-error');
  var twofaSubmit = document.getElementById('twofa-submit');
  var twofaCode = document.getElementById('twofa-code');
  var authDivider = document.getElementById('auth-divider');
  var registerCta = document.getElementById('register-cta');
  var authFoot = document.getElementById('auth-foot');

  var REMEMBER_KEY = 'zs-remember';

  /* "Remember me" stores the USERNAME only, and only in this browser. It has
     nothing to do with session lifetime — the session cookie's max-age is a
     server-side decision (24h, because it holds the derived vault key) and is
     deliberately not something a checkbox on a login form can extend. */
  try {
    var saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) {
      username.value = saved;
      remember.checked = true;
      password.focus();
    }
  } catch (e) { /* storage blocked */ }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function goToDashboard() {
    try {
      if (remember.checked) localStorage.setItem(REMEMBER_KEY, username.value.trim());
      else localStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* storage blocked */ }
    window.location.href = '/dashboard';
  }

  function enterTwofaStep(csrfToken) {
    window.API.setCsrfToken(csrfToken);
    form.hidden = true;
    if (authDivider) authDivider.hidden = true;
    if (registerCta) registerCta.hidden = true;
    if (authFoot) authFoot.hidden = true;
    twofaForm.hidden = false;
    twofaCode.focus();
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorBox.hidden = true;

    if (!username.value.trim() || !password.value) {
      showError(window.I18N.t('err.INPUT_MISSING'));
      return;
    }

    submit.disabled = true;
    submit.textContent = window.I18N.t('login.working');

    try {
      var res = await window.API.post('/api/login', {
        username: username.value.trim(),
        password: password.value
      });
      // A 202 requires_2fa is not an HTTP error, so it reaches here rather than
      // the catch block below.
      if (res && res.requires_2fa) {
        submit.disabled = false;
        submit.textContent = window.I18N.t('login.submit');
        enterTwofaStep(res.csrfToken);
        return;
      }
      goToDashboard();
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = window.I18N.t('login.submit');
      password.value = '';
      password.focus();
    }
  });

  if (twofaForm) {
    async function submitTwofa() {
      var code = twofaCode.value.trim();
      if (!code) return;
      twofaError.hidden = true;
      twofaSubmit.disabled = true;
      twofaCode.disabled = true;

      try {
        await window.API.post('/api/2fa/login', { code: code });
        goToDashboard();
      } catch (err) {
        twofaError.textContent = err.message;
        twofaError.hidden = false;
        twofaCode.value = '';
        twofaSubmit.disabled = false;
        twofaCode.disabled = false;
        twofaCode.focus();
      }
    }

    twofaForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitTwofa();
    });

    // Auto-submit once exactly 6 digits are entered — the normal TOTP case.
    // A recovery code (e.g. ABCDE-FGHIJ) is longer and not all-numeric, so it
    // falls through to the manual submit button instead.
    twofaCode.addEventListener('input', function () {
      if (/^\d{6}$/.test(twofaCode.value)) submitTwofa();
    });
  }

  window.addEventListener('languagechange:zs', function () {
    if (!submit.disabled) submit.textContent = window.I18N.t('login.submit');
    if (twofaSubmit && !twofaSubmit.disabled) twofaSubmit.textContent = window.I18N.t('login.twofaSubmit');
  });
})();
