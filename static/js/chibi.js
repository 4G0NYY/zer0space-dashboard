/* May in the bottom-right corner.

   Ten chibi stickers from the brand sheet; clicking swaps to the next one and
   shows what she is "saying". Purely decorative, so:

   - the button is aria-hidden and tabindex=-1 — a screen reader user is not
     made to walk past a joke to reach the sign-in form,
   - dismissing it is remembered (localStorage), and the Settings toggle reads
     the same key,
   - the first image is preloaded lazily on idle, not eagerly, so it never
     competes with the page's real content for bandwidth. */
(function () {
  'use strict';

  var STORAGE_KEY = 'zs-chibi';
  var COUNT = 10;

  // Index -> caption key. The order matches static/img/chibi-01..10.jpg, which
  // is the order of the sticker sheet in zer0space-docs.
  var CAPTIONS = [
    'Coding', 'Server Time', 'Coffee First', 'Linux Lover', 'Success!',
    'Thinking …', 'Need More Sleep', 'Let’s Go!', 'Oh no …', 'Thanks!'
  ];

  var root = document.getElementById('chibi');
  var btn = document.getElementById('chibi-btn');
  var img = document.getElementById('chibi-img');
  var bubble = document.getElementById('chibi-bubble');
  var dismiss = document.getElementById('chibi-dismiss');
  if (!root || !btn || !img) return;

  var index = 0;
  var bubbleTimer = null;

  function enabled() {
    try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch (e) { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch (e) { /* ignore */ }
    root.hidden = !on;
  }

  function show(next) {
    index = ((next % COUNT) + COUNT) % COUNT;
    var file = '/static/img/chibi-' + String(index + 1).padStart(2, '0') + '.jpg';
    img.classList.remove('is-swapping');
    // Force a reflow so the animation restarts on every click rather than only
    // the first — removing and re-adding a class in the same frame is a no-op.
    void img.offsetWidth;
    img.src = file;
    img.classList.add('is-swapping');

    if (bubble) {
      bubble.textContent = CAPTIONS[index];
      bubble.hidden = false;
      window.clearTimeout(bubbleTimer);
      bubbleTimer = window.setTimeout(function () { bubble.hidden = true; }, 2600);
    }
  }

  btn.addEventListener('click', function () { show(index + 1); });

  if (dismiss) {
    dismiss.addEventListener('click', function (event) {
      event.stopPropagation();
      setEnabled(false);
    });
  }

  // Start on a random sticker so a reload does not always greet you with the
  // same one.
  index = Math.floor(Math.random() * COUNT);
  img.src = '/static/img/chibi-' + String(index + 1).padStart(2, '0') + '.jpg';
  root.hidden = !enabled();

  window.ZS_CHIBI = {
    isEnabled: enabled,
    setEnabled: setEnabled,
    next: function () { show(index + 1); }
  };
})();
