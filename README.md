<p align="center">
  <img src="static/img/banner.jpg" alt="Zer0space — Homelab · Cloud · Automation" width="640">
</p>

<h1 align="center">zer0space-dashboard</h1>

<p align="center">
  Self-hosted dashboard for the zer0space homelab — service launcher, Docker Swarm
  cluster status, per-host metrics, backup overview, user management and an
  encrypted password vault, in a single Python container.
</p>

---

## Features

- **Public landing page** — the front door, no login required
- **Service launcher** — categorised, admin-editable tiles for every homelab service
- **Cluster status** — Swarm nodes, services and tasks via a read-only Docker socket proxy
- **Host metrics** — CPU, RAM, disk and network per node, collected from Glances
- **Standalone hosts** — machines that are deliberately *not* Swarm members
  (the database and the storage host) get their own section and their own count
- **Backup status** — per-node backup results read from shared storage
- **Accounts** — first-run setup wizard, `admin` / `viewer` roles, invitation codes,
  optional per-user TOTP two-factor authentication
- **Password vault** — per-user AES-256-GCM credentials, keyed from the user's own
  password; the server cannot decrypt them without an active session
- **German / English** — the whole UI, switchable at any time, on every page
- **Themes** — six accent presets plus a custom colour, stored per account

## Tech stack

Python 3.12 · FastAPI / Starlette · uvicorn · PostgreSQL (`asyncpg`, no ORM) ·
`bcrypt` · `cryptography` · `httpx` · Jinja2 · `pyotp` + `qrcode`/`Pillow` (2FA) ·
vanilla JS frontend with **no build step**.

> **v4 is a complete rewrite.** The dashboard was a Node.js/Express app through
> v3. The database, the bcrypt hashes and the vault's encrypted format were all
> carried over unchanged, so the rewrite needed no data migration.

## Architecture

```
                 Cloudflare Tunnel
                         │
                  ┌──────▼───────┐
                  │  dashboard   │  FastAPI, 1 replica, stateless
                  └──┬────────┬──┘
         socketproxy │        │ PostgreSQL
      (Swarm API, RO)│        │ zs-state-01 · 192.168.0.16:5432
                     │        │
               glances (global mode, host port 61208 on every node)
                     +
        standalone Glances agents on zs-state-01 / zs-store-01
```

The dashboard keeps **no database state of its own** — users, services, settings
and vault entries all live in PostgreSQL on **zs-state-01**. That is what lets the
service be scheduled onto any Swarm node. Backup status files still live on the
shared NFS volume mounted at `/data`.

`replicas: 1` is a correctness requirement, not a resource decision: the session
store is process memory and holds the per-user vault key. See
[`docs/security.md`](docs/security.md).

## Quick start

```bash
git clone https://github.com/zer0space-net/zer0space-dashboard.git
cd zer0space-dashboard

python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # fill in real values — never commit .env
uvicorn src.main:app --reload --port 3000
```

Then open <http://localhost:3000>. On an empty database the setup wizard at
`/setup` opens automatically and creates the first administrator.

You need a reachable PostgreSQL instance. A throwaway container is enough:

```bash
docker run --rm -d --name zs-pg -p 5432:5432 \
  -e POSTGRES_DB=zer0space -e POSTGRES_USER=dashboard -e POSTGRES_PASSWORD=devpass \
  postgres:16-alpine
```

The frontend has no build step, so editing anything under `static/` only needs a
browser reload.

## Deployment

The image is built by GitHub Actions on every push to `main` and published to
`ghcr.io/zer0space-net/zer0space-dashboard:latest`. Deploy `docker-compose.yml`
as a Swarm stack (Portainer or `docker stack deploy`).

Three Swarm secrets are required. Create them once on a manager node:

```bash
printf '%s' 'THE-DB-PASSWORD' | docker secret create db_password -
openssl rand -hex 32 | tr -d '\n'  | docker secret create session_secret -
openssl rand -hex 32 | tr -d '\n'  | docker secret create totp_enc_key -
```

No credential appears in `docker-compose.yml`, in the repository, or in any
environment variable in production.

## Pages

| Route | Auth | What it is |
|---|---|---|
| `/` | public | Landing page |
| `/login` | public | Sign in |
| `/register` | public | Redeem an invitation code |
| `/setup` | public, once | First-run wizard; seals itself permanently |
| `/dashboard` | session | The app |
| `/monitoring` | session | Always-on wall view for a kiosk tablet |
| `/loading` | public | Standalone loading screen |
| `/maintenance` | public | Maintenance notice (`MAINTENANCE_MODE=true`) |
| `/healthz` | public | Liveness; deliberately does not touch the database |

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones you are
most likely to change:

| Variable | Default | Meaning |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | zs-state-01 | PostgreSQL target |
| `EXTRA_HOSTS` | state-01, store-01 | `name:ip[:label]`, comma separated |
| `GLANCES_PORT` | `61208` | Where the Glances agents answer |
| `FORCE_HTTPS` | `false` | HSTS + Secure cookies. Leave off for LAN HTTP |
| `TRUST_PROXY` | `true` | Read `cf-connecting-ip` for rate limiting |
| `MAINTENANCE_MODE` | `false` | Serve the maintenance page instead of the app |

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — project context, invariants, what breaks easily
- [`docs/security.md`](docs/security.md) — auth, invites, 2FA, sessions, vault, secrets
- [`docs/design.md`](docs/design.md) — the visual language and where the art comes from

## Operations

Break-glass account unlock, if every admin is locked out at once:

```bash
docker exec -it <container> python scripts/unlock-user.py --list
docker exec -it <container> python scripts/unlock-user.py --user <name>
```

It deliberately cannot set a password — restoring access to a locked account is a
different operation from taking one over.

## Mascot

May is the zer0space mascot. Her character sheet, story and the full artwork set
live in [zer0space-docs](https://github.com/zer0space-net/zer0space-docs/tree/main/may%20(mascot));
`static/img/` holds web-sized derivatives of it.

> She doesn't run any of the nine machines — she watches all of them, so somebody
> else doesn't have to.
