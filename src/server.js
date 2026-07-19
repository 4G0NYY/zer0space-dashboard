'use strict';

const express = require('express');
const helmet  = require('helmet');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const vaultCrypto = require('./vault-crypto');
const createVaultRouter = require('./routes/vault');

const app = express();
const PORT = 3000;
// DATA_DIR is no longer the database location — the DB lives in PostgreSQL on
// zs-state-01. It still holds FILES that are not DB rows:
//   /data/background/    uploaded background images
//   /data/backup-status/ JSON written by backup.sh
// So the volume stays mounted; only services.db is gone.
const DATA_DIR = process.env.DATA_DIR || '/data';
const BG_DIR = path.join(DATA_DIR, 'background');
const PROXY_URL       = process.env.DOCKER_PROXY_URL || 'http://socketproxy:2375';
const GLANCES_SERVICE = process.env.GLANCES_SERVICE  || 'dashboard_glances';
const GLANCES_PORT    = process.env.GLANCES_PORT     || '61208';
const METRICS_TIMEOUT = 4000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BG_DIR))   fs.mkdirSync(BG_DIR,   { recursive: true });

const readSecret = db.readSecret;

// ---- Async route helper ----
// Express 4 does not catch rejected promises from async handlers — without this
// wrapper a failed query becomes an unhandled rejection instead of a response.
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- First-run: seed admin ----
// Runs ONLY when the users table is completely empty (fresh DB).
// After that, DASHBOARD_USER / DASHBOARD_HASH / DASHBOARD_PASS are NEVER read again.
// All password changes via the UI are written to the DB and are permanent.
async function seedAdmin() {
  // COUNT(*) comes back as a bigint, which node-postgres returns as a STRING.
  // The ::int cast keeps this an actual number (a plain === 0 would never match).
  const { c: userCount } = await db.one('SELECT COUNT(*)::int AS c FROM users');
  if (userCount !== 0) return;

  const adminUser = process.env.DASHBOARD_USER;
  // Priority: Docker Secret / DASHBOARD_HASH (pre-computed bcrypt, preferred for production)
  //        → DASHBOARD_PASS (plaintext, hashed here at runtime, simpler for first-run setup)
  let adminHash = readSecret('dashboard_hash', 'DASHBOARD_HASH');
  if (!adminHash && process.env.DASHBOARD_PASS) {
    adminHash = bcrypt.hashSync(process.env.DASHBOARD_PASS, 12);
    console.log('[dashboard] DASHBOARD_PASS used — hashed at runtime. Use DASHBOARD_HASH for production.');
  }
  if (adminUser && adminHash) {
    if (!adminHash.startsWith('$2')) {
      console.error('[dashboard] DASHBOARD_HASH does not look like a bcrypt hash ($2...). Admin NOT created.');
    } else {
      await db.query('INSERT INTO users (username, hash, role) VALUES ($1, $2, $3)', [adminUser, adminHash, 'admin']);
      console.log(`[dashboard] Initial admin created: ${adminUser}`);
    }
  } else {
    console.error('[dashboard] WARNING: Set DASHBOARD_USER + DASHBOARD_PASS (or DASHBOARD_HASH) to create the initial admin.');
  }
}

// ---- Session secret ----
// Priority: Docker Secret → SESSION_SECRET env var → value stored in the DB →
// freshly generated and stored in the DB (so it survives restarts).
//
// If Postgres is unreachable at startup we fall back to an ephemeral secret so the
// server can still boot (see startup() below) — sessions then do not survive a
// restart until the DB is back. That is logged loudly rather than crashing.
async function getSessionSecret() {
  const fromSecret = readSecret('session_secret', 'SESSION_SECRET');
  if (fromSecret) return fromSecret;

  const row = await db.one("SELECT value FROM settings WHERE key = 'session_secret'");
  if (row) return row.value;

  const generated = crypto.randomBytes(32).toString('hex');
  // ON CONFLICT guards the race where two instances start at the same time:
  // the loser keeps the winner's value instead of overwriting it.
  const { rows } = await db.query(
    `INSERT INTO settings (key, value) VALUES ('session_secret', $1)
     ON CONFLICT (key) DO UPDATE SET value = settings.value
     RETURNING value`,
    [generated]
  );
  console.log('[dashboard] Auto-generated SESSION_SECRET stored in DB (persistent across restarts).');
  return rows[0].value;
}

// ---- Brute-force rate limiting (in-memory) ----

const loginAttempts = new Map(); // key: `ip:username` → { count, windowStart, lockedUntil }
const RATE_MAX    = 5;
const RATE_WINDOW = 10 * 60_000; // 10 min window
const RATE_LOCK   = 15 * 60_000; // 15 min lockout

function getRateKey(req, username) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${username.toLowerCase()}`;
}

function checkRateLimit(key) {
  const now = Date.now();
  const e = loginAttempts.get(key);
  if (!e) return null;
  if (now < e.lockedUntil) return { locked: true, remaining: e.lockedUntil - now };
  if (now - e.windowStart > RATE_WINDOW) { loginAttempts.delete(key); return null; }
  return null;
}

function recordFailure(key) {
  const now = Date.now();
  const e = loginAttempts.get(key) || { count: 0, windowStart: now, lockedUntil: 0 };
  if (now - e.windowStart > RATE_WINDOW) { e.count = 0; e.windowStart = now; e.lockedUntil = 0; }
  e.count++;
  if (e.count >= RATE_MAX) e.lockedUntil = now + RATE_LOCK;
  loginAttempts.set(key, e);
}

function clearFailures(key) { loginAttempts.delete(key); }

// Periodic cleanup so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    if (now > Math.max(v.lockedUntil, v.windowStart + RATE_WINDOW)) loginAttempts.delete(k);
  }
}, 30 * 60_000);

// ---- Multer for background upload ----

const bgUpload = multer({
  dest: BG_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

// ---- Middleware ----

// FORCE_HTTPS=true → HSTS + upgrade-insecure-requests active (use behind Cloudflare/TLS).
// FORCE_HTTPS=false (default) → neither sent; safe for plain HTTP on LAN/port 8080.
const forceHttps = process.env.FORCE_HTTPS === 'true';

// CSP: own assets + jsdelivr for Tabler Icons CSS/fonts.
// style-src needs 'unsafe-inline' for dynamic inline styles (metric-bar widths via innerHTML).
// script-src has no 'unsafe-inline' → injected inline scripts are blocked (XSS protection).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      fontSrc:        ["'self'", 'https://cdn.jsdelivr.net'],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      connectSrc:     ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      // Only active when actually running behind HTTPS — prevents ERR_SSL_PROTOCOL_ERROR on HTTP.
      ...(forceHttps ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  // HSTS must not be sent over plain HTTP: once the browser stores it, it upgrades every
  // subsequent request to https:// — breaking CSS/JS on http://node:8080.
  // helmet v7+: option key is strictTransportSecurity (not hsts — that key is silently ignored).
  strictTransportSecurity: forceHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '16kb' }));
// { index: false } prevents express.static from auto-serving index.html for GET /
// without a session. The SPA root is served explicitly below, behind requireAuth.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// The session middleware needs its secret up front, but the secret may have to be
// read from the DB (async). It is therefore built during startup() and delegated to
// here, so route registration below can stay at module level.
//
// NOTE: the store is deliberately the default in-memory store, NOT a Postgres-backed
// one. req.session holds the user's derived vault key (see /api/login) and that key
// must never reach the database — a DB-backed session store would write it there and
// break the vault threat model. Consequence: sessions are per-process, so the
// dashboard must stay at replicas: 1 and a restart logs everyone out.
let sessionMiddleware = null;
app.use((req, res, next) => {
  if (!sessionMiddleware) return res.status(503).json({ error: 'Server startet noch' });
  return sessionMiddleware(req, res, next);
});

// ---- Auth + role helpers ----

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin')
    return res.status(403).json({ error: 'Keine Berechtigung (Admin erforderlich)' });
  next();
}

// ---- Public routes ----

// login.js must be reachable before auth so the login page can load it.
app.get('/login.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));

app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Eingabe fehlt' });

  const key = getRateKey(req, username);
  const rate = checkRateLimit(key);
  if (rate?.locked) {
    const mins = Math.ceil(rate.remaining / 60_000);
    return res.status(429).json({ error: `Zu viele Versuche. Bitte ${mins} Minute(n) warten.` });
  }

  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
  }

  clearFailures(key);
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role || 'viewer';

  // Derive this user's vault encryption key from their plaintext password
  // (only available here, before it goes out of scope) + their PBKDF2 salt.
  // The key lives ONLY in the server-side session — never written to the DB.
  let vaultSalt = user.vault_salt;
  if (!vaultSalt) {
    vaultSalt = vaultCrypto.newSalt();
    await db.query('UPDATE users SET vault_salt = $1 WHERE id = $2', [vaultSalt, user.id]);
  }
  req.session.vaultKey = vaultCrypto.deriveVaultKey(password, vaultSalt).toString('base64');

  // CSRF token for state-changing vault requests (double-submit pattern —
  // see routes/vault.js). Generated once per session, returned via /api/me.
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');

  res.json({ ok: true, role: user.role });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- Protected zone ----

app.use(requireAuth);

// SPA root — only reachable after requireAuth passes (valid dashboard session).
// Cloudflare Access alone is not sufficient; a real dashboard login is required.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Any authenticated user ----

app.get('/api/me', ah(async (req, res) => {
  const user = await db.one('SELECT username, role, theme FROM users WHERE id = $1', [req.session.userId]);
  res.json({
    username:  user?.username || req.session.username,
    role:      user?.role     || req.session.role || 'viewer',
    theme:     user?.theme    || null,
    csrfToken: req.session.csrfToken || null,
    vaultUnlocked: Boolean(req.session.vaultKey),
  });
}));

app.post('/api/change-password', ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Felder fehlen' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben' });
  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!user || !bcrypt.compareSync(currentPassword, user.hash))
    return res.status(401).json({ error: 'Aktuelles Passwort falsch' });

  // Self-service password change is the ONE place we still hold both the old
  // and the new plaintext password in the same request, so the vault can be
  // re-encrypted losslessly. Rotate the salt too (fresh key, not just a
  // re-derivation with the same salt).
  const newSalt = vaultCrypto.newSalt();
  const newKey  = req.session.vaultKey ? vaultCrypto.deriveVaultKey(newPassword, newSalt) : null;

  // Re-encryption and the password/salt update run in ONE transaction: a crash
  // in between would otherwise leave entries encrypted with the old key while
  // the salt already points at the new one — permanently undecryptable.
  await db.tx(async (client) => {
    if (newKey) {
      const oldKey = Buffer.from(req.session.vaultKey, 'base64');
      const { rows } = await client.query('SELECT * FROM vault_entries WHERE user_id = $1', [user.id]);
      for (const row of rows) {
        const pw    = vaultCrypto.decryptField(row.encrypted_password, oldKey);
        const notes = vaultCrypto.decryptField(row.encrypted_notes, oldKey);
        // pw/notes === null would mean the OLD key itself was already wrong
        // (shouldn't happen here — it was just used to unlock the vault at
        // login). Skip defensively rather than encrypt garbage.
        if (pw === null || notes === null) continue;
        await client.query(
          'UPDATE vault_entries SET encrypted_password = $1, encrypted_notes = $2 WHERE id = $3 AND user_id = $4',
          [vaultCrypto.encryptField(pw, newKey), vaultCrypto.encryptField(notes, newKey), row.id, user.id]
        );
      }
    }
    await client.query(
      'UPDATE users SET hash = $1, vault_salt = $2 WHERE id = $3',
      [bcrypt.hashSync(newPassword, 12), newSalt, user.id]
    );
  });

  // Only swap the in-session key after the transaction committed.
  if (newKey) req.session.vaultKey = newKey.toString('base64');
  res.json({ ok: true });
}));

// Save own theme preference (any authenticated user)
app.put('/api/user/theme', ah(async (req, res) => {
  const { theme } = req.body || {};
  if (!theme) return res.status(400).json({ error: 'theme required' });
  await db.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.session.userId]);
  res.json({ ok: true });
}));

app.get('/api/settings', ah(async (_req, res) => {
  const out = {};
  (await db.all('SELECT key, value FROM settings')).forEach(r => { out[r.key] = r.value; });
  res.json(out);
}));

app.get('/api/services', ah(async (_req, res) => {
  res.json(await db.all('SELECT * FROM services ORDER BY id'));
}));

app.get('/api/background', ah(async (_req, res) => {
  const row = await db.one("SELECT value FROM settings WHERE key = 'bg_file'");
  if (!row) return res.status(404).end();
  const file = path.join(BG_DIR, path.basename(row.value));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
}));

// Vault (native password manager) — every route here inherits requireAuth
// from app.use(requireAuth) above; CSRF + vault-key checks happen inside.
app.use('/api/vault', createVaultRouter(db));

app.get('/api/status', async (_req, res) => {
  try {
    const [nr, sr, tr] = await Promise.all([
      fetch(`${PROXY_URL}/nodes`),
      fetch(`${PROXY_URL}/services`),
      fetch(`${PROXY_URL}/tasks`),
    ]);
    const [nodes, services, tasks] = await Promise.all([nr.json(), sr.json(), tr.json()]);
    const nodesOnline = nodes.filter(n => n.Status?.State === 'ready').length;
    const serviceStatus = services.map(s => ({
      id: s.ID, name: s.Spec?.Name ?? '',
      running: tasks.filter(t => t.ServiceID === s.ID && t.Status?.State === 'running').length,
      desired: s.Spec?.Mode?.Replicated?.Replicas ?? 1,
    }));
    res.json({ nodesOnline, servicesActive: services.length, serviceStatus });
  } catch {
    res.status(503).json({ error: 'proxy unavailable' });
  }
});

// ---- Admin-only routes ----

app.put('/api/settings', requireAdmin, ah(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: 'key + value required' });
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
  res.json({ ok: true });
}));

function validateServiceInput({ name, description, url, icon }) {
  if (typeof name !== 'string' || !name.trim())                     return 'name required';
  if (name.length > 100)                                            return 'name too long';
  if (typeof description !== 'string' || description.length > 300)  return 'description too long';
  if (typeof url !== 'string'         || url.length > 500)          return 'url too long';
  if (typeof icon !== 'string'        || icon.length > 60)          return 'icon too long';
  return null;
}

app.post('/api/services', requireAdmin, ah(async (req, res) => {
  const { name, description = '', url = '', icon = 'layout-dashboard', status = 'unknown' } = req.body ?? {};
  const err = validateServiceInput({ name, description, url, icon });
  if (err) return res.status(400).json({ error: err });
  // RETURNING * replaces SQLite's lastInsertRowid + follow-up SELECT.
  const row = await db.one(
    `INSERT INTO services (name, description, url, icon, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name.trim(), description.trim(), url.trim(), icon.trim() || 'layout-dashboard', status]
  );
  res.status(201).json(row);
}));

app.put('/api/services/:id', requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  const { name, description = '', url = '', icon = 'layout-dashboard', status = 'unknown' } = req.body ?? {};
  const err = validateServiceInput({ name, description, url, icon });
  if (err) return res.status(400).json({ error: err });
  const row = await db.one(
    `UPDATE services SET name = $1, description = $2, url = $3, icon = $4, status = $5
     WHERE id = $6 RETURNING *`,
    [name.trim(), description.trim(), url.trim(), icon.trim() || 'layout-dashboard', status, id]
  );
  if (!row) return res.status(404).json({ error: 'Dienst nicht gefunden' });
  res.json(row);
}));

app.delete('/api/services/:id', requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  await db.query('DELETE FROM services WHERE id = $1', [id]);
  res.sendStatus(204);
}));

app.post('/api/background', requireAdmin, bgUpload.single('image'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei oder ungültiger Typ (JPG/PNG/WebP)' });
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ext  = extMap[req.file.mimetype] || 'jpg';
  const dest = path.join(BG_DIR, `background.${ext}`);
  ['jpg', 'png', 'webp'].forEach(e => {
    const old = path.join(BG_DIR, `background.${e}`);
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch {}
  });
  try { fs.renameSync(req.file.path, dest); } catch {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Speicherfehler' });
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('bg_mode', 'image')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('bg_file', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`background.${ext}`]
  );
  res.json({ ok: true });
}));

app.delete('/api/background', requireAdmin, ah(async (_req, res) => {
  const row = await db.one("SELECT value FROM settings WHERE key = 'bg_file'");
  if (row) {
    const file = path.join(BG_DIR, path.basename(row.value));
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
  await db.query("DELETE FROM settings WHERE key IN ('bg_mode', 'bg_file')");
  res.json({ ok: true });
}));

// User management (admin only)

app.get('/api/users', requireAdmin, ah(async (_req, res) => {
  res.json(await db.all('SELECT id, username, role FROM users ORDER BY id'));
}));

app.post('/api/users', requireAdmin, ah(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Felder fehlen' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort mind. 8 Zeichen' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Ungültige Rolle' });
  // ON CONFLICT instead of a SELECT-then-INSERT: the UNIQUE index decides, so two
  // concurrent requests for the same name can't both get past a pre-check.
  const row = await db.one(
    `INSERT INTO users (username, hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, role`,
    [username.trim(), bcrypt.hashSync(password, 12), role]
  );
  if (!row) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  res.status(201).json(row);
}));

app.put('/api/users/:id/password', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Passwort mind. 8 Zeichen' });

  // Admin-forced reset: the admin never has the target user's OLD plaintext
  // password, so their vault key can't be re-derived and the existing vault
  // entries become permanently undecryptable. Wipe them instead of leaving
  // dead ciphertext rows around, and rotate the salt for the next login.
  const updated = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [id]);
    if (!rows[0]) return false;
    await client.query('DELETE FROM vault_entries WHERE user_id = $1', [id]);
    await client.query(
      'UPDATE users SET hash = $1, vault_salt = $2 WHERE id = $3',
      [bcrypt.hashSync(password, 12), vaultCrypto.newSalt(), id]
    );
    return true;
  });
  if (!updated) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  res.json({ ok: true, vaultWiped: true });
}));

app.put('/api/users/:id/role', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Ungültige Rolle' });

  // The last-admin check and the update must be atomic — otherwise two parallel
  // demotions could both pass the check and leave the system without an admin.
  const result = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return 'notfound';
    if (rows[0].role === 'admin' && role !== 'admin') {
      const { rows: cnt } = await client.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
      if (cnt[0].c <= 1) return 'lastadmin';
    }
    await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    return 'ok';
  });
  if (result === 'notfound')  return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (result === 'lastadmin') return res.status(400).json({ error: 'Letzten Admin nicht herabstufbar' });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid id' });
  if (id === req.session.userId)
    return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });

  const result = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return 'notfound';
    if (rows[0].role === 'admin') {
      const { rows: cnt } = await client.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
      if (cnt[0].c <= 1) return 'lastadmin';
    }
    // Explicit cleanup before the user row goes (vault_entries references users).
    await client.query('DELETE FROM vault_entries WHERE user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    return 'ok';
  });
  if (result === 'notfound')  return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (result === 'lastadmin') return res.status(400).json({ error: 'Letzter Admin nicht löschbar' });
  res.json({ ok: true });
}));

// ---- Metrics aggregation (Glances per-node, API v4) ----

async function fetchGlancesV4(ip, endpoint) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), METRICS_TIMEOUT);
  try {
    const r = await fetch(`http://${ip}:${GLANCES_PORT}/api/4/${endpoint}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Glances v4 may return fs/network as dict (keyed by mount/interface) or array — handle both.
function gatherDisk(data) {
  const items = Array.isArray(data)
    ? data
    : Object.values(data || {});
  const root = items.find(f => f.mnt_point === '/') || items[0];
  if (!root) return { used: null, total: null, percent: null };
  return { used: root.used, total: root.size, percent: root.percent };
}

function gatherNet(data) {
  const items = Array.isArray(data)
    ? data.filter(n => n.interface_name !== 'lo')
    : Object.entries(data || {}).filter(([k]) => k !== 'lo').map(([, v]) => v);
  let rxRate = 0, txRate = 0;
  items.forEach(n => {
    const dt = n.time_since_update || 1;
    rxRate += n.rx_rate ?? ((n.rx ?? 0) / dt);
    txRate += n.tx_rate ?? ((n.tx ?? 0) / dt);
  });
  return { rx_rate: rxRate, tx_rate: txRate };
}

app.get('/api/metrics', async (_req, res) => {
  // Two fresh queries every poll, no cached state between calls.
  // /nodes → authoritative hostname list + Status.Addr (node LAN-IP), total count.
  // /tasks → which nodes have a running Glances task (by NodeID).
  // Glances runs with endpoint_mode:host, port 61208 bound directly on the host NIC.
  // No overlay IP or DNS lookup needed — Status.Addr is the stable LAN address.

  let swarmNodes = [], glancesTasks = [];
  try {
    const taskFilter = encodeURIComponent(JSON.stringify({ service: [GLANCES_SERVICE] }));
    const [nodesRes, tasksRes] = await Promise.all([
      fetch(`${PROXY_URL}/nodes`),
      fetch(`${PROXY_URL}/tasks?filters=${taskFilter}`),
    ]);
    swarmNodes   = await nodesRes.json();
    glancesTasks = await tasksRes.json();
  } catch {
    return res.status(503).json({ nodes: [], error: 'proxy unavailable' });
  }

  // nodeID → { hostname, addr } — addr = node's management/LAN IP from Swarm
  const nodeById = {};
  for (const n of (Array.isArray(swarmNodes) ? swarmNodes : [])) {
    nodeById[n.ID] = {
      hostname: n.Description?.Hostname || n.ID,
      addr:     n.Status?.Addr          || null,
    };
  }

  // Set of nodeIDs with a currently running Glances task
  const runningNodeIds = new Set();
  for (const t of (Array.isArray(glancesTasks) ? glancesTasks : [])) {
    if (t.Status?.State === 'running') runningNodeIds.add(t.NodeID);
  }

  const liveEntries = Object.entries(nodeById).filter(([id]) => runningNodeIds.has(id));
  console.log(
    `[metrics] poll — nodes:${Object.keys(nodeById).length} running:${runningNodeIds.size}` +
    ` addrs=[${liveEntries.map(([, i]) => i.addr || '?').join(', ') || 'none'}]`
  );

  // Query each live node via its LAN IP: metrics + /system for hostname confirmation.
  // Hostname priority: Swarm Description.Hostname → Glances system.hostname → raw IP.
  const agentResults = await Promise.all(
    liveEntries.map(async ([, { hostname, addr }]) => {
      if (!addr) return { hostname, online: false };
      try {
        const [system, cpu, mem, fsData, network] = await Promise.all([
          fetchGlancesV4(addr, 'system'),
          fetchGlancesV4(addr, 'cpu'),
          fetchGlancesV4(addr, 'mem'),
          fetchGlancesV4(addr, 'fs'),
          fetchGlancesV4(addr, 'network'),
        ]);
        // Guard against old container IDs (pre-redeploy): 12- or 64-char hex strings.
        const gh = system?.hostname;
        const glancesHostname = (gh && !/^[0-9a-f]{12,64}$/i.test(gh)) ? gh : null;
        return {
          hostname: hostname || glancesHostname || addr, online: true,
          cpu:  cpu.total ?? null,
          mem:  { used: mem.used, total: mem.total, percent: mem.percent },
          disk: gatherDisk(fsData),
          net:  gatherNet(network),
        };
      } catch {
        console.log(`[metrics] OFFLINE ${hostname} (${addr})`);
        return { hostname, online: false };
      }
    })
  );

  const responded = agentResults.filter(r => r.online).length;
  console.log(`[metrics] responded: ${responded}/${liveEntries.length} — ` +
    agentResults.map(r => `${r.hostname}:${r.online ? 'ok' : 'OFFLINE'}`).join(' '));

  // Swarm nodes not in agentResults → truly offline (no running task or addr missing).
  const coveredHostnames = new Set(agentResults.map(r => r.hostname));
  const offlineResults   = Object.values(nodeById)
    .filter(info => !coveredHostnames.has(info.hostname))
    .map(({ hostname }) => ({ hostname, online: false }));

  const results = [...agentResults, ...offlineResults];
  results.sort((a, b) => a.hostname.localeCompare(b.hostname));
  res.json({ nodes: results });
});

// ---- Backup status ----
// Reads all *.json files from BACKUP_STATUS_DIR — written by backup.sh on each node
// into /mnt/storage/dashboard/backup-status (central NFS), which the container sees
// as /data/backup-status. Deliberately NOT moved into PostgreSQL: the producer is a
// shell script that would otherwise need a psql client and DB credentials on every
// node, and file drops are the simpler contract for that.

const BACKUP_STATUS_DIR = process.env.BACKUP_STATUS_DIR || path.join(DATA_DIR, 'backup-status');
const BACKUP_STALE_MS   = 26 * 60 * 60 * 1000;

app.get('/api/backup', (_req, res) => {
  if (!fs.existsSync(BACKUP_STATUS_DIR)) {
    return res.json({ display_status: 'unknown', most_recent: null, nodes: [] });
  }

  let files;
  try {
    files = fs.readdirSync(BACKUP_STATUS_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return res.json({ display_status: 'unknown', most_recent: null, nodes: [] });
  }

  const nodes = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUP_STATUS_DIR, file), 'utf8'));
      const ageMs = Date.now() - new Date(data.last_run).getTime();
      const stale = isNaN(ageMs) || ageMs > BACKUP_STALE_MS;
      const display_status = data.status === 'failed' ? 'failed' : stale ? 'stale' : 'ok';
      nodes.push({ ...data, display_status });
    } catch { /* skip malformed */ }
  }

  // Sort newest first so most_recent is nodes[0]
  nodes.sort((a, b) => new Date(b.last_run) - new Date(a.last_run));

  // Collective status: any failed → failed; any stale → stale; else ok
  let display_status = nodes.length === 0 ? 'unknown' : 'ok';
  for (const n of nodes) {
    if (n.display_status === 'failed') { display_status = 'failed'; break; }
    if (n.display_status === 'stale' && display_status === 'ok') display_status = 'stale';
  }

  res.json({ display_status, most_recent: nodes[0]?.last_run ?? null, nodes });
});

// ---- Error handler ----
// Must be registered last. Turns a dead/unreachable database into a clear 503
// instead of a hanging request or a crashed process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (db.isConnectionError(err)) {
    console.error(`[dashboard] DB unavailable on ${req.method} ${req.path}: ${err.message}`);
    return res.status(503).json({ error: 'Datenbank nicht erreichbar — bitte spaeter erneut versuchen' });
  }
  console.error(`[dashboard] error on ${req.method} ${req.path}: ${err.message}`);
  // err.message is deliberately NOT sent to the client (see docs/security.md).
  if (res.headersSent) return;
  res.status(500).json({ error: 'Interner Fehler' });
});

// ---- Startup ----

async function startup() {
  console.log(`[dashboard] PostgreSQL target: ${db.describeTarget()}`);

  const connected = await db.waitForDb({ attempts: 5, delayMs: 2000 });

  let secret = null;
  if (connected) {
    try {
      await db.initSchema();
      await seedAdmin();
      secret = await getSessionSecret();
      console.log('[dashboard] database ready (schema verified)');
    } catch (err) {
      console.error(`[dashboard] database setup failed: ${err.message}`);
    }
  }

  if (!secret) {
    // Reachable when Postgres is down OR schema setup failed. Boot anyway with an
    // ephemeral secret so the login page, metrics and backup card still work — DB
    // routes answer 503 until the connection recovers (retryInBackground below).
    secret = readSecret('session_secret', 'SESSION_SECRET') || crypto.randomBytes(32).toString('hex');
    console.error(
      '[dashboard] STARTING WITHOUT DATABASE — login and all DB-backed routes will return 503 ' +
      'until PostgreSQL is reachable. Check DB_HOST/DB_PORT/DB_USER/DB_PASS and that ' +
      'postgres on zs-state-01 accepts connections from this node.'
    );
    if (!process.env.SESSION_SECRET && !readSecret('session_secret', 'SESSION_SECRET')) {
      console.error(
        '[dashboard] NOTE: using a temporary session secret — existing sessions are invalid ' +
        'and will not survive a restart. Set SESSION_SECRET (or the session_secret Docker ' +
        'secret) to avoid this entirely.'
      );
    }
    db.retryInBackground();
  }

  sessionMiddleware = session({
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });

  app.listen(PORT, () => console.log(`[dashboard] listening :${PORT}`));
}

startup().catch((err) => {
  // Last resort: never exit silently, always say why.
  console.error(`[dashboard] fatal startup error: ${err.stack || err.message}`);
  process.exit(1);
});
