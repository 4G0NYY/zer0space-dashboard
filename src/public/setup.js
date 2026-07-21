'use strict';

// Setup wizard — creates the very first administrator.
//
// The password typed here is sent once over the wire, hashed with bcrypt on the
// server and then discarded. It is never stored in localStorage, never put in a
// URL, and never logged. Do not add a "show password" convenience that writes it
// anywhere but the input element.

const form     = document.getElementById('setupForm');
const btn      = document.getElementById('submitBtn');
const errorMsg = document.getElementById('errorMsg');
const okMsg    = document.getElementById('successMsg');
const pw       = document.getElementById('password');
const pw2      = document.getElementById('password2');

PasswordStrength.attach({
  input: pw,
  segments: Array.from(document.querySelectorAll('.strength-seg')),
  label: document.getElementById('strengthLabel'),
  t,
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('visible');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.classList.remove('visible');

  const username = document.getElementById('username').value.trim();
  const password = pw.value;

  if (!username || !password) return;
  if (password.length < PasswordStrength.MIN_LENGTH) {
    return showError(t('pw.minLength', { n: PasswordStrength.MIN_LENGTH }));
  }
  if (password !== pw2.value) {
    return showError(t('setup.mismatch'));
  }

  btn.disabled = true;
  btn.textContent = '…';

  const resetButton = () => {
    btn.disabled = false;
    btn.textContent = t('setup.submit');
  };

  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      okMsg.classList.add('visible');
      // Straight to the login page rather than signing in automatically: the
      // account is worth proving once before it is the only way in.
      setTimeout(() => { window.location.href = '/login'; }, 1200);
      return;
    }

    const data = await res.json().catch(() => ({}));
    showError(I18N.tError(data, 'setup.failed'));
    resetButton();
  } catch {
    showError(t('common.serverUnreachable'));
    resetButton();
  }
});

// A language switch would otherwise leave a stale message on screen; the next
// attempt renders it again in the new language.
window.addEventListener('languagechange:zs', () => {
  errorMsg.classList.remove('visible');
  if (!btn.disabled) btn.textContent = t('setup.submit');
});
