'use strict';

// Per-user vault encryption. The key is derived from the user's PLAINTEXT
// password at login time (PBKDF2 + a random per-user salt stored in
// users.vault_salt) and lives only in the server-side session (never in the
// DB, never sent to the client). A raw DB dump alone is therefore not enough
// to decrypt any vault entry — the attacker would also need an active
// session or a user's real password.
//
// Trade-off that comes with this design: changing a user's own password
// requires re-encrypting all of their vault entries with the new key (see
// routes/vault.js reencryptAll + the /api/change-password handler in
// server.js). An ADMIN-forced password reset cannot do this (the admin
// never has the old plaintext), so it intentionally wipes that user's vault
// instead of leaving permanently undecryptable rows behind.

const crypto = require('crypto');

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const KEY_LEN = 32; // AES-256
const IV_LEN  = 12; // recommended GCM nonce size

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function deriveVaultKey(password, saltHex) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

// Packed format: base64(iv).base64(authTag).base64(ciphertext)
function encryptField(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptField(packed, key) {
  if (!packed) return '';
  const parts = packed.split('.');
  if (parts.length !== 3) return '';
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv     = Buffer.from(ivB64, 'base64');
    const tag    = Buffer.from(tagB64, 'base64');
    const data   = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key (e.g. stale session after a password reset) or corrupted data.
    return null;
  }
}

module.exports = { newSalt, deriveVaultKey, encryptField, decryptField };
