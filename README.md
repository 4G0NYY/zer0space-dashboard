# zer0space-dashboard

Self-hosted dashboard for the zer0space homelab — a service launcher, Docker Swarm
cluster status view, per-node host metrics, backup overview, user management and an
encrypted password vault, in a single Node.js container.

## Features

- **Service launcher** — categorised, admin-editable tiles for every homelab service
- **Cluster status** — Swarm nodes, services and tasks via a read-only Docker socket proxy
- **Host metrics** — CPU, RAM, disk and uptime per node, collected from Glances
- **Backup status** — per-node backup results read from shared storage
- **Users & roles** — multiple accounts, `admin` / `user` separation
- **Password vault** — per-user AES-256-GCM encrypted credentials, keyed from the
  user's own password (the server cannot decrypt them without an active session)
- **Themes & background** — light/dark per user, admin-uploadable background image
- **German / English** — full UI in both languages, switchable at any time from
  the topbar or Settings (also available on the login page)

## Tech stack

Node.js 20 · Express 4 · PostgreSQL (`pg`, no ORM) · `express-session` · `helmet` ·
`bcryptjs` · `multer` · vanilla JS frontend with **no build step**.

## Architecture

```
                Cloudflare Tunnel
                        │
                 ┌──────▼───────┐
                 │  dashboard   │  Node.js / Express, 1 replica, stateless
                 └──┬────────┬──┘
        socketproxy │        │ PostgreSQL
     (Swarm API, RO)│        │ zs-state-01 · 192.168.0.16:5432
                    │        │
              glances (global mode, port 61208 per node)
```

Since v3 the dashboard keeps no database state of its own — users, services,
settings and vault entries all live in PostgreSQL on **zs-state-01
(192.168.0.16:5432)**. That is what lets the service be scheduled onto any Swarm
node. Uploaded background images and backup status files still live on the shared
NFS volume mounted at `/data`.

## Local development

```bash
git clone https://github.com/zer0space-net/zer0space-dashboard.git
cd zer0space-dashboard
npm install

cp .env.example .env    # fill in real values — .env is gitignored, never commit it
npm start               # http://localhost:3000
```

A reachable PostgreSQL instance is required. Use a local throwaway container for
development rather than pointing at the production database:

```bash
docker run --rm -d --name zs-pg-dev \
  -e POSTGRES_DB=zer0space -e POSTGRES_USER=dashboard -e POSTGRES_PASSWORD=devpass \
  -p 5432:5432 postgres:16-alpine
```

Then set `DB_HOST=localhost` and `DB_PASS=devpass` in `.env`. Tables are created
automatically on first start.

The frontend has no build step — editing anything in `src/public/` just needs a
browser reload.

### Adding or changing UI text

The UI is bilingual. Every user-facing string lives in `src/public/i18n.js`, in
both a `de` and an `en` dictionary. Markup references keys via `data-i18n`
(and `data-i18n-ph` / `-title` / `-aria` / `-alt`); JavaScript calls `t('key')`.
Server error responses carry a stable `code` that the client maps to an `err.*`
key, so messages translate without the server knowing the user's language.

Never hardcode a user-facing string — add it to both dictionaries instead.
See [`CLAUDE.md`](CLAUDE.md) for the full contract.

## Configuration

All configuration is via environment variables; see [`.env.example`](.env.example)
for the full list with comments. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` *or* `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | PostgreSQL connection (`DATABASE_URL` wins if set) |
| `COOKIE_SECURE` / `FORCE_HTTPS` | Enable when running behind HTTPS (Cloudflare Tunnel) |
| `TRUST_PROXY` | Read the client IP from `cf-connecting-ip`; `true` behind the tunnel, `false` if exposed directly |
| `GLANCES_SERVICE` / `GLANCES_PORT` | Where to collect host metrics from |
| `DOCKER_PROXY_URL` | Read-only Docker socket proxy endpoint |
| `TZ` | Container timezone |

**There is no admin account in the configuration.** On a fresh database the
dashboard serves a setup wizard at `/setup` where the first administrator is
created in the browser; every account after that is created by redeeming an
invitation code. See [`docs/security.md`](docs/security.md).

Passwords are **Docker Swarm secrets**, not environment variables: the server
reads `/run/secrets/db_password` and `/run/secrets/session_secret` first and
falls back to `DB_PASS` / `SESSION_SECRET` only for local development.

### First start

1. Deploy the stack.
2. Open the dashboard — it redirects to `/setup`.
3. Create the administrator account (minimum 12 characters).
4. `/setup` is now closed permanently. Invite further users from
   **Settings → Invitations**.

## Deployment

Pushes to `main` that touch `src/`, the `Dockerfile` or the package manifests
trigger [`.github/workflows/dashboard.yml`](.github/workflows/dashboard.yml), which
builds the image and pushes it to:

```
ghcr.io/zer0space-net/zer0space-dashboard:latest
```

The stack is deployed to Docker Swarm from [`docker-compose.yml`](docker-compose.yml)
via Portainer. It defines three services:

| Service | Role |
|---|---|
| `dashboard` | The application, 1 replica, on `dashboard_net` + `cloudflared_proxy` |
| `socketproxy` | Read-only Docker API (`SERVICES`/`NODES`/`TASKS` only), pinned to a manager node |
| `glances` | Host metrics, global mode, host-mode port 61208 |

Before deploying, verify the NFS mount on every node — Docker silently creates the
directory empty if it is missing, which makes the background image and backup card
disappear:

```bash
mountpoint -q /mnt/storage && echo OK
```

## Migrating from SQLite (pre-v3)

Older versions stored everything in a local `services.db`. To move an existing
install to PostgreSQL:

```bash
npm install                          # better-sqlite3 is a devDependency
node scripts/migrate-sqlite-to-pg.js --sqlite /mnt/storage/dashboard/services.db
```

Add `--dry-run` first to see what would be transferred without writing anything.

## Security notes

- Vault entries are encrypted with a key derived from the user's plaintext password
  at login (PBKDF2-HMAC-SHA256, 600k iterations) that lives only in the server-side
  session. A database dump alone cannot decrypt them.
- An **admin-forced password reset wipes that user's vault** — the admin has no
  access to the old plaintext and therefore cannot re-encrypt the entries. Users
  changing their own password keep their vault (entries are re-encrypted in place).
- Passwords are hashed with bcrypt (cost 12). The last admin cannot be deleted or
  demoted.
- The Content-Security-Policy blocks inline scripts.
- No secrets belong in this repository. `.env` is gitignored; `.env.example`
  contains placeholders only.

## License

Private project — all rights reserved.
