'use strict';

const express = require('express');
const helmet  = require('helmet');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
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

// ---- First run ----
// There is no environment-seeded admin any more. On an empty users table the
// server serves the /setup wizard instead of the login page, and the first admin
// is created there — so the initial password is typed into a browser form,
// hashed immediately, and never exists as an environment variable, in the
// compose file, in Portainer's UI, or in a shell history.
//
// Deliberately NOT cached in a module variable: /setup must seal itself the
// instant the first account exists, and a cached "true" would keep the wizard
// open until the next restart.
async function noUsersYet() {
  // COUNT(*) comes back as a bigint, which node-postgres returns as a STRING.
  // The ::int cast keeps this an actual number (a plain === 0 would never match).
  const { c } = await db.one('SELECT COUNT(*)::int AS c FROM users');
  return c === 0;
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

// Rate limiting, account lockout and the password policy now live in auth.js and
// are backed by the login_attempts table rather than by a Map in this process —
// see the comment at the top of that file for why.
//
// Trim the attempt log daily so it stays an audit trail rather than a landfill.
setInterval(() => {
  auth.pruneLoginAttempts().catch(err => console.error(`[auth] prune failed: ${err.message}`));
}, 24 * 60 * 60_000).unref?.();

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

// Static images (mascot logo, favicons) are content-stable: they only change when
// a new file is committed, so they get a long max-age instead of the revalidation
// round trip every page load would otherwise cost. Mounted before the general
// static handler so it wins for /img/*.
//
// Deliberately NOT applied to the HTML/JS/CSS below: this frontend has no build
// step and therefore no content hashes in filenames, so caching those would leave
// browsers on a stale bundle after a deploy.
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), {
  maxAge: '30d',
  immutable: false,
}));

// { index: false } stops express.static from auto-serving index.html for GET /
// without a session, but it does NOT stop an explicit GET /index.html — and the
// same goes for setup.html and register.html, which have their own gated routes
// below. Block the direct filenames so those gates cannot be walked around by
// asking for the file instead of the path.
const GATED_PAGES = new Set(['/index.html', '/setup.html', '/register.html', '/login.html']);
app.use((req, res, next) => {
  if (GATED_PAGES.has(req.path)) return res.status(404).end();
  next();
});

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
  if (!sessionMiddleware) return res.status(503).json({ error: 'Server is still starting', code: 'STARTING' });
  return sessionMiddleware(req, res, next);
});

// ---- Auth + role helpers ----

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in', code: 'UNAUTHORIZED' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin')
    return res.status(403).json({ error: 'Not permitted (admin required)', code: 'FORBIDDEN_ADMIN' });
  next();
}

// ---- Public routes ----

// These scripts must be reachable before auth so the unauthenticated pages can
// load them.
for (const f of ['login.js', 'setup.js', 'register.js', 'password-strength.js']) {
  app.get(`/${f}`, (_req, res) => res.sendFile(path.join(__dirname, 'public', f)));
}

app.get('/login', ah(async (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  // A fresh install has no account to log into — send the operator to the wizard
  // rather than to a form that cannot succeed.
  if (await noUsersYet()) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
}));

// ---- Setup wizard ----
// Reachable only while the users table is empty. Once the first admin exists
// this 404s forever, which is what makes it safe to leave unauthenticated.

app.get('/setup', ah(async (req, res) => {
  if (!await noUsersYet()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
}));

app.post('/api/setup', ah(async (req, res) => {
  const { username, password } = req.body || {};

  const bad = auth.usernameProblem(username) || auth.passwordProblem(password);
  if (bad) return res.status(400).json(bad);

  // The empty-table check and the INSERT run in one transaction with the table
  // locked. Two operators hitting /setup at the same moment on a fresh install
  // would otherwise both pass the check and both become admin.
  const created = await db.tx(async (client) => {
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM users');
    if (rows[0].c !== 0) return null;
    const hash = await auth.hashPassword(password);
    const { rows: ins } = await client.query(
      `INSERT INTO users (username, hash, role) VALUES ($1, $2, 'admin')
       RETURNING id, username, role`,
      [username.trim(), hash]
    );
    return ins[0];
  });

  if (!created) {
    // Somebody won the race, or the wizard was replayed. Never say more than
    // this — /setup being closed is all the caller is entitled to know.
    return res.status(403).json({ error: 'Setup is already complete', code: 'SETUP_CLOSED' });
  }

  console.log(`[dashboard] Setup complete — initial admin '${created.username}' created`);
  res.status(201).json({ ok: true });
}));

// ---- Registration by invite ----

app.get('/register', ah(async (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  if (await noUsersYet()) return res.redirect('/setup');
  // The page renders regardless of whether the code is valid: telling an
  // anonymous visitor "this code does not exist" turns the page into an oracle
  // for probing the code space. Validation happens in POST /api/register, which
  // is rate limited.
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
}));

app.post('/api/register', ah(async (req, res) => {
  const started = Date.now();
  const ip = auth.clientIp(req);
  const { code, username, password } = req.body || {};

  // Every failure below returns this exact response. An attacker must not be
  // able to tell "no such code" from "expired", "already used" or "username
  // taken" — each of those distinctions leaks something.
  const reject = async () => {
    await auth.recordAttempt({ username: username || '', ip, success: false, kind: 'register' });
    await auth.padTiming(started);
    return res.status(400).json({ error: 'Invitation code invalid or expired', code: 'INVITE_INVALID' });
  };

  const blocked = await auth.checkRegisterRateLimit(ip);
  if (blocked) {
    await auth.padTiming(started);
    return res.status(429).json({
      error: 'Too many attempts. Try again later.',
      code: 'RATE_LIMITED',
      retryAfterMinutes: Math.ceil(blocked.remaining / 60_000),
    });
  }

  // Input problems are reported honestly — the client needs to be able to fix
  // them, and none of them reveal anything about the invite.
  const bad = auth.usernameProblem(username) || auth.passwordProblem(password);
  if (bad) return res.status(400).json(bad);
  if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) return reject();

  const outcome = await db.tx(async (client) => {
    // FOR UPDATE so two people redeeming the same code at once cannot both win.
    const { rows } = await client.query(
      `SELECT id, expires_at, used_by, max_role FROM invite_codes
        WHERE code = $1 FOR UPDATE`,
      [code]
    );
    const invite = rows[0];
    if (!invite) return 'invalid';
    if (invite.used_by) return 'invalid';
    if (new Date(invite.expires_at).getTime() <= Date.now()) return 'invalid';

    const role = invite.max_role === 'admin' ? 'admin' : 'viewer';
    const hash = await auth.hashPassword(password);
    const { rows: ins } = await client.query(
      `INSERT INTO users (username, hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [username.trim(), hash, role]
    );
    if (!ins[0]) return 'invalid'; // username taken — same generic answer

    await client.query(
      'UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE id = $2',
      [ins[0].id, invite.id]
    );
    return 'ok';
  });

  if (outcome !== 'ok') return reject();

  await auth.recordAttempt({ username, ip, success: true, kind: 'register' });
  await auth.padTiming(started);
  console.log(`[dashboard] New account '${username.trim()}' registered via invite`);
  res.status(201).json({ ok: true });
}));

app.post('/api/login', ah(async (req, res) => {
  const started = Date.now();
  const ip = auth.clientIp(req);
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Input missing', code: 'INPUT_MISSING' });

  // Every rejection past this point answers with the same body and the same
  // elapsed time, so the response cannot be used to enumerate usernames or to
  // discover which accounts are locked.
  const genericFail = async () => {
    await auth.padTiming(started);
    return res.status(401).json({ error: 'Wrong username or password', code: 'BAD_CREDENTIALS' });
  };

  // Checked BEFORE anything is recorded: a blocked caller must not be able to
  // extend its own block by continuing to hammer the endpoint.
  const blocked = await auth.checkLoginRateLimit(ip, username);
  if (blocked) {
    await auth.padTiming(started);
    return res.status(429).json({
      error: 'Too many attempts. Try again later.',
      code: 'RATE_LIMITED',
      retryAfterMinutes: Math.ceil(blocked.remaining / 60_000),
    });
  }

  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);

  // Run the password check even when the account is locked or does not exist,
  // so all three paths cost one bcrypt round.
  const passwordOk = await auth.verifyPassword(password, user?.hash);

  if (auth.isLocked(user)) {
    await auth.recordAttempt({ username, ip, success: false });
    // The one non-generic case, and only for a caller who already proved they
    // know the password: without it a locked-out user has no way to understand
    // why a correct password keeps failing.
    if (passwordOk) {
      await auth.padTiming(started);
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      return res.status(423).json({
        error: 'Account temporarily locked after repeated failed logins',
        code: 'ACCOUNT_LOCKED',
        retryAfterMinutes: Math.max(1, mins),
      });
    }
    return genericFail();
  }

  if (!user || !passwordOk) {
    await auth.recordAttempt({ username, ip, success: false });
    await auth.registerFailedLogin(user);
    return genericFail();
  }

  await auth.recordAttempt({ username, ip, success: true });
  await auth.clearFailedLogins(user.id);

  // Session fixation: an attacker who can set a session cookie before login
  // would otherwise still hold a valid one after it. Issue a new session id.
  await new Promise((resolve, reject) =>
    req.session.regenerate(err => (err ? reject(err) : resolve()))
  );

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

  // CSRF token for every state-changing request (double-submit pattern).
  // Generated once per session, handed to the client via /api/me.
  auth.issueCsrfToken(req.session);

  res.json({ ok: true, role: user.role });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- Protected zone ----

app.use(requireAuth);

// CSRF applies to everything below this line — every authenticated POST, PUT and
// DELETE, not just the vault. It sits after requireAuth because it needs a
// session to compare against; the three unauthenticated POST endpoints above are
// covered by sameSite: 'strict' plus their own rate limits (see auth.js).
app.use(auth.csrfProtection);

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
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Fields missing', code: 'FIELDS_MISSING' });
  const bad = auth.passwordProblem(newPassword);
  if (bad) return res.status(400).json(bad);
  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  if (!user || !await auth.verifyPassword(currentPassword, user.hash))
    return res.status(401).json({ error: 'Current password is wrong', code: 'PW_CURRENT_WRONG' });

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
      [await auth.hashPassword(newPassword), newSalt, user.id]
    );
  });

  // Only swap the in-session key after the transaction committed.
  if (newKey) req.session.vaultKey = newKey.toString('base64');
  res.json({ ok: true });
}));

// Save own theme preference (any authenticated user)
app.put('/api/user/theme', ah(async (req, res) => {
  const { theme } = req.body || {};
  if (!theme) return res.status(400).json({ error: 'Theme required', code: 'THEME_REQUIRED' });
  // A named preset or a hex colour — nothing else has any meaning to the client,
  // and an unbounded string here is a free write primitive into the users table.
  if (typeof theme !== 'string' || !/^(#[0-9a-fA-F]{6}|[a-z]{3,16})$/.test(theme)) {
    return res.status(400).json({ error: 'Invalid theme', code: 'THEME_INVALID' });
  }
  await db.query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.session.userId]);
  res.json({ ok: true });
}));

// The settings table is NOT purely UI configuration — getSessionSecret() stores
// the session signing key in it. This route is readable by any authenticated
// user, so returning the table wholesale handed every viewer the secret used to
// sign session cookies, which is enough to forge an admin session.
//
// Hence an allowlist rather than a denylist: a new internal key added later must
// not silently become world-readable because nobody remembered to exclude it.
const PUBLIC_SETTINGS = new Set(['theme', 'bg_mode', 'bg_file']);

app.get('/api/settings', ah(async (_req, res) => {
  const out = {};
  (await db.all('SELECT key, value FROM settings WHERE key = ANY($1)', [[...PUBLIC_SETTINGS]]))
    .forEach(r => { out[r.key] = r.value; });
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
    res.status(503).json({ error: 'Docker proxy unavailable', code: 'PROXY_UNAVAILABLE' });
  }
});

// ---- Admin-only routes ----

app.put('/api/settings', requireAdmin, ah(async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: 'Key and value required', code: 'KEY_VALUE_REQUIRED' });
  // Same allowlist as the read side: without it an admin could overwrite
  // session_secret through the settings UI and invalidate every session — or
  // set it to a value of their choosing.
  if (!PUBLIC_SETTINGS.has(key)) {
    return res.status(400).json({ error: 'Unknown setting', code: 'SETTING_UNKNOWN' });
  }
  if (String(value).length > 512) {
    return res.status(400).json({ error: 'Value too long', code: 'SETTING_TOO_LONG' });
  }
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
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  const { name, description = '', url = '', icon = 'layout-dashboard', status = 'unknown' } = req.body ?? {};
  const err = validateServiceInput({ name, description, url, icon });
  if (err) return res.status(400).json({ error: err });
  const row = await db.one(
    `UPDATE services SET name = $1, description = $2, url = $3, icon = $4, status = $5
     WHERE id = $6 RETURNING *`,
    [name.trim(), description.trim(), url.trim(), icon.trim() || 'layout-dashboard', status, id]
  );
  if (!row) return res.status(404).json({ error: 'Service not found', code: 'SERVICE_NOT_FOUND' });
  res.json(row);
}));

app.delete('/api/services/:id', requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  await db.query('DELETE FROM services WHERE id = $1', [id]);
  res.sendStatus(204);
}));

app.post('/api/background', requireAdmin, bgUpload.single('image'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or invalid type (JPG/PNG/WebP)', code: 'BAD_UPLOAD' });
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ext  = extMap[req.file.mimetype] || 'jpg';
  const dest = path.join(BG_DIR, `background.${ext}`);
  ['jpg', 'png', 'webp'].forEach(e => {
    const old = path.join(BG_DIR, `background.${e}`);
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch {}
  });
  try { fs.renameSync(req.file.path, dest); } catch {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Storage error', code: 'STORAGE_ERROR' });
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

// Invitations (admin only)
//
// After setup, an invite code is the ONLY way an account can come into
// existence — there is no open registration and no admin-set password for a new
// user, so a new user's password is never known to anyone but themselves.

app.post('/api/invite', requireAdmin, ah(async (req, res) => {
  const { expiresInDays, maxRole } = req.body || {};

  const days = Number.isFinite(Number(expiresInDays)) ? Math.trunc(Number(expiresInDays)) : 7;
  if (days < 1 || days > 90) {
    return res.status(400).json({ error: 'Expiry must be between 1 and 90 days', code: 'INVITE_EXPIRY_INVALID' });
  }
  const role = maxRole === 'admin' ? 'admin' : 'viewer';

  const over = await auth.checkInviteQuota(req.session.userId);
  if (over) {
    return res.status(429).json({
      error: `Invite limit reached (${over.max} per hour)`,
      code: 'INVITE_QUOTA',
    });
  }

  const row = await db.one(
    `INSERT INTO invite_codes (code, created_by, expires_at, max_role)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval, $4)
     RETURNING id, code, created_at, expires_at, max_role`,
    [auth.newInviteCode(), req.session.userId, String(days), role]
  );
  console.log(`[dashboard] Invite created by '${req.session.username}' (role ${role}, ${days}d)`);
  res.status(201).json(row);
}));

app.get('/api/invites', requireAdmin, ah(async (_req, res) => {
  const rows = await db.all(
    `SELECT i.id, i.code, i.created_at, i.expires_at, i.used_at, i.max_role,
            c.username AS created_by_name,
            u.username AS used_by_name,
            CASE
              WHEN i.used_by IS NOT NULL   THEN 'used'
              WHEN i.expires_at <= NOW()   THEN 'expired'
              ELSE 'active'
            END AS status
       FROM invite_codes i
       LEFT JOIN users c ON c.id = i.created_by
       LEFT JOIN users u ON u.id = i.used_by
      ORDER BY i.created_at DESC`
  );
  res.json(rows);
}));

app.delete('/api/invite/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  // A redeemed code is kept: it is the audit record of how an account came to
  // exist. Only unredeemed ones can be revoked.
  const { rowCount } = await db.query('DELETE FROM invite_codes WHERE id = $1 AND used_by IS NULL', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Invite not found or already redeemed', code: 'INVITE_NOT_FOUND' });
  res.json({ ok: true });
}));

// Schema health (admin only). Exists because a partially-applied schema is
// invisible from the UI: everything that was already there keeps working, and
// the only symptom is one feature returning 500. This answers "is the table
// actually there?" without shell access to Postgres.
app.get('/api/health/schema', requireAdmin, ah(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [db.REQUIRED_TABLES]
  );
  const present = rows.map(r => r.table_name);
  const missing = db.REQUIRED_TABLES.filter(t => !present.includes(t));
  res.status(missing.length ? 503 : 200).json({ ok: missing.length === 0, present, missing });
}));

// Login audit trail (admin only) — lets an admin see whether anyone is knocking.
app.get('/api/login-attempts', requireAdmin, ah(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await db.all(
    `SELECT username, ip, success, kind, created_at
       FROM login_attempts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
}));

// User management (admin only)

app.get('/api/users', requireAdmin, ah(async (_req, res) => {
  res.json(await db.all(
    `SELECT id, username, role, failed_attempts,
            CASE WHEN locked_until > NOW() THEN locked_until ELSE NULL END AS locked_until
       FROM users ORDER BY id`
  ));
}));

// Clear a lockout early. The lock also expires on its own (see auth.js), so this
// is a convenience rather than the only way out.
app.post('/api/users/:id/unlock', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  const { rowCount } = await db.query(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]
  );
  if (!rowCount) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  res.json({ ok: true });
}));

app.post('/api/users', requireAdmin, ah(async (req, res) => {
  const { username, password, role } = req.body || {};
  const bad = auth.usernameProblem(username) || auth.passwordProblem(password);
  if (bad) return res.status(400).json(bad);
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role', code: 'INVALID_ROLE' });
  // ON CONFLICT instead of a SELECT-then-INSERT: the UNIQUE index decides, so two
  // concurrent requests for the same name can't both get past a pre-check.
  const row = await db.one(
    `INSERT INTO users (username, hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, role`,
    [username.trim(), await auth.hashPassword(password), role]
  );
  if (!row) return res.status(409).json({ error: 'Username already taken', code: 'USERNAME_TAKEN' });
  res.status(201).json(row);
}));

app.put('/api/users/:id/password', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  const bad = auth.passwordProblem(password);
  if (bad) return res.status(400).json(bad);

  // Admin-forced reset: the admin never has the target user's OLD plaintext
  // password, so their vault key can't be re-derived and the existing vault
  // entries become permanently undecryptable. Wipe them instead of leaving
  // dead ciphertext rows around, and rotate the salt for the next login.
  const updated = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [id]);
    if (!rows[0]) return false;
    await client.query('DELETE FROM vault_entries WHERE user_id = $1', [id]);
    await client.query(
      'UPDATE users SET hash = $1, vault_salt = $2, failed_attempts = 0, locked_until = NULL WHERE id = $3',
      [await auth.hashPassword(password), vaultCrypto.newSalt(), id]
    );
    return true;
  });
  if (!updated) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  res.json({ ok: true, vaultWiped: true });
}));

app.put('/api/users/:id/role', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role', code: 'INVALID_ROLE' });

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
  if (result === 'notfound')  return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  if (result === 'lastadmin') return res.status(400).json({ error: 'The last admin cannot be demoted', code: 'LAST_ADMIN_DEMOTE' });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
  if (id === req.session.userId)
    return res.status(400).json({ error: 'You cannot delete your own account', code: 'SELF_DELETE' });

  const result = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) return 'notfound';
    if (rows[0].role === 'admin') {
      const { rows: cnt } = await client.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
      if (cnt[0].c <= 1) return 'lastadmin';
    }
    // Explicit cleanup before the user row goes — vault_entries and
    // invite_codes both reference users(id), so the DELETE fails on the foreign
    // key otherwise. The invite rows are kept but detached: they are the record
    // of how accounts were created, and losing that on a user deletion would
    // punch a hole in the audit trail.
    await client.query('DELETE FROM vault_entries WHERE user_id = $1', [id]);
    await client.query('UPDATE invite_codes SET created_by = NULL WHERE created_by = $1', [id]);
    await client.query('UPDATE invite_codes SET used_by = NULL WHERE used_by = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    return 'ok';
  });
  if (result === 'notfound')  return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  if (result === 'lastadmin') return res.status(400).json({ error: 'The last admin cannot be deleted', code: 'LAST_ADMIN_DELETE' });
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

// ---- Standalone hosts ----
//
// Not every machine worth watching is a Swarm node. zs-state-01 (Postgres) and
// zs-store-01 (NFS) deliberately sit outside the cluster, so they never appear
// in /nodes and were invisible here — which is backwards, since the database and
// the shared storage are the two hosts whose failure takes everything else with
// them.
//
// Format: EXTRA_HOSTS=name:ip[:label],name:ip[:label]
// The label is free text shown as a badge on the card ("Stateful", "Storage");
// it defaults to nothing. Glances must be reachable on GLANCES_PORT, same as on
// the Swarm nodes.
function parseExtraHosts(raw) {
  if (!raw || !raw.trim()) return [];
  const out = [];
  for (const entry of raw.split(',')) {
    const part = entry.trim();
    if (!part) continue;
    const [name, addr, label] = part.split(':').map(s => (s || '').trim());
    if (!name || !addr) {
      // Loud but non-fatal: one malformed entry must not cost the whole list,
      // and it must not take the dashboard down at boot either.
      console.error(`[metrics] EXTRA_HOSTS: ignoring malformed entry "${part}" (expected name:ip[:label])`);
      continue;
    }
    out.push({ hostname: name, addr, label: label || null });
  }
  return out;
}

const EXTRA_HOSTS = parseExtraHosts(process.env.EXTRA_HOSTS);
if (EXTRA_HOSTS.length) {
  console.log(`[metrics] standalone hosts: ${EXTRA_HOSTS.map(h => `${h.hostname}(${h.addr})`).join(', ')}`);
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

// One host's full metric set. Shared by Swarm nodes and standalone hosts so the
// two can never drift apart in what they report — the frontend renders them with
// the same card, and a difference here would show up as a half-empty card.
async function pollHost({ hostname, addr, label = null }) {
  if (!addr) return { hostname, label, online: false };
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
      hostname: hostname || glancesHostname || addr,
      label,
      online: true,
      cpu:  cpu.total ?? null,
      mem:  { used: mem.used, total: mem.total, percent: mem.percent },
      disk: gatherDisk(fsData),
      net:  gatherNet(network),
    };
  } catch {
    console.log(`[metrics] OFFLINE ${hostname} (${addr})`);
    return { hostname, label, online: false };
  }
}

app.get('/api/metrics', async (_req, res) => {
  // Two fresh queries every poll, no cached state between calls.
  // /nodes → authoritative hostname list + Status.Addr (node LAN-IP), total count.
  // /tasks → which nodes have a running Glances task (by NodeID).
  // Glances runs with endpoint_mode:host, port 61208 bound directly on the host NIC.
  // No overlay IP or DNS lookup needed — Status.Addr is the stable LAN address.

  // Standalone hosts are polled directly and do not involve the Docker proxy, so
  // this starts before the proxy call and survives it failing. That is the whole
  // point: when the Swarm is in trouble, the database and storage hosts are
  // precisely the ones you still want to see.
  const extraPromise = Promise.all(EXTRA_HOSTS.map(pollHost));

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
    return res.status(503).json({
      nodes: [],
      extraHosts: await extraPromise,
      error: 'Docker proxy unavailable',
      code: 'PROXY_UNAVAILABLE',
    });
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
  const [agentResults, extraResults] = await Promise.all([
    Promise.all(liveEntries.map(([, info]) => pollHost(info))),
    extraPromise,
  ]);

  const responded = agentResults.filter(r => r.online).length;
  console.log(`[metrics] responded: ${responded}/${liveEntries.length} — ` +
    agentResults.map(r => `${r.hostname}:${r.online ? 'ok' : 'OFFLINE'}`).join(' '));
  if (extraResults.length) {
    console.log(`[metrics] standalone: ${extraResults.filter(r => r.online).length}/${extraResults.length} — ` +
      extraResults.map(r => `${r.hostname}:${r.online ? 'ok' : 'OFFLINE'}`).join(' '));
  }

  // Swarm nodes not in agentResults → truly offline (no running task or addr missing).
  const coveredHostnames = new Set(agentResults.map(r => r.hostname));
  const offlineResults   = Object.values(nodeById)
    .filter(info => !coveredHostnames.has(info.hostname))
    .map(({ hostname }) => ({ hostname, online: false }));

  const results = [...agentResults, ...offlineResults];
  results.sort((a, b) => a.hostname.localeCompare(b.hostname));

  // Kept in a separate key rather than merged into `nodes`: these are not Swarm
  // members, and folding them in would quietly inflate the "nodes online X/Y"
  // tile into a number that no longer describes the cluster.
  extraResults.sort((a, b) => a.hostname.localeCompare(b.hostname));
  res.json({ nodes: results, extraHosts: extraResults });
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
    return res.status(503).json({ error: 'Database unavailable — please try again later', code: 'DB_UNAVAILABLE' });
  }
  console.error(`[dashboard] error on ${req.method} ${req.path}: ${err.message}`);
  // err.message is deliberately NOT sent to the client (see docs/security.md).
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
});

// ---- Startup ----

async function startup() {
  console.log(`[dashboard] PostgreSQL target: ${db.describeTarget()}`);

  const connected = await db.waitForDb({ attempts: 5, delayMs: 2000 });

  let secret = null;
  if (connected) {
    try {
      await db.initSchema();
      secret = await getSessionSecret();
      await auth.pruneLoginAttempts();
      if (await noUsersYet()) {
        console.log('[dashboard] No accounts yet — the setup wizard is open at /setup');
      }
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
    // The default name 'connect.sid' advertises the stack to anyone reading
    // response headers. Not a defence on its own, just free.
    name: 'zs.sid',
    cookie: {
      httpOnly: true,
      // 'strict' rather than 'lax': the dashboard is never legitimately entered
      // by a cross-site navigation, and strict is what covers the three
      // unauthenticated POST endpoints that cannot carry a CSRF token.
      sameSite: 'strict',
      secure: forceHttps || process.env.COOKIE_SECURE === 'true',
      // 24h, down from a week. The session holds the derived vault key, so its
      // lifetime is how long a stolen session cookie can decrypt the vault.
      maxAge: 24 * 60 * 60 * 1000,
    },
  });

  app.listen(PORT, () => console.log(`[dashboard] listening :${PORT}`));
}

startup().catch((err) => {
  // Last resort: never exit silently, always say why.
  console.error(`[dashboard] fatal startup error: ${err.stack || err.message}`);
  process.exit(1);
});
