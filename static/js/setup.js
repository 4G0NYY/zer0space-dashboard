/* First-run wizard: creates the initial admin.

   Runs exactly once per deployment. After it succeeds, /setup redirects to
   /login forever — the server seals it the moment the users table stops being
   empty, so there is nothing to disable here. */
(function () {
  'use strict';

  var form = document.getElementById('setup-form');
  var errorBox = document.getElementById('setup-error');
  var okBox = document.getElementById('setup-ok');
  var submit = document.getElementById('setup-submit');
  var username = document.getElementById('username');
  var password = document.getElementById('password');
  var password2 = document.getElementById('password2');
  if (!form) return;

  var strength = window.PasswordStrength.attach(
    password,
    document.getElementById('pw-meter'),
    document.getElementById('pw-label')
  );

  function showError(message) {
    okBox.hidden = true;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorBox.hidden = true;

    if (password.value !== password2.value) {
      showError(window.I18N.t('register.mismatch'));
      password2.focus();
      return;
    }

    // A weak first admin password is the one that matters most: this account
    // can mint invites, reset every other password and read the audit log.
    // Warn once, then let it through — the server's 12-character minimum is the
    // actual policy, and blocking here would just be a second, quieter one.
    if (strength() < 2 && !form.dataset.warned) {
      form.dataset.warned = 'yes';
      showError(window.I18N.t('pw.' + strength()) + ' — ' + window.I18N.t('setup.notice'));
      return;
    }

    submit.disabled = true;
    submit.textContent = window.I18N.t('setup.working');

    try {
      await window.API.post('/api/setup', {
        username: username.value.trim(),
        password: password.value
      });
      errorBox.hidden = true;
      okBox.textContent = window.I18N.t('setup.success');
      okBox.hidden = false;
      form.querySelectorAll('input').forEach(function (el) { el.disabled = true; });
      window.setTimeout(function () { window.location.href = '/login'; }, 1500);
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = window.I18N.t('setup.submit');
    }
  });

  window.addEventListener('languagechange:zs', function () {
    if (!submit.disabled) submit.textContent = window.I18N.t('setup.submit');
  });
})();
