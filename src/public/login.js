'use strict';

const form     = document.getElementById('loginForm');
const btn      = document.getElementById('submitBtn');
const errorMsg = document.getElementById('errorMsg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) return;

  btn.disabled = true;
  btn.textContent = '…';
  errorMsg.classList.remove('visible');

  const resetButton = () => {
    btn.disabled = false;
    btn.textContent = t('login.submit');
  };

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      window.location.href = '/';
    } else {
      const data = await res.json().catch(() => ({}));
      // 429 (rate limited) and 423 (account locked) both carry a wait time. Every
      // other failure resolves to the one generic "wrong username or password" —
      // the server does not distinguish them and neither should this.
      if ((res.status === 429 || res.status === 423) && data.retryAfterMinutes) {
        const key = res.status === 423 ? 'err.ACCOUNT_LOCKED_MIN' : 'err.RATE_LIMITED_MIN';
        errorMsg.textContent = t(key, { n: data.retryAfterMinutes });
      } else {
        errorMsg.textContent = I18N.tError(data, 'login.invalid');
      }
      errorMsg.classList.add('visible');
      resetButton();
      document.getElementById('password').value = '';
      document.getElementById('password').focus();
    }
  } catch {
    errorMsg.textContent = t('common.serverUnreachable');
    errorMsg.classList.add('visible');
    resetButton();
  }
});

// The error line carries data-i18n, so a language switch while an error is
// visible would overwrite a specific message ("wrong password") with the
// generic default. Re-hide it instead — the next attempt fills it in again.
window.addEventListener('languagechange:zs', () => {
  errorMsg.classList.remove('visible');
});
