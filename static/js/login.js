/* Sign-in form. */
(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var errorBox = document.getElementById('login-error');
  var submit = document.getElementById('login-submit');
  var username = document.getElementById('username');
  var password = document.getElementById('password');
  var remember = document.getElementById('remember');
  if (!form) return;

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
      await window.API.post('/api/login', {
        username: username.value.trim(),
        password: password.value
      });

      try {
        if (remember.checked) localStorage.setItem(REMEMBER_KEY, username.value.trim());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch (e) { /* storage blocked */ }

      window.location.href = '/dashboard';
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = window.I18N.t('login.submit');
      password.value = '';
      password.focus();
    }
  });

  window.addEventListener('languagechange:zs', function () {
    if (!submit.disabled) submit.textContent = window.I18N.t('login.submit');
  });
})();
