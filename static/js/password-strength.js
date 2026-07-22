/* Shared password strength meter.

   Deliberately a rough heuristic, not zxcvbn: this is UI feedback, not the
   policy. The policy is enforced on the server (auth.password_problem — minimum
   12 characters, maximum 72 bytes) and a green bar here never overrides it.

   Length is weighted far more heavily than character classes, because it is the
   thing that actually matters against an offline attack on a bcrypt hash, and
   because rewarding "P@ssw0rd!" over "correct horse battery staple" is how
   strength meters teach people the wrong lesson.

   Defines window.PasswordStrength. */
(function () {
  'use strict';

  var COMMON = [
    'password', 'passwort', 'qwerty', 'qwertz', 'admin', 'letmein', 'welcome',
    'monkey', 'dragon', 'iloveyou', '123456', '12345678', 'abc123', 'zer0space',
    'changeme', 'default', 'football', 'baseball', 'starwars', 'trustno1'
  ];

  function score(password) {
    if (!password) return 0;
    var lower = password.toLowerCase();

    for (var i = 0; i < COMMON.length; i++) {
      // A common word plus a couple of digits is still a common word.
      if (lower.indexOf(COMMON[i]) !== -1 && password.length < 20) return 0;
    }

    // Long runs of one character, and straight ascending sequences, add length
    // without adding entropy.
    if (/^(.)\1+$/.test(password)) return 0;
    if (/^(0123456789|abcdefghij|qwertyuiop)/.test(lower)) return 0;

    var points = 0;
    if (password.length >= 12) points += 2;
    if (password.length >= 16) points += 1;
    if (password.length >= 24) points += 1;
    if (password.length < 12) points -= 1;

    var classes = 0;
    if (/[a-z]/.test(password)) classes++;
    if (/[A-Z]/.test(password)) classes++;
    if (/[0-9]/.test(password)) classes++;
    if (/[^A-Za-z0-9]/.test(password)) classes++;
    if (classes >= 3) points += 1;

    // Distinct characters catch "aaaaaaaaaaaaaaaa", which is long and useless.
    var distinct = new Set(password.split('')).size;
    if (distinct >= 10) points += 1;

    return Math.max(0, Math.min(4, points));
  }

  /* Wire an <input> to a .pw-meter element. Returns the current score getter. */
  function attach(input, meter, label) {
    if (!input || !meter) return function () { return 0; };
    var current = 0;

    function update() {
      current = score(input.value);
      meter.setAttribute('data-score', String(current));
      if (label) label.textContent = input.value ? window.I18N.t('pw.' + current) : '';
    }

    input.addEventListener('input', update);
    // Re-label on a language switch — the bars stay, the word changes.
    window.addEventListener('languagechange:zs', update);
    update();
    return function () { return current; };
  }

  /* Random password for the vault's generate button.
     crypto.getRandomValues, and rejection sampling rather than `% alphabet
     .length` — modulo over a 256-value byte biases the first few characters of
     any alphabet whose length does not divide 256. */
  function generate(length) {
    var alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
    var limit = 256 - (256 % alphabet.length);
    var out = '';
    var buffer = new Uint8Array(64);
    while (out.length < (length || 24)) {
      crypto.getRandomValues(buffer);
      for (var i = 0; i < buffer.length && out.length < (length || 24); i++) {
        if (buffer[i] < limit) out += alphabet[buffer[i] % alphabet.length];
      }
    }
    return out;
  }

  window.PasswordStrength = { score: score, attach: attach, generate: generate };
})();
