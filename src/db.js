'use strict';

// PostgreSQL access layer for the dashboard.
//
// Replaces the previous better-sqlite3 (synchronous, local file) setup: the DB now
// lives on zs-state-01 (192.168.0.16), so the dashboard holds no database state of
// its own and can be scheduled on any Swarm node.
//
// Everything here is async. The helpers mirror the three shapes the old code used:
//   db.prepare(...).run(...)  →  await db.query(sql, params)
//   db.prepare(...).get(...)  →  await db.one(sql, params)
//   db.prepare(...).all(...)  →  await db.all(sql, params)
//   db.transaction(fn)        →  await db.tx(async client => { ... })

const { Pool } = require('pg');
const fs = require('fs');

// Secret priority: Docker Swarm secret file → env var → null.
// Same pattern as server.js so the DB password never has to sit in the compose file.
function readSecret(secretName, envName) {
  try {
    return fs.readFileSync(`/run/secrets/${secretName}`, 'utf8').trim();
  } catch {
    return process.env[envName] || null;
  }
}

function buildConfig() {
  // DATABASE_URL wins if set (postgres://user:pass@host:port/db) — otherwise the
  // individual DB_* variables are used.
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host:     process.env.DB_HOST || '192.168.0.16',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'zer0space',
    user:     process.env.DB_USER || 'dashboard',
    password: readSecret('db_password', 'DB_PASS') || undefined,
  };
}

const pool = new Pool({
  ...buildConfig(),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An error on an IDLE client (server restarted, network dropped) is emitted on the
// pool, not on any query. Without this listener Node treats it as an unhandled
// 'error' event and kills the process — exactly the crash we must avoid.
pool.on('error', (err) => {
  ready = false;
  console.error(`[db] idle client error: ${err.message} — pool marked not ready, will reconnect on next query`);
});

let ready = false;
function isReady() { return ready; }

// Connection-level failures we want to report as 503 (DB down / unreachable)
// rather than 500 (bug in our code).
const CONN_ERR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '3D000', // invalid_catalog_name (database does not exist)
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
]);

function isConnectionError(err) {
  return Boolean(err && (CONN_ERR_CODES.has(err.code) || err.message === 'Connection terminated unexpectedly'));
}

async function query(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    ready = true;
    return res;
  } catch (err) {
    if (isConnectionError(err)) ready = false;
    throw err;
  }
}

async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows;
}

// Transaction helper. The callback gets a dedicated client — every statement inside
// MUST use that client, not the pool, or it runs outside the transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    if (isConnectionError(err)) ready = false;
    throw err;
  } finally {
    client.release();
  }
}

// ---- Schema ----
// Idempotent: safe to run on every start. Creates the tables on a fresh DB and
// adds later columns to an existing one.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS services (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL DEFAULT 'layout-dashboard',
    status      TEXT NOT NULL DEFAULT 'unknown'
  );

  CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    hash       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'admin',
    theme      TEXT DEFAULT NULL,
    -- PBKDF2 salt for this user's vault key. NULL until their first login
    -- (generated lazily in /api/login). The KEY itself is never stored.
    vault_salt TEXT DEFAULT NULL,
    -- Consecutive failed logins. Reset to 0 on any success.
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    -- Set when failed_attempts crosses the threshold. The lock EXPIRES on its
    -- own rather than needing an admin: a permanent lock on a guessable admin
    -- username would let anyone who can reach /login disable the dashboard for
    -- good, since /setup is sealed after the first admin exists. An admin can
    -- still clear it early, and scripts/unlock-user.js is the break-glass path.
    locked_until TIMESTAMPTZ DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vault_entries (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id),
    title              TEXT NOT NULL,
    username           TEXT NOT NULL DEFAULT '',
    encrypted_password TEXT NOT NULL DEFAULT '',
    encrypted_notes    TEXT NOT NULL DEFAULT '',
    url                TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id);

  -- Single-use invitations. A code is the ONLY way to create an account after
  -- the first admin exists, so /api/register needs no other gate.
  --
  -- The code is stored in the clear, unlike a password hash. That is deliberate:
  -- the admin UI has to show the code so it can be copied and sent to the
  -- invitee, which a hash would make impossible. The exposure is bounded by the
  -- code being single-use, expiring, and revocable.
  CREATE TABLE IF NOT EXISTS invite_codes (
    id         SERIAL PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_by    INTEGER REFERENCES users(id) DEFAULT NULL,
    used_at    TIMESTAMPTZ DEFAULT NULL,
    -- Highest role this invite may grant. 'viewer' unless an admin says otherwise.
    max_role   TEXT NOT NULL DEFAULT 'viewer'
  );

  CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);

  -- Login audit trail. Also the BACKING STORE for rate limiting: keeping the
  -- counters here rather than in a process-local Map means a container restart
  -- no longer wipes every lockout, which was a trivial way to bypass them.
  -- Passwords are never written here, in any form.
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         SERIAL PRIMARY KEY,
    username   TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    success    BOOLEAN NOT NULL DEFAULT FALSE,
    kind       TEXT NOT NULL DEFAULT 'login',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- The rate-limit queries filter on (ip, created_at) and (username, created_at);
  -- without these they degrade into a full scan as the table grows.
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ip   ON login_attempts(ip, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(created_at DESC);

  -- Columns added after the initial release (no-ops on a fresh DB).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role            TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme           TEXT DEFAULT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_salt      TEXT DEFAULT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ DEFAULT NULL;
`;

// Tables the application cannot work without. Verified after the schema runs so
// a partial bootstrap is reported loudly instead of surfacing later as one
// broken feature.
const REQUIRED_TABLES = ['users', 'settings', 'services', 'vault_entries', 'invite_codes', 'login_attempts'];

// Statements are executed ONE AT A TIME, not as a single multi-statement query.
//
// This matters more than it looks. node-postgres wraps a multi-statement string
// in an implicit transaction, so ONE failing statement rolls back every other
// statement in the batch. On a database that already has the older tables, the
// result is silent and confusing: everything that existed before keeps working,
// while a newly added table is simply missing, and the only symptom is that one
// feature returns a 500. Running them individually means a failure costs you
// that statement and nothing else — and says which one it was.
async function initSchema() {
  // Comments are stripped BEFORE splitting on ';'. A comment containing a
  // semicolon would otherwise cut a statement in half — the schema already has
  // one such comment, and the next one might not land as harmlessly.
  // Safe here because no string literal in this schema contains '--'.
  const statements = SCHEMA
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  const failures = [];
  for (const stmt of statements) {
    try {
      await query(stmt);
    } catch (err) {
      // A connection error means the DB went away — there is no point grinding
      // through the remaining statements, and the caller needs to see it.
      if (isConnectionError(err)) throw err;
      const first = stmt.split('\n')[0].slice(0, 80);
      failures.push({ first, message: err.message });
      console.error(`[db] schema statement failed: ${first} … — ${err.message}`);
    }
  }

  // Default global theme (idempotent).
  await query(
    "INSERT INTO settings (key, value) VALUES ('theme', 'cyan') ON CONFLICT (key) DO NOTHING"
  );

  const { rows } = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [REQUIRED_TABLES]
  );
  const present = new Set(rows.map(r => r.table_name));
  const missing = REQUIRED_TABLES.filter(t => !present.has(t));

  if (missing.length) {
    // Loud and specific: this is the difference between "the invite button is
    // broken" and "the invite_codes table was never created".
    console.error(
      `[db] SCHEMA INCOMPLETE — missing table(s): ${missing.join(', ')}. ` +
      'Features backed by them will fail. Check the statement errors above and ' +
      'that the database user may CREATE TABLE.'
    );
  } else if (failures.length) {
    console.warn(`[db] schema applied with ${failures.length} non-fatal statement error(s) — all required tables present`);
  }

  return { missing, failures };
}

// Try to reach the DB, retrying with a short backoff. Returns true on success.
// Used at startup so a briefly-unavailable Postgres doesn't take the dashboard down.
async function waitForDb({ attempts = 5, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await query('SELECT 1');
      return true;
    } catch (err) {
      const last = i === attempts;
      console.error(
        `[db] connection attempt ${i}/${attempts} failed: ${err.message}` +
        (last ? '' : ` — retrying in ${delayMs}ms`)
      );
      if (!last) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

// Keeps trying in the background after a failed startup, so the dashboard heals
// on its own once Postgres comes back — no container restart needed.
function retryInBackground(intervalMs = 30_000) {
  const timer = setInterval(async () => {
    if (ready) return;
    try {
      await initSchema();
      ready = true;
      console.log('[db] PostgreSQL reachable again — schema verified, DB routes are live');
    } catch (err) {
      console.error(`[db] still unreachable: ${err.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function describeTarget() {
  if (process.env.DATABASE_URL) return 'DATABASE_URL (credentials hidden)';
  const c = buildConfig();
  return `${c.user}@${c.host}:${c.port}/${c.database}`;
}

module.exports = {
  pool, query, one, all, tx,
  initSchema, waitForDb, retryInBackground,
  isReady, isConnectionError, describeTarget,
  readSecret, REQUIRED_TABLES,
};
