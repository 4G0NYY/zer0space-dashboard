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
      errorMsg.textContent = data.error || 'Ungültige Zugangsdaten';
      errorMsg.classList.add('visible');
      btn.disabled = false;
      btn.textContent = 'Anmelden';
      document.getElementById('password').value = '';
      document.getElementById('password').focus();
    }
  } catch {
    errorMsg.textContent = 'Server nicht erreichbar';
    errorMsg.classList.add('visible');
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});
