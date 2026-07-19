'use strict';

const express = require('express');
const { encryptField, decryptField } = require('../vault-crypto');

// Mounted at /api/vault, after the global requireAuth middleware in
// server.js — every route here already requires a valid session.
//
// req.session.vaultKey (base64, set at login — see server.js) is the
// per-user AES-256 key. It never touches the DB. Sessions created before
// this feature shipped (or after an admin-forced password reset) won't
// have it — vaultKey() below turns that into a clear 409 instead of a crash.
//
// The crypto is unchanged by the PostgreSQL migration: encryption still happens
// in Node (AES-256-GCM, key derived via PBKDF2 from the login password). Only the
// storage calls below became async/parameterised.

module.exports = function createVaultRouter(db) {
  const router = express.Router();

  // Express 4 does not catch rejections from async handlers — forward them to the
  // error middleware in server.js instead of leaving the request hanging.
  const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function vaultKey(req) {
    if (!req.session.vaultKey) return null;
    return Buffer.from(req.session.vaultKey, 'base64');
  }

  function requireVaultKey(req, res, next) {
    const key = vaultKey(req);
    if (!key) {
      return res.status(409).json({
        error: 'The vault is locked — sign out and back in to unlock it.', code: 'VAULT_LOCKED',
      });
    }
    req.vaultKey = key;
    next();
  }

  // ---- CSRF: double-submit token, session-bound (see /api/me in server.js
  // for how the frontend obtains it) ----
  function requireCsrf(req, res, next) {
    const sent = req.headers['x-csrf-token'];
    if (!sent || sent !== req.session.csrfToken) {
      return res.status(403).json({ error: 'Invalid CSRF token', code: 'CSRF' });
    }
    next();
  }

  // ---- Rate limiting (in-memory, per user — mirrors the login limiter in server.js) ----
  const hits = new Map(); // userId -> { count, windowStart }
  const RATE_WINDOW = 5 * 60_000;
  const RATE_MAX    = 120; // generous — this gates abuse/bugs, not normal use
  function rateLimit(req, res, next) {
    const uid = req.session.userId;
    const now = Date.now();
    const e = hits.get(uid) || { count: 0, windowStart: now };
    if (now - e.windowStart > RATE_WINDOW) { e.count = 0; e.windowStart = now; }
    e.count++;
    hits.set(uid, e);
    if (e.count > RATE_MAX) {
      return res.status(429).json({ error: 'Too many vault requests — please wait a moment.', code: 'VAULT_RATE_LIMIT' });
    }
    next();
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.windowStart > RATE_WINDOW) hits.delete(k);
  }, 30 * 60_000);

  router.use(rateLimit);

  // created_at/updated_at are TIMESTAMPTZ, so node-postgres hands back Date objects.
  // Serialising them to ISO strings keeps the API contract identical to the SQLite
  // version (which stored ISO text) — the frontend needs no change.
  function isoOrNull(v) {
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : String(v);
  }

  function rowToEntry(row, key) {
    const password = decryptField(row.encrypted_password, key);
    const notes    = decryptField(row.encrypted_notes, key);
    // decryptField returns null on auth-tag failure (wrong/rotated key) —
    // surface that instead of silently showing garbage.
    return {
      id: row.id,
      title: row.title,
      username: row.username,
      password: password === null ? null : password,
      notes: notes === null ? null : notes,
      url: row.url,
      created_at: isoOrNull(row.created_at),
      updated_at: isoOrNull(row.updated_at),
      undecryptable: password === null || notes === null,
    };
  }

  function validateEntry(body) {
    const { title, username = '', password = '', notes = '', url = '' } = body || {};
    if (typeof title !== 'string' || !title.trim()) return 'title required';
    if (title.length > 200) return 'title too long';
    if (typeof username !== 'string' || username.length > 200) return 'username too long';
    if (typeof password !== 'string' || password.length > 2000) return 'password too long';
    if (typeof notes !== 'string' || notes.length > 5000) return 'notes too long';
    if (typeof url !== 'string' || url.length > 500) return 'url too long';
    return null;
  }

  router.get('/', requireVaultKey, ah(async (req, res) => {
    // SQLite's "COLLATE NOCASE" has no PostgreSQL equivalent — LOWER() gives the
    // same case-insensitive ordering.
    const rows = await db.all(
      'SELECT * FROM vault_entries WHERE user_id = $1 ORDER BY LOWER(title)',
      [req.session.userId]
    );
    res.json(rows.map(r => rowToEntry(r, req.vaultKey)));
  }));

  router.post('/', requireCsrf, requireVaultKey, ah(async (req, res) => {
    const err = validateEntry(req.body);
    if (err) return res.status(400).json({ error: err });
    const { title, username = '', password = '', notes = '', url = '' } = req.body;
    const row = await db.one(
      `INSERT INTO vault_entries
         (user_id, title, username, encrypted_password, encrypted_notes, url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`,
      [
        req.session.userId, title.trim(), username.trim(),
        encryptField(password, req.vaultKey), encryptField(notes, req.vaultKey),
        url.trim(),
      ]
    );
    res.status(201).json(rowToEntry(row, req.vaultKey));
  }));

  router.put('/:id', requireCsrf, requireVaultKey, ah(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });

    const err = validateEntry(req.body);
    if (err) return res.status(400).json({ error: err });
    const { title, username = '', password = '', notes = '', url = '' } = req.body;

    // user_id stays in the WHERE clause, not just in the app logic — a user can
    // never even address another user's row, regardless of code path. RETURNING
    // makes the existence check and the update a single statement (no TOCTOU gap).
    const row = await db.one(
      `UPDATE vault_entries
         SET title = $1, username = $2, encrypted_password = $3,
             encrypted_notes = $4, url = $5, updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [
        title.trim(), username.trim(),
        encryptField(password, req.vaultKey), encryptField(notes, req.vaultKey),
        url.trim(), id, req.session.userId,
      ]
    );
    if (!row) return res.status(404).json({ error: 'Entry not found', code: 'ENTRY_NOT_FOUND' });
    res.json(rowToEntry(row, req.vaultKey));
  }));

  router.delete('/:id', requireCsrf, ah(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' });
    const r = await db.query(
      'DELETE FROM vault_entries WHERE id = $1 AND user_id = $2',
      [id, req.session.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Entry not found', code: 'ENTRY_NOT_FOUND' });
    res.sendStatus(204);
  }));

  return router;
};
