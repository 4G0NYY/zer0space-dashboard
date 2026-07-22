/* Invite redemption. */
(function () {
  'use strict';

  var form = document.getElementById('register-form');
  var errorBox = document.getElementById('register-error');
  var okBox = document.getElementById('register-ok');
  var submit = document.getElementById('register-submit');
  var code = document.getElementById('code');
  var username = document.getElementById('username');
  var password = document.getElementById('password');
  var password2 = document.getElementById('password2');
  if (!form) return;

  window.PasswordStrength.attach(
    password,
    document.getElementById('pw-meter'),
    document.getElementById('pw-label')
  );

  /* Codes arrive as a link (…/register?code=…). Pre-filling is not a nicety:
     retyping 32 hex characters by hand is where people give up. */
  var fromUrl = new URLSearchParams(window.location.search).get('code');
  if (fromUrl && /^[a-f0-9]{32}$/i.test(fromUrl.trim())) {
    code.value = fromUrl.trim().toLowerCase();
    username.focus();
  } else {
    code.focus();
  }

  // Paste tolerance: people copy codes with surrounding whitespace and in the
  // case their terminal happened to print them.
  code.addEventListener('input', function () {
    code.value = code.value.trim().toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 32);
  });

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

    submit.disabled = true;
    submit.textContent = window.I18N.t('register.working');

    try {
      await window.API.post('/api/register', {
        code: code.value.trim(),
        username: username.value.trim(),
        password: password.value
      });
      errorBox.hidden = true;
      okBox.textContent = window.I18N.t('register.success');
      okBox.hidden = false;
      form.querySelectorAll('input').forEach(function (el) { el.disabled = true; });
      window.setTimeout(function () { window.location.href = '/login'; }, 1600);
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = window.I18N.t('register.submit');
    }
  });

  window.addEventListener('languagechange:zs', function () {
    if (!submit.disabled) submit.textContent = window.I18N.t('register.submit');
  });
})();
