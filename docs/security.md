# Security

How authentication, account creation and the vault work, and which of it you
have to get right when operating the dashboard.

The design target is that the dashboard can be the **only** access layer — that
putting Cloudflare Access in front of it is defence in depth rather than the
thing holding the door shut.

---

## Account lifecycle

There are exactly two ways an account comes into existence, and neither involves
anyone but its owner ever seeing the password.

### 1. The first administrator — setup wizard

While the `users` table is empty, `/setup` serves a wizard and `/login`
redirects to it. The first admin is created there.

Once that account exists, `/setup` redirects to `/login` and `POST /api/setup`
answers `403 SETUP_CLOSED` — permanently. The check runs against the database on
every request rather than being cached at startup, so the wizard seals itself the
instant the account is committed, not at the next restart.

The check and the insert share one transaction with `LOCK TABLE users IN
EXCLUSIVE MODE`. Two people opening `/setup` simultaneously on a fresh install
would otherwise both pass the empty-table test and both become admin.

> There is no `DASHBOARD_USER` / `DASHBOARD_PASS` / `DASHBOARD_HASH` any more.
> Those variables put the initial password into the Portainer database, into
> `docker inspect` output and into shell history. The wizard exists so the
> password's only trip is browser → bcrypt.

### 2. Everyone else — invitation codes

An admin generates a code in **Settings → Invitations**. It is 32 hex characters
from `crypto.randomBytes(16)`, single-use, and expires (default 7 days,
configurable 1–90). The invitee opens `/register?code=…` and picks their own
username and password.

The admin never sets another user's password. That is deliberate and has a
consequence worth understanding: because the vault key is derived from the
plaintext password (below), a password only its owner has ever typed is one
whose vault the admin can never read.

Codes can be revoked while unredeemed. Redeemed ones stay in the table as the
record of how an account came to exist.

**Every failure mode of `POST /api/register` returns one identical response** —
unknown code, expired code, already redeemed, username taken. Distinguishing
them would turn the endpoint into an oracle: "already redeemed" confirms a code
existed, and "username taken" confirms who has an account. The page cannot tell
the user which it was either, because the server does not tell the page.

---

## Passwords

| Property | Value |
|---|---|
| Hash | bcrypt, cost 12 |
| Minimum | 12 characters |
| Maximum | 72 bytes |

The maximum is not arbitrary: **bcrypt hashes only the first 72 bytes** and
silently ignores the rest, so a longer password is not a stronger one. Rejecting
it is better than pretending.

The strength meter on the setup and registration pages scores length and
character diversity. It is a nudge, not a control — it runs on the client, and
it cannot tell that `Passwort123!` is terrible. The 12-character server-side
minimum is the actual floor.

Hashing is always `await bcrypt.hash(...)`, never `hashSync`. A cost-12 round
takes roughly 250 ms, and the synchronous version blocks the event loop for all
of it — on a public login endpoint that is a denial of service anyone can
trigger by holding down the return key.

---

## Login defences

### Rate limiting

Backed by the `login_attempts` table, **not** by an in-memory map. That is the
whole reason the table exists: with process-local counters, restarting the
container reset every lockout, so anyone who could provoke a restart — or who
simply waited for a deploy — got a clean slate.

| Scope | Threshold | Window | Block |
|---|---|---|---|
| Per IP | 10 failed logins | 15 min | 30 min |
| Per username | 5 failed logins | 10 min | 15 min |
| Registration, per IP | 3 attempts | 60 min | 60 min |

The per-username limit is tighter because a distributed guessing attack against
one account is exactly what the per-IP limit cannot see.

Attempts rejected *because of* a block are not written to the table. Otherwise a
blocked client could keep its own block alive forever by continuing to hammer
the endpoint.

Invalid invite codes count against the registration limit, so the code space
cannot be searched.

All values live in `LIMITS` at the top of `src/auth.js`.

### Account lockout

Ten consecutive failed logins lock the account for 30 minutes. The counter is
`users.failed_attempts` and resets on any success. Unlike the sliding windows
above, it survives an attacker pacing their attempts to stay under the rate
limit.

**The lock expires on its own.** A permanent lock releasable only by an admin
sounds stricter, and is worse: the admin username is guessable, so anyone who
can reach `/login` could lock the only admin out for good — and with `/setup`
sealed, there would be no way back in. A brute-force defence that hands an
attacker a permanent denial of service is not a defence.

Three ways out, in order of convenience:

1. Wait 30 minutes.
2. An admin clears it in **Settings → Users → Unlock**.
3. Break-glass, when every admin is locked at once:
   ```bash
   docker exec -it <dashboard-container> npm run unlock-user -- --list
   docker exec -it <dashboard-container> npm run unlock-user -- <username>
   ```
   The script can *only* unlock. It cannot create an account or change a
   password, so having it is not equivalent to having the dashboard.

### Timing equalisation

`/api/login` takes at least 400 ms whatever happens, and runs a bcrypt
comparison against a dummy hash when the username does not exist. Without both,
a missing username returns in about a millisecond while a real one spends a full
bcrypt round — which is a username enumeration oracle measurable over the
network.

The one deliberate exception: a caller who supplies the **correct** password for
a locked account is told the account is locked and when it frees up. They have
already proven they own it, and without that a locked-out user has no way to
understand why a correct password keeps failing.

### Audit trail

Every attempt lands in `login_attempts` (timestamp, IP, username, success,
kind). Admins read it at `GET /api/login-attempts`. Rows older than 30 days are
pruned daily.

**No password, in any form, is ever written there.** The table has no column
that could hold one — keep it that way.

---

## Sessions

- Store: the default **in-memory** store, deliberately. `req.session` holds the
  derived vault key, and a database-backed store would write that key to
  Postgres and break the vault threat model entirely. Consequence: the service
  must stay at `replicas: 1`, and a restart signs everyone out.
- Cookie: `httpOnly`, `sameSite: 'strict'`, `secure` when `FORCE_HTTPS=true`,
  `maxAge` **24 h**.
- The session id is regenerated on login (`req.session.regenerate`). Without it,
  an attacker who can plant a cookie before login still holds a valid session
  after it — session fixation.

`sameSite: 'strict'` is load-bearing here, not cosmetic: it is what covers the
three unauthenticated POST endpoints that cannot carry a CSRF token.

The 24-hour lifetime is a vault decision. The session holds the key, so its
lifetime is how long a stolen session cookie can decrypt vault entries.

---

## CSRF

Double-submit: a token generated per session, stored server-side, echoed by the
client in `X-CSRF-Token`. It is never placed in a cookie, so a cross-site
request cannot read it.

Applied to **every** state-changing request behind `requireAuth` — not just the
vault, which is where it started. `src/public/app.js` wraps `window.fetch` once
to attach the header to every same-origin non-GET request, rather than relying
on twenty call sites and every future one remembering.

Exempt: `/api/login`, `/api/setup`, `/api/register`. There is no session to hold
a token yet, and minting one for every anonymous visitor would let an
unauthenticated client fill the in-memory session store. They are covered by
`sameSite: 'strict'` plus their rate limits.

---

## Secrets

Read from `/run/secrets/<name>` first, environment variable second:

| Secret | Env fallback | Purpose |
|---|---|---|
| `db_password` | `DB_PASS` | PostgreSQL password |
| `session_secret` | `SESSION_SECRET` | Session signing key |

Create them once on a manager node:

```bash
printf '%s' 'YOUR-DB-PASSWORD' | docker secret create db_password -
openssl rand -hex 32 | tr -d '\n' | docker secret create session_secret -
```

Both are `external: true` in `docker-compose.yml` — a secret declared inline
would sit in the repository.

Docker secrets are immutable: rotating one means creating it under a new name
and updating the reference. Rotating `session_secret` invalidates every active
session, so everyone signs in again — and the vault re-locks until they do.

If `session_secret` is absent entirely, the server generates one and stores it in
the `settings` table so it survives restarts. That is the development path;
production should have the secret.

---

## Vault (unchanged)

Not touched by the auth rework, but it constrains everything above.

The per-user vault key is derived at login from the **plaintext** password
(PBKDF2-HMAC-SHA256, 600k iterations, per-user salt in `users.vault_salt`) and
lives only in the server-side session. It is never written to the database and
never sent to the client. A stolen database dump alone cannot decrypt vault
entries. Entries are AES-256-GCM.

Two consequences that are easy to break by accident:

- A user changing their own password must **re-encrypt** their vault entries with
  the new key. That is the one request holding both the old and new plaintext.
- An admin-forced password reset **cannot** re-encrypt — the admin never has the
  old plaintext — so it deliberately wipes that user's vault rather than leaving
  rows that can never be decrypted. Intentional, not a bug.

---

## Headers and transport

`helmet` with a CSP that has **no `'unsafe-inline'` in `script-src`**. Inline
scripts are blocked on purpose; that is why the login starfield lives in
`starfield.js` rather than in a `<script>` block. `style-src` does allow inline
styles, which dynamic metric-bar widths need.

`FORCE_HTTPS=true` enables HSTS and `upgrade-insecure-requests`, and implies
`COOKIE_SECURE`. It defaults to false so plain HTTP on the LAN keeps working;
turn it on when the dashboard is reachable through the tunnel.

`TRUST_PROXY` (default `true`) makes per-IP rate limiting read
`cf-connecting-ip` / `x-forwarded-for`, which is correct behind the Cloudflare
Tunnel where every request otherwise appears to come from the tunnel container.
**Set it to `false` if the dashboard is ever exposed directly** — there the
header is attacker-controlled, and trusting it lets anyone forge a fresh address
per attempt and sidestep the per-IP limits entirely.

---

## Invariants

Things that are load-bearing. Breaking one is a security regression, not a
refactor.

- The last admin cannot be deleted or demoted; users cannot delete themselves.
- All SQL is parameterised. No string concatenation.
- Every route after `app.use(requireAuth)` is authenticated; admin routes take
  `requireAdmin` explicitly.
- `/setup` is reachable only while `users` is empty.
- `/api/register` returns one generic failure for every invite problem.
- No password is ever logged, in any form.
- No password ever travels in an environment variable in production.
- `GATED_PAGES` in `server.js` blocks direct access to `index.html`,
  `setup.html`, `register.html` and `login.html`. Without it `express.static`
  serves those files by name and walks straight around the route guards.
