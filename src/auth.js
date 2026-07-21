'use strict';

// Authentication hardening: rate limiting, account lockout, password policy,
// CSRF and the timing-equalisation helpers used by /api/login.
//
// This is split out of server.js because it is the part that has to be correct
// for the dashboard to survive being reachable from the internet without
// Cloudflare Access in front of it.
//
// Everything that counts attempts is backed by the login_attempts table rather
// than by a process-local Map. That is the whole point of the table: with
// in-memory counters, restarting the container reset every lockout, so an
// attacker who could provoke a restart — or who simply waited for a deploy —
// got a clean slate.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// ---- Policy ----------------------------------------------------------------

const BCRYPT_COST = 12;

// bcrypt only hashes the first 72 BYTES of the input; anything past that is
// silently ignored, so a longer password is not actually stronger. The maximum
// is enforced to make that boundary explicit rather than surprising.
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 72;

const LIMITS = {
  // Per source IP: 10 failed logins in 15 min → 30 min block.
  ip:       { max: 10, windowMs: 15 * 60_000, blockMs: 30 * 60_000 },
  // Per username, across all IPs: 5 failed logins in 10 min → 15 min block.
  // Tighter than the IP limit because a distributed guess against one account
  // is the attack the IP limit cannot see.
  username: { max: 5,  windowMs: 10 * 60_000, blockMs: 15 * 60_000 },
  // Per source IP: 3 registration attempts an hour. Invalid invite codes count,
  // so the code space cannot be searched.
  register: { max: 3,  windowMs: 60 * 60_000, blockMs: 60 * 60_000 },
};

// Invitations an admin may mint per hour. Not a brute-force defence — an admin
// is already trusted — but a blast-radius limit: a hijacked admin session should
// not be able to produce an unbounded supply of working registration codes
// faster than anyone would notice.
const INVITE_MAX_PER_HOUR = 20;

// Consecutive failures before the account itself is locked. This is the
// per-account counter on users.failed_attempts, independent of the sliding
// windows above: it survives an attacker pacing their attempts to stay under
// the rate limit.
const LOCKOUT_THRESHOLD = 10;

// The lock expires on its own. A permanent lock releasable only by an admin
// reads as the safer option, but it is not: the admin username is guessable, so
// anyone able to reach /login could lock the only admin out for good, and with
// /setup sealed after first run there would be no way back in. An admin can
// still clear a lock early via the users API, and scripts/unlock-user.js is the
// break-glass path if every admin is locked at once.
const LOCKOUT_MS = 30 * 60_000;

// Floor for how long /api/login takes to answer. A miss on the username lookup
// would otherwise return in a millisecond while a real username spends a full
// bcrypt round, which tells an attacker which usernames exist.
const LOGIN_MIN_MS = 400;

// Attempts older than this are neither interesting for an audit nor relevant to
// any window above.
const ATTEMPT_RETENTION_DAYS = 30;

// ---- Timing equalisation ---------------------------------------------------

// A real bcrypt hash to verify against when the username does not exist, so the
// no-such-user path costs the same as the wrong-password path. Generated once
// at module load from a random value — it must never match a real password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

// Verify a password against a hash, or against the dummy when there is no user.
// Always uses the ASYNC bcrypt: the sync version blocks the event loop for the
// full ~250 ms of a cost-12 round, which on a login endpoint is a denial of
// service anyone can trigger by holding the button down.
async function verifyPassword(password, hash) {
  if (!hash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Hold the response until at least LOGIN_MIN_MS has passed since `startedAt`.
async function padTiming(startedAt, minMs = LOGIN_MIN_MS) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
}

// ---- Client IP -------------------------------------------------------------

// Behind the Cloudflare Tunnel every request arrives from the tunnel container,
// so socket.remoteAddress is useless for rate limiting. cf-connecting-ip is set
// by Cloudflare and is the value to trust when TRUST_PROXY is on; without it a
// single spoofed header would let an attacker dodge every per-IP limit.
function clientIp(req) {
  const trustProxy = process.env.TRUST_PROXY !== 'false';
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---- Attempt log -----------------------------------------------------------

// Never called with a password, in any form. The columns cannot hold one.
async function recordAttempt({ username = '', ip = '', success = false, kind = 'login' }) {
  await db.query(
    'INSERT INTO login_attempts (username, ip, success, kind) VALUES ($1, $2, $3, $4)',
    [String(username).slice(0, 200).toLowerCase(), ip, success, kind]
  );
}

// Is this (column, value) pair currently blocked?
//
// Reads the timestamps of the last `max` failures. If that many failures fit
// inside `windowMs`, the limit tripped, and the block runs for `blockMs` from
// the most recent one. Attempts rejected *because* of a block are deliberately
// not logged by the callers, so a blocked client cannot extend its own block
// indefinitely by continuing to hammer the endpoint.
// A column name cannot be a bind parameter, so it is interpolated — and is
// therefore restricted to an explicit allowlist. Both call sites pass a literal
// today; the allowlist is what keeps that true if a future one passes something
// derived from a request.
const COUNTABLE_COLUMNS = new Set(['ip', 'username']);

async function isBlocked(column, value, limit, kind = 'login') {
  if (!COUNTABLE_COLUMNS.has(column)) throw new Error(`isBlocked: illegal column ${column}`);
  const max = Number.parseInt(limit.max, 10);
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new Error('isBlocked: illegal limit');

  const rows = await db.all(
    `SELECT created_at FROM login_attempts
      WHERE ${column} = $1 AND success = FALSE AND kind = $2
      ORDER BY created_at DESC
      LIMIT ${max}`,
    [value, kind]
  );
  if (rows.length < limit.max) return null;

  const newest = new Date(rows[0].created_at).getTime();
  const oldest = new Date(rows[rows.length - 1].created_at).getTime();
  if (newest - oldest > limit.windowMs) return null;

  const until = newest + limit.blockMs;
  const remaining = until - Date.now();
  return remaining > 0 ? { remaining } : null;
}

async function checkLoginRateLimit(ip, username) {
  const byIp = await isBlocked('ip', ip, LIMITS.ip);
  if (byIp) return byIp;
  return isBlocked('username', String(username).toLowerCase(), LIMITS.username);
}

async function checkRegisterRateLimit(ip) {
  return isBlocked('ip', ip, LIMITS.register, 'register');
}

// Counted against invite_codes itself rather than the attempt log: what matters
// is how many live codes one admin has produced, which is a property of the
// invites table, not of a request counter.
async function checkInviteQuota(userId) {
  const { c } = await db.one(
    `SELECT COUNT(*)::int AS c FROM invite_codes
      WHERE created_by = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  return c >= INVITE_MAX_PER_HOUR ? { made: c, max: INVITE_MAX_PER_HOUR } : null;
}

// ---- Account lockout -------------------------------------------------------

function isLocked(user) {
  if (!user?.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}

async function registerFailedLogin(user) {
  if (!user) return;
  const next = (user.failed_attempts || 0) + 1;
  if (next >= LOCKOUT_THRESHOLD) {
    await db.query(
      'UPDATE users SET failed_attempts = $1, locked_until = NOW() + ($2 || \' milliseconds\')::interval WHERE id = $3',
      [next, String(LOCKOUT_MS), user.id]
    );
  } else {
    await db.query('UPDATE users SET failed_attempts = $1 WHERE id = $2', [next, user.id]);
  }
}

async function clearFailedLogins(userId) {
  await db.query(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [userId]
  );
}

// ---- Password policy -------------------------------------------------------

// Returns null when acceptable, otherwise { error, code } ready to send.
// The codes resolve to err.* keys in i18n.js.
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { error: 'Password missing', code: 'PW_MISSING' };
  }
  if (password.length < PASSWORD_MIN) {
    return { error: `Password must be at least ${PASSWORD_MIN} characters`, code: 'PW_TOO_SHORT' };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX) {
    return { error: `Password must be at most ${PASSWORD_MAX} bytes`, code: 'PW_TOO_LONG' };
  }
  return null;
}

function usernameProblem(username) {
  if (typeof username !== 'string' || !username.trim()) {
    return { error: 'Username missing', code: 'USERNAME_MISSING' };
  }
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) {
    return { error: 'Username must be 3-32 characters (letters, digits, . _ -)', code: 'USERNAME_INVALID' };
  }
  return null;
}

// ---- CSRF ------------------------------------------------------------------

// Double-submit: the token lives in the server-side session and must be echoed
// in the X-CSRF-Token header. It is never put in a cookie, so a cross-site
// request cannot read it.
//
// The three unauthenticated entry points are exempt because there is no session
// to hold a token yet, and creating one for every anonymous visitor would let
// an unauthenticated client fill the in-memory session store. They are covered
// instead by sameSite: 'strict' on the session cookie plus their rate limits.
const CSRF_EXEMPT = new Set(['/api/login', '/api/setup', '/api/register']);
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function issueCsrfToken(session) {
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(32).toString('hex');
  return session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT.has(req.path)) return next();

  const sent = req.headers['x-csrf-token'];
  const expected = req.session?.csrfToken;
  if (!sent || !expected || !safeEqual(String(sent), expected)) {
    return res.status(403).json({ error: 'CSRF token invalid or missing', code: 'CSRF_INVALID' });
  }
  next();
}

// timingSafeEqual throws on a length mismatch, so compare fixed-size digests
// instead of the raw strings.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Invite codes ----------------------------------------------------------

function newInviteCode() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

// ---- Housekeeping ----------------------------------------------------------

// The attempt log is append-only and would otherwise grow without bound.
async function pruneLoginAttempts() {
  const { rowCount } = await db.query(
    `DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '${ATTEMPT_RETENTION_DAYS} days'`
  );
  if (rowCount) console.log(`[auth] pruned ${rowCount} login attempt(s) older than ${ATTEMPT_RETENTION_DAYS} days`);
}

module.exports = {
  BCRYPT_COST, PASSWORD_MIN, PASSWORD_MAX, LIMITS, LOCKOUT_THRESHOLD, LOCKOUT_MS,
  INVITE_MAX_PER_HOUR,
  verifyPassword, hashPassword, padTiming,
  clientIp, recordAttempt, checkLoginRateLimit, checkRegisterRateLimit, checkInviteQuota,
  isLocked, registerFailedLogin, clearFailedLogins,
  passwordProblem, usernameProblem,
  issueCsrfToken, csrfProtection,
  newInviteCode, pruneLoginAttempts,
};
