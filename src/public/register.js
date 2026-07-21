'use strict';

// Registration by invite.
//
// The server answers every invite failure — unknown code, expired, already
// redeemed, username taken — with one identical response. That is deliberate,
// so this page cannot tell the user which of those it was either. Do not try to
// be more helpful here by guessing: the guess would be the information leak the
// server is avoiding.

const form     = document.getElementById('registerForm');
const btn      = document.getElementById('submitBtn');
const errorMsg = document.getElementById('errorMsg');
const okMsg    = document.getElementById('successMsg');
const codeIn   = document.getElementById('code');
const pw       = document.getElementById('password');
const pw2      = document.getElementById('password2');

// Prefill from /register?code=… and then strip it from the address bar, so the
// code does not sit in browser history or get shoulder-surfed off the URL.
(function prefillCode() {
  const fromUrl = new URLSearchParams(window.location.search).get('code');
  if (!fromUrl) return;
  codeIn.value = fromUrl.trim();
  window.history.replaceState({}, '', '/register');
  document.getElementById('username').focus();
})();

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

  const code     = codeIn.value.trim();
  const username = document.getElementById('username').value.trim();
  const password = pw.value;

  if (!code || !username || !password) return;
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
    btn.textContent = t('register.submit');
  };

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, username, password }),
    });

    if (res.ok) {
      okMsg.classList.add('visible');
      // ?registered=1 rather than a stored flag: the login page is a fresh
      // document, and this survives the navigation without touching storage.
      setTimeout(() => { window.location.href = '/login?registered=1'; }, 1400);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (res.status === 429 && data.retryAfterMinutes) {
      showError(t('err.RATE_LIMITED_MIN', { n: data.retryAfterMinutes }));
    } else {
      showError(I18N.tError(data, 'err.INVITE_INVALID'));
    }
    resetButton();
  } catch {
    showError(t('common.serverUnreachable'));
    resetButton();
  }
});

window.addEventListener('languagechange:zs', () => {
  errorMsg.classList.remove('visible');
  if (!btn.disabled) btn.textContent = t('register.submit');
});
