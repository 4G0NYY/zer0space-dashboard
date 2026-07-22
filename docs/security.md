# Security

How authentication, account creation and the vault work, and which of it you have
to get right when operating the dashboard.

The design target is that the dashboard can be the **only** access layer — that
putting Cloudflare Access in front of it is defence in depth rather than the thing
holding the door shut.

> **v4 note.** The backend was rewritten from Node.js/Express to Python/FastAPI.
> Every property described here survived the rewrite unchanged, including the
> vault's on-disk format and the bcrypt cost. What changed is stated inline.

---

## Account lifecycle

There are exactly two ways an account comes into existence, and neither involves
anyone but its owner ever seeing the password.

### 1. The first administrator — setup wizard

While the `users` table is empty, `/setup` serves a wizard and `/login` redirects
to it. The first admin is created there.

Once that account exists, `/setup` redirects to `/login` and `POST /api/setup`
answers `403 SETUP_CLOSED` — permanently. The check runs against the database on
every request rather than being cached at startup, so the wizard seals itself the
instant the account is committed, not at the next restart.

The check and the insert share one transaction with `LOCK TABLE users IN
EXCLUSIVE MODE`. Two people opening `/setup` simultaneously on a fresh install
would otherwise both pass the empty-table test and both become admin.

> There is no `DASHBOARD_USER` / `DASHBOARD_PASS` / `DASHBOARD_HASH`. Those
> variables put the initial password into the Portainer database, into
> `docker inspect` output and into shell history. The wizard exists so the
> password's only trip is browser → bcrypt.

### 2. Everyone else — invitation codes

An admin mints a code; the invitee redeems it at `/register` and chooses their own
password. No admin ever sets, sees or resets another user's password into a known
value.

| Property | Value |
|---|---|
| Entropy | 128 bits (`secrets.token_hex(16)`, 32 hex characters) |
| Expiry | 1–90 days, admin's choice, default 7 |
| Uses | Exactly one — enforced with `SELECT … FOR UPDATE` |
| Max role | `viewer` unless the admin explicitly grants `admin` |
| Revocable | Yes, while unredeemed |
| Quota | 20 per admin per hour |

**Codes are stored in the clear**, unlike a password hash. That is deliberate: the
admin UI has to display the code so it can be copied and sent, which a hash makes
impossible. The exposure is bounded by the code being single-use, expiring, and
revocable — and by an unredeemed code granting nothing on its own.

**A redeemed code is never deleted.** It is the audit record of how an account came
to exist. `DELETE /api/invite/:id` only removes unredeemed codes, and deleting a
user detaches the invite rows rather than removing them.

The redemption endpoint answers **one generic error** for every failure —
non-existent code, expired code, already-redeemed code, and taken username all
return `400 INVITE_INVALID` after the same padded delay. Each distinction would
otherwise leak something: whether a code exists, whether it has been used, or
whether a username is taken.

The quota is not a brute-force defence — an admin is already trusted. It is a
blast-radius limit: a hijacked admin session should not be able to produce an
unbounded supply of working registration codes faster than anyone would notice.

---

## Passwords

| Property | Value |
|---|---|
| Algorithm | bcrypt, cost 12 |
| Minimum | 12 characters |
| Maximum | 72 bytes (bcrypt ignores anything past 72) |
| Where hashed | Server side, immediately on arrival |
| Plaintext lifetime | One request. Never logged, never stored, never in an env var |

The maximum is enforced rather than left implicit: without it, a user could set a
100-character password and believe the last 28 characters were doing something.

**Hashing always runs off the event loop.** `auth.hash_password` and
`auth.verify_password` dispatch to a worker thread via `anyio.to_thread.run_sync`.
A cost-12 round costs about 250 ms of pure CPU; running it inline on a
single-worker ASGI server means every other in-flight request stalls for that long,
which is a denial of service anyone can trigger by holding the sign-in button down.
The same applies to the 600 000-iteration PBKDF2 vault derivation.

---

## Login

### Uniform failure

Every rejected sign-in returns the same body — `401 BAD_CREDENTIALS`, "Invalid
credentials" — after at least 400 ms, whether the username exists or not.

Two mechanisms make that true rather than aspirational:

- **A dummy hash.** When the username does not exist, the password is verified
  against a bcrypt hash generated at import from random bytes. The no-such-user
  path therefore costs exactly one bcrypt round, like every other path.
- **A timing floor.** `auth.pad_timing` holds the response until 400 ms have
  elapsed, so a fast rejection (rate limited, missing input) cannot be told apart
  from a slow one.

### The single exception

A locked account tells the truth — `423 ACCOUNT_LOCKED` — but **only to a caller
who already supplied the correct password**. Without that, a user whose account is
locked has no way to understand why a password they know is correct keeps failing.
Someone who does not know the password learns nothing: they get the generic answer.

### Rate limiting

Backed by the `login_attempts` table, **not** by an in-process dictionary. Process-
local counters were reset by every container restart, so an attacker who could
provoke a restart — or who simply waited for a deploy — got a clean slate.

| Scope | Threshold | Window | Block |
|---|---|---|---|
| Per IP (login) | 10 failures | 15 min | 30 min |
| Per username (login) | 5 failures | 10 min | 15 min |
| Per IP (register) | 3 attempts | 60 min | 60 min |

The per-username limit is tighter than the per-IP limit on purpose: a distributed
guess against one account is exactly the attack the per-IP limit cannot see.

Attempts rejected *because of* a block are deliberately not logged, so a blocked
client cannot extend its own block indefinitely by continuing to hammer the
endpoint.

The client IP comes from `cf-connecting-ip` (then `x-forwarded-for`) when
`TRUST_PROXY` is on, which is correct behind the Cloudflare Tunnel — every request
arrives from the tunnel container otherwise. **Set `TRUST_PROXY=false` if the
dashboard is ever exposed directly**, where that header is attacker-controlled and
trusting it would let anyone forge a fresh address per attempt.

### Account lockout

Ten consecutive failures lock the account for 30 minutes. This is a per-account
counter (`users.failed_attempts`), independent of the sliding windows above, so it
survives an attacker pacing their attempts to stay under the rate limit.

**The automatic lock expires on its own.** A permanent lock releasable only by an
admin reads as the safer option, but it is not: the admin username is guessable, so
anyone able to reach `/login` could lock the only admin out for good — and with
`/setup` sealed, there would be no way back in.

When an indefinite lock *is* what you want, that is a separate, explicit mechanism:
`users.locked`, a boolean an admin sets via `POST /api/users/:id/lock`. It never
expires, and it cannot be applied to the last admin or to your own account.

Break-glass, if every admin is locked at once:

```bash
docker exec -it <dashboard-container> python scripts/unlock-user.py --list
docker exec -it <dashboard-container> python scripts/unlock-user.py --user siro
```

That script deliberately **cannot set a password**. Restoring access to a locked
account is a different operation from taking one over, and a tool that could do
both would be the most dangerous file in the repository.

---

## Sessions

| Property | Value |
|---|---|
| Storage | Server-side, in process memory |
| Cookie | `zs.sid`, carries only a signed session id |
| Flags | `httpOnly`, `sameSite=strict`, `secure` when `FORCE_HTTPS=true` |
| Lifetime | 24 hours |
| On login | Session id regenerated (fixation defence) |

**The session holds the derived vault key.** Everything above follows from that:

- Starlette's built-in `SessionMiddleware` serialises the session *into the
  cookie*. Using it would hand the vault key to the browser. It is not used.
- A PostgreSQL-backed session store would write the key to the database, which is
  precisely what the vault design exists to prevent.
- 24 hours, not a week: the session lifetime is the window in which a stolen
  session cookie can decrypt the vault.

The accepted consequence is that sessions are per-process. **`replicas: 1`** is a
correctness requirement, not a resource decision, and a restart signs everyone out.

The session secret resolves as: Swarm secret file → `SESSION_SECRET` env var →
a value stored in the `settings` table → freshly generated and stored there. The
last step means sessions survive a restart even on a deployment that never
configured a secret. If PostgreSQL is unreachable at boot, an ephemeral secret is
used and that fact is logged loudly.

---

## CSRF

Double-submit. The token lives in the server-side session and must be echoed in the
`X-CSRF-Token` header. It is never placed in a cookie, so a cross-site request
cannot read it.

`CsrfMiddleware` covers **every** state-changing request that carries a session —
not just the vault. `static/js/api.js` attaches the header once, so a new POST
anywhere in the app is automatically covered.

Three endpoints are exempt: `/api/login`, `/api/setup`, `/api/register`. They run
before a session exists, and minting one for every anonymous visitor would let an
unauthenticated client fill the in-memory session store. They are covered instead
by `sameSite=strict` on the session cookie plus their own rate limits.

---

## The vault

Per-user encrypted credential storage. **The threat model is a stolen database
dump**, and the design answers it directly: a dump alone is not enough.

| Property | Value |
|---|---|
| Cipher | AES-256-GCM |
| Key derivation | PBKDF2-HMAC-SHA256, 600 000 iterations |
| Salt | Per user, random 16 bytes, `users.vault_salt` |
| Key location | Server-side session only |
| Stored format | `base64(iv).base64(tag).base64(ciphertext)` |

The key is derived from the user's **plaintext password at login** — the one moment
the server holds it — and lives only in the session. It is never written to the
database and never sent to the client. An attacker with a full dump of
`vault_entries` and `users` has ciphertext, salts and bcrypt hashes, and no key.

> The wire format is byte-identical to the Node.js implementation's, which is why
> the v4 rewrite needed no data migration. If you change `src/vault.py`, that
> compatibility is the invariant to preserve.

Two consequences follow, both of which look like bugs until you know why:

**Changing your own password re-encrypts the vault.** It is the one request that
holds both the old and the new plaintext, so `vault.reencrypt_all` can decrypt with
the old key and re-encrypt with the new one. The salt is rotated too — a fresh key,
not a re-derivation. The re-encryption and the password update commit in **one
transaction**: a crash between them would leave entries encrypted with the old key
while the salt already pointed at the new one, which is permanently undecryptable.

**An admin-forced password reset wipes that user's vault.** The admin never has the
old plaintext, so the old key cannot be re-derived and the entries could never be
decrypted again. Deleting them is more honest than leaving dead ciphertext behind
that the UI would have to keep apologising for. `PUT /api/users/:id/password`
returns `vaultWiped: true` so the UI can say so.

If a session predates the vault feature or survives a reset, the API answers
`409 VAULT_LOCKED` — "sign out and back in" — rather than crashing or silently
showing nothing.

---

## HTTP hardening

Set by `SecurityHeadersMiddleware` on every response:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `same-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | geolocation, microphone, camera all denied |
| `Strict-Transport-Security` | only when `FORCE_HTTPS=true` |

**`script-src` has no `'unsafe-inline'`.** That is why there is not a single inline
`<script>` in `templates/` — the theme bootstrap lives in `static/js/boot.js`
specifically so the policy can stay strict. Injected inline scripts are blocked.

`style-src` does allow `'unsafe-inline'`, because metric bar widths are set as
inline `style` attributes on generated markup. That is a knowing trade: an
attacker who can inject markup can restyle the page, but cannot execute script.

The CSP does not stop `<img onerror=…>`, so **everything that reaches `innerHTML`
goes through `ZS_UI.esc()`** and every `href` through `ZS_UI.safeUrl()`, which
accepts only `http:`, `https:` and site-relative paths. Service names, hostnames
and vault titles are all user-controlled.

**HSTS is conditional on purpose.** Once a browser stores an HSTS entry it upgrades
every later request to `https://`. Sending it while the dashboard is also reachable
at `http://node:8080` on the LAN breaks that access until the entry expires.

---

## Secrets

Nothing in this repository contains a credential, and nothing should.

| Secret | Where it lives | Fallback |
|---|---|---|
| Database password | `db_password` Swarm secret → `/run/secrets/db_password` | `DB_PASS` env var (development only) |
| Session signing key | `session_secret` Swarm secret | `SESSION_SECRET` env var, then the `settings` table |

Created once on a manager node:

```bash
printf '%s' 'THE-DB-PASSWORD' | docker secret create db_password -
openssl rand -hex 32 | tr -d '\n'  | docker secret create session_secret -
```

Docker secrets are immutable, so rotating one means creating a new secret under a
new name and updating the reference. Rotating `session_secret` invalidates every
active session — and since the vault key lives in the session, every vault
re-locks until its owner signs in again.

The resolution order is **file first, environment second**, never the reverse.
That is what keeps the compose file free of credentials.

---

## The Docker socket

The dashboard never holds a Docker socket. It reads the Swarm through
`tecnativa/docker-socket-proxy` with only three endpoint groups enabled — `NODES`,
`SERVICES`, `TASKS` — and `POST=0`. Containers, images, volumes, networks, `exec`
and every write path are off.

The proxy is pinned to a manager node, because only managers answer those
endpoints.

---

## Repository audit

`zer0space-net/zer0space-dashboard` is public, so the whole history is re-scanned
whenever something substantial changes. Last run: **at the v4 rewrite**, across all
commits, for bcrypt hashes, GitHub/AWS/Slack/Discord tokens, JWTs, private keys,
Cloudflare tunnel tokens and connection strings carrying a password.

**No secrets found.** No `.env`, `.key`, `.pem` or `.secret` file has ever been
committed. The only password-shaped strings in the tree are `devpass` (a README
example for a throwaway local Postgres container) and `CHANGE-ME` in
`.env.example`. Everything else the scan flags is an i18n dictionary key called
`login.password`.

**Private IPs are present** and remain the one thing worth a decision:
`192.168.0.15`, `192.168.0.16`, `192.168.0.17`, in both the current files and the
history. These are RFC1918 addresses — not routable from the internet, so they
cannot be connected to — but they do disclose internal topology, and they pair with
this repository's documentation of what runs on each host.

No action taken, same as last time: removing them means rewriting history on a
public repository, which is the repository owner's call rather than an automated
cleanup. If that call is ever made, note that `docker-compose.yml` already reads
every one of them from an environment variable with the address only as a
`${VAR:-default}`, so the current files could be scrubbed without changing any
behaviour.

## What this does not defend against

Stated plainly, because a security document that only lists wins is not useful:

- **A compromised host.** Root on the node running the dashboard reads the session
  store out of process memory, vault keys included.
- **A malicious admin.** An admin can mint invite codes, reset passwords and read
  the audit log. That is the role, not a flaw.
- **Offline brute force of a weak password.** A stolen `users` dump plus a
  12-character password that appears in a wordlist is recoverable given enough
  GPU-hours; bcrypt cost 12 buys time, not immunity.
- **Session theft by XSS.** The CSP and the escaping make this hard, not
  impossible. `httpOnly` stops the cookie being read, but a script running on the
  page can still act as the user.
- **Traffic analysis.** Nothing here hides *that* you use the dashboard, only what
  you do in it.
