# Design

The visual language of the dashboard, where the artwork comes from, and the rules
that keep it consistent as pages are added.

The reference is the brand sheet in **`zer0space-docs/may (mascot)/`** — in
particular `all2.png` (website collection, chibi collection, wallpapers) and the
two `für-claude*.png` mockups. Those images are the specification; this document
explains how the code implements them.

---

## The idea

> Nine machines, one window.

The dashboard is a station window looking at something dark and enormous, with the
readouts floating in front of it. Everything else follows from that:

- The background is **space**, not a texture — a gradient, a nebula glow, a canvas
  starfield, and artwork behind it.
- The content is **glass** — translucent panels with a blurred backdrop and a
  one-pixel highlight along the top edge, so they read as physical surfaces
  catching the light rather than as flat rectangles.
- **May** is the only warm colour in the frame. Everything else is blue-black.

---

## Colour

| Token | Value | Used for |
|---|---|---|
| `--accent` | `#2f7dfb` | The one saturated colour. Buttons, focus rings, glows, active states. |
| `--bg` / `--bg-2` / `--bg-3` | `#04070e` → `#0b1220` | Page background. Not pure black: the brand art sits in very dark blue and true black next to it reads as a hole. |
| `--glass` / `--glass-2` | `rgba(13,20,36,.62)` | Panel surfaces. Two levels: panels on the first, things inside them on the second. |
| `--border` / `--border-strong` | `rgba(120,160,225,.14/.26)` | Hairlines. Blue-tinted, never grey. |
| `--text` / `--text-dim` / `--text-faint` | `#e9eefa` → `#5d6f8f` | Three levels, no more. |
| `--ok` / `--warn` / `--crit` / `--unknown` | green / amber / red / slate | Status only. Never decoration. |

**Everything tinted is derived from `--accent` with `color-mix`.** That is the
whole theming mechanism: `--accent-soft`, `--accent-line` and `--accent-glow` are
computed from it, so writing one variable recolours buttons, focus rings, tile
rails, bar fills, glows and the brand mark together.

The tone goes deeper than the accents. The base backgrounds (`--bg`, `--bg-2`,
`--bg-3`), the glass fills and the hairline borders each carry a few percent of
`--accent` mixed into their near-black, and the `.sky` glows are `color-mix`-ed
from it outright. So a red theme is not a blue-black page under a red glow — the
whole surface shifts warm, hairlines included. The mix is deliberately small
(5–8% on the base tones): enough to feel, not enough to stop reading as "almost
black".

Six presets ship (`aurora`, `cyan`, `violet`, `ember`, `mint`, `rose`) as
`:root[data-theme="…"]` rules; a custom hex from the picker is written directly
onto `--accent` with `data-theme="custom"`. The choice is stored twice: in
`localStorage` (applied before first paint by `boot.js`, so there is no flash) and
on `users.theme` (so it follows the account to another browser). The server value
wins once `/api/me` answers.

The design is **dark only**. There is no light variant and no
`prefers-color-scheme` branch — `color-scheme: dark` tells the browser so, which
is what keeps form controls and scrollbars from flashing white.

---

## Typography

A system font stack, with `Inter` first if the user happens to have it. **No web
fonts**: the CSP forbids external hosts, and self-hosting a variable font would add
150 KB to every page load for a UI whose type is almost entirely small labels.

The one piece of custom lettering is the **wordmark**, and it is not a font at all.

### The wordmark

`ZER0SPACE`, with the slashed octagonal zero from the logo standing in for the O.
Defined once in `templates/_macros.html` as inline SVG so it inherits
`currentColor` — the theme picker recolours it for free — and stays crisp from the
16 px favicon to the 4 rem hero.

Two sizes with deliberately different tracking:

- **Chrome** (`.wordmark`): `letter-spacing: .22em`. Wide, like a logotype.
- **Hero** (`.wordmark-hero`): `letter-spacing: .05em`. At 4 rem the logo tracking
  reads as a gap between letters rather than as a logotype, so it tightens.

The `HOMELAB · CLOUD · AUTOMATION` tagline is a `.tagline` element with rule
flanks drawn as `::before` / `::after` gradients, matching the logo lockup.

---

## Glass

```css
.glass {
  background: var(--glass);
  border: 1px solid var(--border);
  backdrop-filter: saturate(1.35) blur(22px);
}
.glass::before { /* 1px gradient highlight along the top edge */ }
```

The `::before` highlight is what sells it. Without it the panels are just
translucent rectangles; with it they read as glass catching light from above.

There is a `@supports not (backdrop-filter: …)` fallback that swaps the
translucent background for a nearly opaque one. Without it, a browser with
backdrop-filter disabled shows text sitting directly on the artwork.

---

## Artwork

`static/img/` holds **web-sized derivatives**, not originals. The originals live in
`zer0space-docs/may (mascot)/`; regenerate rather than edit in place.

| File | Source | Used on |
|---|---|---|
| `may-window.jpg` | `zer0space-wallpaper01.png` | Login art panel, 404 backdrop |
| `may-server.jpg` | `zer0space-wallpaper03.png` | Landing backdrop |
| `may-city.jpg` | `zer0space-wallpaper02.png` | Register art panel, loading backdrop |
| `may-terminal.jpg` | `zer0space-terminal.png` | Maintenance backdrop |
| `may-station.jpg` | `zer0space-pb.png` | Landing hero portrait |
| `may-avatar.jpg` | `zer0space-logo-withoutname.png` | Sidebar avatar, About modal |
| `logo-icon.png` | `logo3.png` | Apple touch icon |
| `banner.jpg` | `banner.png` | README, social preview |
| `chibi-01…10.jpg` | `Chibli2.png`, sliced 5×2 | The corner companion, 404, maintenance |
| `favicon.svg` | hand-written | Browser tab |

Backdrops are never shown at full strength. `.sky-photo` masks the illustration
into one edge at 50% opacity so it frames the content instead of competing with
it; `.sky-photo-wide` (the status pages, which have no side panel) uses a radial
mask centred on the viewport instead. On narrow screens the mask is dropped and
the opacity falls to ~0.25 — a full illustration behind a single column of text is
unreadable.

The auth pages put the artwork in a **panel**, not a backdrop: form on the left,
May on the right, one accent-lit edge between them, exactly as in the mockups.
Below 860 px that panel becomes a banner above the form rather than disappearing —
May is the reason this login does not look like every other login.

---

## The chibi companion

May in the bottom-right corner, cycling through the ten stickers on click, with a
speech bubble naming each one.

It exists purely for personality, so it is held to a strict rule: **it must never
sit between a user and what they came for.**

- `aria-hidden="true"` and `tabindex="-1"` — a screen reader user is not made to
  walk past a joke to reach the sign-in form.
- Dismissible, and dismissal is remembered in `localStorage` (`zs-chibi`). The
  Settings toggle reads the same key.
- Absent entirely from `/setup` (seen once, by one person, who is about to set a
  password they cannot recover) and from the status pages, which show a chibi
  inline instead.
- Below modals in the stacking order.

The starting sticker is random, so a reload does not always greet you with the same
one. Captions are the sheet's own names ("Coffee First", "Need More Sleep") and are
deliberately not translated — they are the artwork's labels, not UI copy.

---

## Motion

Restrained and short. Entrances are a 10 px rise plus a fade over ~0.3–0.5 s
(`@keyframes rise`), staggered with `.reveal-1` … `.reveal-4`. Hovers lift 1–4 px.
The hero portrait and the status-page chibi drift 14 px on a 6–7 s alternating
loop, which is slow enough to read as floating rather than as animation.

The starfield is a canvas with parallax by depth: distant stars are smaller,
dimmer and slower. It stops entirely when the tab is hidden and caps the device
pixel ratio at 2 — a 3× retina canvas costs 2.25× the fill rate for no visible gain
on a field of 1 px dots.

`prefers-reduced-motion: reduce` collapses every animation and transition to
0.001 ms and removes the starfield outright. Nothing above carries meaning that is
lost when it stops moving, which is the test for whether it is safe to disable.

---

## Service icons

Service tiles can carry **any icon from [Tabler Icons](https://tabler.io/icons)**
(~5900 of them). The admin editor is a name field with a live preview and a strip
of common quick-picks; the operator types `server`, `brand-docker`, `database`,
and sees it resolve before saving.

The webfont is **vendored locally** at `static/vendor/tabler/` — the CSP forbids a
CDN, and 800 KB of woff2 covers the whole set in one cached file, so it is
self-hosted rather than linked out.

Only the icon **name** is stored in `services.icon`, and it is sanitised to
`[a-z0-9-]` before it ever reaches the DOM (`static/js/icons.js`). That is the
security boundary: the value is admin-controlled and lands in `innerHTML` as a
`ti ti-<name>` class, so it must be a bare slug and nothing else — a free-text SVG
or emoji field would be a stored-XSS hole. An empty or unknown name falls back to
the service's initials rather than rendering an empty square, which is why the
editor shows the preview.

## The monitoring wall

`/monitoring` is a second, stripped-down view of the same data, built for a screen
that is left on — a shelf tablet, a spare monitor, a kiosk iPad. Bigger type, more
air, a one-word verdict pill at the top that turns the whole chip green/amber/red
so it reads across a room, and no sidebar or chibi to touch.

Three things make it wall-appropriate rather than just a second dashboard:

- it polls **unconditionally**, ignoring tab visibility — the dashboard pauses
  when hidden to spare the Glances agents, but a wall display that stopped
  updating when unfocused would defeat its own purpose;
- a failed poll **keeps the last good numbers on screen** under a banner, because
  a monitoring page going blank is indistinguishable from the thing it monitors
  going down;
- it reuses the exact `.tile` / `.host` markup and classes from the dashboard, so
  a card can never look one way here and another way there.

It sits behind the same session gate as everything else (it discloses topology),
reached from a button in the dashboard topbar that opens it in its own tab.

## Status colour

Status is the one place colour carries information, so it is used nowhere else.

Tiles carry a 2 px rail down the left edge in the state colour, with a matching
glow — the fastest thing on the page to scan, and the only place the state colour
appears at full strength. Metric bars go amber at 75% and red at 90%.

`data-state` takes exactly four values: `healthy`, `warning`, `critical`,
`unknown`. `unknown` is a real state, not a fallback — "the Docker proxy is not
answering" is different information from "nothing is wrong", and showing it as
green would be a lie.

---

## Layout

- `--shell: 1200px`, centred, with a 20 px gutter that tightens to 14 px on
  mobile.
- The dashboard is a two-column grid (`258px` sidebar + content) that collapses
  below 1000 px into an off-canvas drawer with a scrim.
- Card grids are `repeat(auto-fill, minmax(…, 1fr))` — no breakpoint maths, and
  they adapt to an ultrawide monitor without a media query for it.
- Wide content (every table) scrolls inside its own `.scroll-x` container. **The
  page body never scrolls horizontally.**

---

## Adding a page

1. Extend `templates/base.html`. Fill `title`, `page_css`, `body`, and `sky` if it
   needs artwork.
2. Import `_macros.html` at the top of the child template and use `ui.wordmark()`
   rather than retyping the logo.
3. Load `main.css` first (base.html does it) and exactly one page stylesheet.
4. Put every user-facing string behind a `data-i18n` attribute and add the key to
   **both** dictionaries in `i18n.js`.
5. No inline `<script>`. The CSP blocks it; that is the point.
6. Bump `ASSET_VERSION` in `src/main.py` if you changed CSS or JS that a cached
   browser must not keep.
