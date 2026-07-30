# CLAUDE.md — zer0space Dashboard

Project context for Claude Code. Read this before changing anything in this repo.

## What this is

A self-hosted homelab dashboard for the zer0space Docker Swarm cluster:

- **Landing page** — public, no login. The front door of the project.
- **Service launcher** — a tiled, categorised list of homelab services (admin-editable).
- **Cluster status** — Swarm node/service/task health, read through a locked-down
  Docker socket proxy.
- **Host metrics** — per-node CPU, RAM, disk and network, pulled from Glances
  agents; plus standalone hosts that are deliberately not Swarm members.
- **Backup status** — reads the per-node JSON files the node backup script drops
  into the shared storage directory.
- **User management** — `admin` / `viewer` roles, a first-run setup wizard,
  invitation codes, and optional per-user TOTP two-factor authentication.
- **Password vault** — per-user encrypted credential storage. This is the part to
  be most careful with.
- **AI assistant**: a chat panel that answers questions about the cluster with
  its live state attached. The model call itself lives in a separate service
  (`zer0space-ai`); this repo gates it and proxies it. See `docs/ai.md`.

It runs as a single container, one replica, behind a Cloudflare Tunnel.

## History: this was a Node.js app until v4

v4 is a **complete rewrite in Python**. The Express/`pg`/vanilla-JS stack is gone.
What deliberately did **not** change:

- The **PostgreSQL database**, including live production data. The schema in
  `src/db.py` is a superset of the old one and every added column uses
  `ADD COLUMN IF NOT EXISTS`.
- The **vault wire format**. PBKDF2-HMAC-SHA256 at 600 000 iterations, AES-256-GCM,
  packed as `base64(iv).base64(tag).base64(ciphertext)` — byte-identical to what
  the Node version wrote, so existing vault entries decrypt without a migration.
  If you touch `src/vault.py`, that compatibility is the invariant to preserve.
- **bcrypt cost 12** password hashes, so existing users can still sign in.

## Tech stack

| Layer     | Choice |
|-----------|--------|
| Runtime   | Python 3.12 (alpine) |
| HTTP      | FastAPI on Starlette, served by uvicorn |
| Sessions  | Custom in-memory store + signed sid cookie (`itsdangerous`) |
| Database  | PostgreSQL via `asyncpg` — **no ORM**, plain parameterised SQL |
| Hashing   | `bcrypt` (cost 12), `hashlib.pbkdf2_hmac` for the vault key |
| Crypto    | `cryptography` (AES-256-GCM) |
| HTTP out  | `httpx` (async) for Glances and the Docker socket proxy |
| Templates | Jinja2 |
| Frontend  | Vanilla JS, no framework, no build step |

There is **no build step and no bundler**. `static/` is served as-is. Do not
introduce a frontend framework or a bundler without being asked — the no-build
property is deliberate and is what makes the served files identical to the files
in git.

There is **no test suite** at present. The CI workflow byte-compiles every module,
imports the app and parses every template; that is the whole safety net. If you
add non-trivial logic, say so rather than silently assuming it is covered.

## Layout

```
src/
├── config.py    Environment + Swarm secrets, resolved once at import
├── db.py        asyncpg pool, idempotent schema bootstrap, query helpers
├── auth.py      Sessions, rate limiting, lockout, CSRF, password policy, 2FA policy
├── totp.py      TOTP secret/QR generation and verification (pyotp + qrcode/Pillow)
├── vault.py     PBKDF2 + AES-256-GCM, vault CRUD helpers
├── metrics.py   Docker socket proxy + Glances polling, status tiles
├── ai.py        Gateway to the zer0space-ai service (session gate + proxy)
└── main.py      FastAPI app: middleware, routes, lifespan
static/
├── css/  main.css (design system) + one file per page family
├── js/   boot → i18n → ui → page script  (load order matters)
└── img/  May artwork and the ten chibi stickers
templates/
├── base.html      every page extends this
├── _macros.html   wordmark, brand mark, tagline, chibi, language toggle
└── landing / login / register / setup / dashboard / monitoring / 404 / loading / maintenance
static/vendor/
└── tabler/        Tabler Icons webfont, vendored (CSP forbids a CDN) — service icons
scripts/
└── unlock-user.py  Break-glass account unlock (see docs/security.md)
docs/
├── security.md   Auth system, invite flow, secrets, rate limits, vault
├── ai.md         The AI assistant integration and its boundaries
└── design.md     The visual language and where the artwork comes from
```

## Three things that are easy to break

### 1. Sessions must stay in process memory

`req.session` holds the user's **derived vault key**. That is why:

- Starlette's built-in `SessionMiddleware` is **not** used — it serialises the
  session into the cookie, which would hand the vault key to the browser.
- A database-backed session store is equally disqualified: it would write the key
  to PostgreSQL, which is exactly what the vault design exists to avoid.

The accepted consequence is load-bearing: **`replicas: 1`**, and a restart signs
everyone out. Do not "fix" that by adding replicas or a shared store.

### 2. Middleware order

Added last is outermost. The stack executes:

```
Maintenance → SecurityHeaders → Session → CSRF → routes
```

CSRF must sit *inside* Session (it reads `request.state.session`), and Session
must sit *inside* SecurityHeaders so `Set-Cookie` survives.

The session secret cannot be passed at construction time: the middleware stack is
frozen before the lifespan handler runs, and the secret may have to be read from
PostgreSQL. `auth.SecretHolder` is the late-binding box that solves this.

### 3. Connection errors are converted, not caught broadly

`db.py` turns every connection-level failure into `db.DatabaseUnavailable` before
it leaves the module, and `main.py` has exactly one handler for it. Do **not**
register an exception handler for `OSError` or `ConnectionError` — that would
turn every unrelated socket error in the process into "database unavailable".

## Database

PostgreSQL runs as a standalone container on **zs-state-01 (192.168.0.16:5432)**,
database `zer0space`, user `dashboard`.

The dashboard holds **no state of its own**, which is why it can be scheduled onto
any Swarm node instead of being pinned to one host.

- Connection config: `DATABASE_URL` wins if set, otherwise the individual `DB_*`
  variables (see `.env.example`).
- Password resolution is **Swarm secret file → env var**: `config.read_secret()`
  reads `/run/secrets/db_password` first and only falls back to `DB_PASS`.
- Schema is created on start with `CREATE TABLE IF NOT EXISTS` plus
  `ADD COLUMN IF NOT EXISTS`. There is no migration framework — schema changes go
  into `SCHEMA` in `db.py` and **must stay backwards-compatible** with the live
  database.
- Statements run **one at a time**, not as one multi-statement string. A batch runs
  in an implicit transaction, so one failing statement would silently roll back
  every other statement with it.
- Everything is async and parameterised (`$1`, `$2`). Never build SQL by string
  concatenation.

Two deliberate deviations from a naive reading of the schema spec, both documented
in `docs/security.md`:

- `users.locked_until TIMESTAMPTZ` (automatic, self-expiring) **and**
  `users.locked BOOLEAN` (manual, admin-set, indefinite). A single boolean would
  mean the automatic lockout never expires, and since the admin username is
  guessable, anyone able to reach `/login` could disable the dashboard for good.
- `login_attempts.created_at`, not `attempted_at` — the column already exists in
  production with data in it.

Some data is still on disk, which is why the `/data` volume is still mounted:
`/data/background/` and `/data/backup-status/`.

## Internationalisation (German / English)

The UI ships in both languages, switchable at runtime. `static/js/i18n.js` owns
this and must load **before** any page script — they rely on `window.t` and
`window.I18N`.

**When you add or change any user-facing string, three places move together:**

1. Add the key to **both** the `de` and `en` dictionaries. They are kept at exact
   parity — a key in one but not the other is a bug, and `I18N.checkParity()`
   reports it in the console.
2. In markup, put the key in an attribute rather than hardcoding text: `data-i18n`
   (textContent), `data-i18n-ph` (placeholder), `data-i18n-title`,
   `data-i18n-aria`, `data-i18n-alt`. Leave the German text inside the element as
   the pre-JS default.
3. In JavaScript call `t('key')` — never a literal. `t('key', { name })` fills
   `{placeholder}` style slots.

Server-side messages are **not** translated on the server. Every error response
carries a stable `code` (`fail(400, 'PW_TOO_SHORT', 'Password must be …')`) and
the client resolves it through `I18N.tError(data)` to an `err.<CODE>` key. A new
error response needs a code and a matching `err.*` key in both dictionaries. An
unknown code falls back to the server's English text, so a missed key degrades
gracefully rather than showing a blank.

Two things that are easy to get wrong:

- **Markup built in JavaScript** (host cards, service tiles, vault entries, admin
  tables) carries no `data-i18n` attributes, so `applyI18n()` cannot reach it.
  Those views are re-rendered by the `languagechange:zs` listener at the bottom of
  `app.js` — extend it if you add another JS-rendered view.
- **`#greeting` deliberately has no `data-i18n`.** `app.js` fills it with a
  personalised time-of-day greeting; adding the attribute would let `applyI18n()`
  overwrite it with a generic string.

The chosen language lives in `localStorage` (`zs-lang`) — a per-browser display
preference, deliberately not a DB column, so switching needs no round trip and no
schema change.

## Design

`docs/design.md` is the full account. The short version: near-black navy, one
saturated blue accent, frosted-glass panels over a canvas starfield, and May (the
project mascot) as the only warm colour on the page.

- The artwork comes from **`zer0space-docs/may (mascot)/`**. `static/img/` holds
  web-sized derivatives, not originals — regenerate them from that repo rather
  than editing them in place.
- The accent is a single custom property (`--accent`). Everything tinted is
  derived from it with `color-mix`, so the theme picker recolours the whole UI by
  writing one variable.
- The chibi companion is decorative: `aria-hidden`, `tabindex="-1"`, dismissible,
  and its state is remembered. It must never sit between a user and a form.

## Security — read before touching auth or the vault

**`docs/security.md` is the full account. Read it before changing anything in
`src/auth.py`, the login/setup/register routes, or the session configuration.**
The short version:

**Accounts.** There is no environment-seeded admin. On an empty `users` table the
dashboard serves a setup wizard at `/setup`, which seals itself permanently once
the first account exists. Every account after that is created by redeeming an
invitation code an admin generated. `DASHBOARD_USER`, `DASHBOARD_PASS` and
`DASHBOARD_HASH` do not exist — do not reintroduce them.

**Passwords** are bcrypt cost 12, minimum 12 characters, maximum 72 bytes (bcrypt
ignores anything past 72). Hashing and verification always run in a worker thread
via `anyio.to_thread.run_sync` — a cost-12 round takes ~250 ms and would otherwise
block the event loop, which on a single-worker ASGI server is a denial of service
anyone can trigger by holding the sign-in button down. The same applies to the
600 000-iteration PBKDF2 vault derivation.

**Rate limiting and lockout** are backed by the `login_attempts` table, not by an
in-process dict: process-local counters were wiped by every container restart.
Automatic lockouts **expire on their own** after 30 minutes. Do not "harden" that
into a permanent lock — use the separate manual `users.locked` flag when an
indefinite lock is actually wanted.

**CSRF** applies to every state-changing request that carries a session, not just
the vault. `static/js/api.js` attaches the header once; a new POST anywhere in the
app is automatically covered.

**Vault encryption.** The per-user key is derived from the user's *plaintext*
password at login (PBKDF2-HMAC-SHA256, 600k iterations, per-user salt in
`users.vault_salt`) and lives **only in the server-side session** — never in the
database, never sent to the client. Two consequences that are easy to break by
accident:

- A user changing their own password must **re-encrypt** all their vault entries
  with the new key (`vault.reencrypt_all`, called from `/api/change-password`).
- An admin-forced password reset **cannot** re-encrypt (the admin never has the
  old plaintext), so it deliberately wipes that user's vault instead of leaving
  rows behind that can never be decrypted. This is intentional, not a bug.

**Two-factor authentication (TOTP)** is optional per user. `users.totp_secret` is
AES-256-GCM encrypted with a **separate, server-wide key** (`resolve_totp_key` in
`main.py`, config key `totp_enc_key`) — deliberately not the vault key, since
verifying a code (or an admin resetting a lost device via
`POST /api/users/:id/reset-2fa`) must work without the user's plaintext password.
Login becomes two steps once it is enabled: `POST /api/login` opens a *pending*
session (no `user_id` — that is the entire enforcement boundary, checked by the
same `_require_session` every other route already goes through) and answers
`202 { requires_2fa: true }`; `POST /api/2fa/login` is the only route reachable
with one, and is the one place that promotes a pending session into a full one.
Recovery codes are bcrypt-hashed and single-use, same pattern as everything else
in `auth.py` that must be verified but never reversed. Read the "Two-factor
authentication" section in `docs/security.md` before changing any of this — the
session-boundary trick in particular is easy to weaken by accident.

Other invariants:

- Every route is public unless it calls `_require_session` / `_require_admin`.
  There is no blanket "everything under `/api` is protected" rule, because
  `/api/login`, `/api/setup` and `/api/register` must not be.
- All SQL is parameterised.
- CSP `script-src` has **no** `'unsafe-inline'` — which is why there is not a
  single inline `<script>` in `templates/`. `style-src` does allow inline styles
  (metric bar widths are inline `style` attributes). Do not loosen `script-src`
  to make something convenient work.
- Everything that reaches `innerHTML` goes through `ZS_UI.esc()`, and every `href`
  through `ZS_UI.safeUrl()` — service names, hostnames and vault titles are all
  user-controlled, and the CSP blocks inline `<script>` but not `<img onerror>`.
- `FORCE_HTTPS=true` enables HSTS and `upgrade-insecure-requests`; it defaults to
  false so plain HTTP on the LAN keeps working.
- The last admin cannot be deleted, demoted or locked, and users cannot delete or
  lock their own account. Keep those guards.
- **Never commit secrets.** No real passwords, hashes, tokens or connection
  strings — `.env.example` is a template with placeholders only.

## Docker & deployment

- The image is built by GitHub Actions (`.github/workflows/dashboard.yml`) and
  pushed to `ghcr.io/zer0space-net/zer0space-dashboard:latest`. A `check` job runs
  first: byte-compile, import the app, parse every template.
- The Dockerfile is a single stage on `python:3.12-alpine`, with no compiler.
  That works because every dependency in `requirements.txt` ships a musllinux
  wheel. If a bump ever breaks that, switch the base image to `python:3.12-slim`
  rather than adding gcc/musl-dev to the runtime image.
- The container runs as UID 10001 and never writes to its own filesystem.
- `docker-compose.yml` is deployed as a Swarm stack via Portainer. It defines
  three services: `dashboard`, `socketproxy` (`tecnativa/docker-socket-proxy`,
  read-only, only SERVICES/NODES/TASKS enabled) and `glances` (global mode,
  host-mode port 61208).
- `socketproxy` stays pinned to a manager node — only managers answer `/nodes`,
  `/services` and `/tasks`.
- The dashboard is currently pinned to `zs-node-01` as well. That constraint is
  **temporary**, while the GHCR push is being sorted out; remove it once the image
  is pulled from the registry.

## Local development

```bash
python -m venv .venv && . .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env      # then fill in real values — never commit .env
uvicorn src.main:app --reload --port 3000
```

You need a reachable PostgreSQL instance. Pointing `DB_HOST` at the real
zs-state-01 database works but writes to production data — prefer a local
throwaway Postgres container.

Since the frontend has no build step, editing anything under `static/` only needs
a browser reload. Bump `ASSET_VERSION` in `src/main.py` when you change CSS or JS
that a cached browser must not keep.

## The AI assistant

The assistant is a **separate service**, `zer0space-ai`, and this repo only gates
and proxies it (`src/ai.py`, routes under `/api/ai/*`, UI in `static/js/ai.js`).
`docs/ai.md` is the full account. Four things to know before touching it:

- **`AI_SERVICE_URL` is the only AI setting in the environment.** Provider,
  model, API keys, system prompt and context toggles live in PostgreSQL and are
  edited under Settings → AI. Do not add an `AI_MODEL` or `ANTHROPIC_API_KEY`
  variable; if it is product configuration it belongs in the database.
- **The AI service must stay unreachable from outside.** It does not
  authenticate users: it checks a shared token and trusts the identity headers
  this dashboard forwards, which is sound only while this dashboard is the only
  thing that can reach it. Never give it a published port or a tunnel route.
- **The cluster snapshot is built here, server-side** (`_ai_context_bundle`), not
  taken from the browser. `metrics.py` is the authoritative view of the cluster
  and the assistant must reason over the same numbers the tiles show.
- **Account deletion calls `ai.purge_user`** after the transaction commits. The
  AI service's tables deliberately have no foreign key to `users(id)`, because
  one would make `DELETE FROM users` fail from a table this repo has never heard
  of. The call is best effort; its retention prune is the backstop.

## Conventions

- Everything in this repo — code, comments, docs, commit messages — is in
  **English**.
- The AI integration (`src/ai.py`, `static/js/ai.js`, `docs/ai.md`, the AI parts
  of the template and the stylesheet) is written **without em dashes**, matching
  the `zer0space-ai` repo. The rest of this repo uses them freely. Match
  whichever file you are editing rather than converting either way. The only German lives in the `de` dictionary in `i18n.js`, where it
  is data rather than code.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Python: `from __future__ import annotations` at the top of every module, type
  hints on anything public, `snake_case`.
- JavaScript: one IIFE per file, `'use strict'`, no globals except the documented
  `window.ZS_*` / `window.API` / `window.I18N` surfaces.
- Match the existing comment style: comments here explain *why* a thing is the way
  it is — especially the non-obvious trade-offs — not what the line does.
