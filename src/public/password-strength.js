'use strict';

// Password strength meter shared by the setup wizard and the registration page.
//
// This scores DIVERSITY AND LENGTH, not guessability. It cannot tell that
// "Passwort123!" is terrible — a real estimator needs a dictionary, which would
// mean shipping a several-hundred-kilobyte word list to a login page. The meter
// is here to nudge, and the server's 12-character minimum is the actual floor;
// nothing on this page is a security control, since it all runs on the client.

(function (global) {
  const MIN_LENGTH = 12;

  const BANDS = ['weak', 'fair', 'good', 'strong'];

  // Returns { score: 0..4, band: 'weak'|'fair'|'good'|'strong'|null, longEnough }
  function score(password) {
    const pw = String(password || '');
    if (!pw) return { score: 0, band: null, longEnough: false };

    let points = 0;
    if (pw.length >= MIN_LENGTH) points++;
    if (pw.length >= 16) points++;
    if (pw.length >= 20) points++;

    let classes = 0;
    if (/[a-z]/.test(pw)) classes++;
    if (/[A-Z]/.test(pw)) classes++;
    if (/[0-9]/.test(pw)) classes++;
    if (/[^a-zA-Z0-9]/.test(pw)) classes++;
    if (classes >= 3) points++;
    if (classes === 4) points++;

    // A long string of one repeated character scores well on length alone.
    const distinct = new Set(pw).size;
    if (distinct <= 4) points = Math.min(points, 1);

    const capped = Math.max(1, Math.min(4, points));
    // Below the server's minimum nothing can look acceptable, whatever the mix.
    const longEnough = pw.length >= MIN_LENGTH;
    const finalScore = longEnough ? capped : 1;

    return { score: finalScore, band: BANDS[finalScore - 1], longEnough };
  }

  // Wires an <input> to a meter built from .strength-seg elements plus a label.
  // `t` is the i18n lookup, passed in so this file needs no global dependency.
  function attach({ input, segments, label, t }) {
    function update() {
      const { score: s, band, longEnough } = score(input.value);

      segments.forEach((seg, i) => {
        seg.className = 'strength-seg' + (input.value && i < s ? ` on-${band}` : '');
      });

      label.className = 'strength-label' + (input.value ? ` ${band}` : '');
      if (!input.value) {
        label.textContent = '';
      } else if (!longEnough) {
        label.textContent = t('pw.tooShort');
      } else {
        label.textContent = t(`pw.${band}`);
      }
    }

    input.addEventListener('input', update);
    update();
    return update;
  }

  global.PasswordStrength = { score, attach, MIN_LENGTH };
})(window);
