# CLAUDE.md — zer0space Dashboard

Project context for Claude Code. Read this before changing anything in this repo.

## What this is

A self-hosted homelab dashboard for the zer0space Docker Swarm cluster. It provides:

- **Service launcher** — a tiled, categorised list of homelab services (admin-editable).
- **Cluster status** — Swarm node/service/task health, read through a locked-down
  Docker socket proxy.
- **Host metrics** — per-node CPU, RAM, disk and uptime, pulled from a global
  Glances service.
- **Backup status** — reads the per-node JSON files the node backup script drops
  into the shared storage directory.
- **User management** — multiple accounts with `admin` / `user` roles.
- **Password vault** — per-user encrypted credential storage (see the security
  section below; this is the part to be most careful with).

It runs as a single container, one replica, behind a Cloudflare Tunnel.

## Tech stack

| Layer     | Choice |
|-----------|--------|
| Runtime   | Node.js 20 (alpine) |
| HTTP      | Express 4 |
| Sessions  | `express-session` (in-memory store, secret persisted in the DB) |
| Security  | `helmet` (CSP, HSTS), `bcryptjs` (password hashing, cost 12) |
| Uploads   | `multer` (background images only, JPG/PNG/WebP) |
| Database  | PostgreSQL via `pg` — **no ORM**, plain parameterised SQL |
| Frontend  | Vanilla JS, no framework, no build step |

There is **no build step and no bundler**. `src/public/` is served as-is by
`express.static`. Do not introduce a frontend framework or a bundler without
being asked — the no-build property is deliberate.

There is **no test suite** at present. If you add non-trivial logic, say so
rather than silently assuming it is covered.

## Layout

```
src/
├── server.js         Express app: middleware, auth, all routes except the vault
├── db.js             PostgreSQL pool + query helpers, schema bootstrap
├── vault-crypto.js   PBKDF2 key derivation + AES-256-GCM for vault entries
├── routes/
│   └── vault.js      Vault CRUD router (mounted at /api/vault)
└── public/           Static frontend — index.html, login.html, app.js, login.js, style.css
scripts/
└── migrate-sqlite-to-pg.js   One-shot migration from the pre-v3 SQLite file
```

## Database

PostgreSQL runs as a standalone container on **zs-state-01 (192.168.0.16:5432)**,
database `zer0space`, user `dashboard`.

This matters architecturally: since v3 the dashboard holds **no state of its own**.
Users, services, settings and vault entries all live in Postgres, which is why the
service can be scheduled onto any Swarm node instead of being pinned to one host.

- Connection config: `DATABASE_URL` wins if set, otherwise the individual `DB_*`
  variables (see `.env.example`).
- Password resolution order is **Swarm secret file → env var**: `db.js` reads
  `/run/secrets/db_password` first and only falls back to `DB_PASS`.
- Schema is created on first start with `CREATE TABLE IF NOT EXISTS`. There is no
  migration framework — schema changes go into that bootstrap in `db.js` and must
  stay backwards-compatible with existing deployments.
- `db.js` exposes helpers mirroring the old better-sqlite3 shapes:
  `db.query()` (run), `db.one()` (get), `db.all()` (all), `db.tx()` (transaction).
  Everything is async.
- The pool has an `error` listener for idle clients. Do not remove it — without it
  a dropped connection raises an unhandled `error` event and kills the process.

Some data is still on disk rather than in the DB, which is why the `/data` volume
is still mounted: `/data/background/` (uploaded images) and `/data/backup-status/`
(JSON written by the node backup script).

## Security — read before touching auth or the vault

**Vault encryption.** The per-user vault key is derived from the user's *plaintext*
password at login (PBKDF2-HMAC-SHA256, 600k iterations, per-user salt in
`users.vault_salt`) and lives **only in the server-side session** — never in the
database, never sent to the client. A stolen database dump alone therefore cannot
decrypt vault entries. Two consequences that are easy to break by accident:

- A user changing their own password must **re-encrypt** all their vault entries
  with the new key (`reencryptAll` in `routes/vault.js`, called from
  `/api/change-password`).
- An admin-forced password reset **cannot** re-encrypt (the admin never has the old
  plaintext), so it deliberately wipes that user's vault instead of leaving rows
  behind that can never be decrypted. This is intentional, not a bug.

Other invariants:

- Every route after `app.use(requireAuth)` is authenticated; admin-only routes take
  `requireAdmin` explicitly. When adding a route, place it deliberately relative to
  that boundary.
- All SQL is parameterised. Never build SQL by string concatenation.
- CSP `script-src` has **no** `'unsafe-inline'` — inline scripts are blocked on
  purpose. `style-src` does allow inline styles (metric bar widths set via
  `innerHTML`). Do not loosen `script-src` to make something convenient work.
- `FORCE_HTTPS=true` enables HSTS and `upgrade-insecure-requests`; it defaults to
  false so plain HTTP on the LAN keeps working.
- The last admin cannot be deleted or demoted, and users cannot delete their own
  account. Keep those guards.
- **Never commit secrets.** No real passwords, hashes, tokens or connection strings
  in this repo — `.env.example` is a template with placeholders only.

## Docker & deployment

- The image is built by GitHub Actions (`.github/workflows/dashboard.yml`) on every
  push to `main` that touches `src/`, `Dockerfile` or the manifests, and pushed to
  `ghcr.io/zer0space-net/zer0space-dashboard:latest`.
- The Dockerfile is a two-stage build; the runtime image installs production deps
  only (`npm ci --omit=dev`). `better-sqlite3` is a devDependency used solely by the
  migration script, which keeps the runtime image free of a native build toolchain.
  Keep it that way — adding a native runtime dependency reintroduces python3/make/g++.
- `docker-compose.yml` lives in the repo root and is deployed as a Swarm stack via
  Portainer. It defines three services: `dashboard`, `socketproxy`
  (`tecnativa/docker-socket-proxy`, read-only, only SERVICES/NODES/TASKS enabled)
  and `glances` (global mode, host-mode port 61208).
- The compose file references the published image; it does not build locally.
- `socketproxy` stays pinned to a manager node — only managers answer `/nodes`,
  `/services` and `/tasks`.

## Local development

```bash
npm install
cp .env.example .env     # then fill in real values — never commit .env
npm start                # http://localhost:3000
```

You need a reachable PostgreSQL instance. Pointing `DB_HOST` at the real
zs-state-01 database works but writes to production data — prefer a local
throwaway Postgres container for development.

Since the frontend has no build step, editing anything under `src/public/` only
requires a browser reload.

## Conventions

- Everything in this repo — code, comments, docs, commit messages — is in **English**.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- `'use strict';` at the top of every server-side module.
- Match the existing comment style: comments here explain *why* a thing is the way
  it is (especially the non-obvious trade-offs), not what the line does.
