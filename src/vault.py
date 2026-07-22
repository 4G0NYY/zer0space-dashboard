"""Per-user encrypted credential storage.

The vault key is derived from the user's **plaintext** password at login
(PBKDF2-HMAC-SHA256, 600 000 iterations, per-user salt in ``users.vault_salt``)
and lives **only in the server-side session** — never in the database, never
sent to the client. A stolen database dump alone is therefore not enough to
decrypt anything; the attacker would also need an active session or the user's
real password.

Two consequences follow from that and are easy to break by accident:

* A user changing their own password must **re-encrypt** all their entries with
  the new key (:func:`reencrypt_all`, called from ``/api/change-password``).
* An admin-forced password reset **cannot** re-encrypt — the admin never has the
  old plaintext — so it deliberately wipes that user's vault instead of leaving
  rows behind that can never be decrypted. That is intentional, not a bug.

**Wire format is unchanged from the Node.js implementation**: PBKDF2 with the
same parameters and ``base64(iv).base64(tag).base64(ciphertext)`` packing, so
entries written by the old dashboard decrypt here without a migration.
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any

# Explicit submodule import: `import anyio` alone does not bind anyio.to_thread.
from anyio import to_thread
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PBKDF2_ITERATIONS = 600_000  # OWASP guidance for PBKDF2-HMAC-SHA256
KEY_LEN = 32  # AES-256
IV_LEN = 12  # recommended GCM nonce size
TAG_LEN = 16


def new_salt() -> str:
    return os.urandom(16).hex()


def _derive_sync(password: str, salt_hex: str) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ITERATIONS, KEY_LEN
    )


async def derive_vault_key(password: str, salt_hex: str) -> bytes:
    """600k PBKDF2 rounds take ~0.3 s — run them off the event loop.

    Doing this inline would stall every other in-flight request for the duration
    of a login, which on a single-worker ASGI server is a denial of service that
    anyone can trigger by holding the sign-in button down.
    """
    return await to_thread.run_sync(_derive_sync, password, salt_hex)


def encrypt_field(plaintext: str | None, key: bytes) -> str:
    """Pack as ``base64(iv).base64(tag).base64(ciphertext)``.

    ``cryptography`` appends the GCM tag to the ciphertext; it is split back out
    here so the stored format stays byte-identical to what Node's
    ``createCipheriv`` + ``getAuthTag`` produced.
    """
    iv = os.urandom(IV_LEN)
    blob = AESGCM(key).encrypt(iv, (plaintext or "").encode("utf-8"), None)
    ciphertext, tag = blob[:-TAG_LEN], blob[-TAG_LEN:]
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"{b64(iv)}.{b64(tag)}.{b64(ciphertext)}"


def decrypt_field(packed: str | None, key: bytes) -> str | None:
    """Returns the plaintext, ``''`` for an empty field, or ``None`` on failure.

    ``None`` specifically means the authentication tag did not verify — a wrong
    or rotated key, or tampered data. Callers surface that as ``undecryptable``
    rather than silently showing garbage.
    """
    if not packed:
        return ""
    parts = packed.split(".")
    if len(parts) != 3:
        return ""
    try:
        iv, tag, ciphertext = (base64.b64decode(p) for p in parts)
        return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8")
    except Exception:  # noqa: BLE001 — any failure here means "cannot decrypt"
        return None


# --- Row mapping ------------------------------------------------------------


def row_to_entry(row: Any, key: bytes) -> dict[str, Any]:
    password = decrypt_field(row["encrypted_password"], key)
    notes = decrypt_field(row["encrypted_notes"], key)
    return {
        "id": row["id"],
        "title": row["title"],
        "username": row["username"],
        "password": password,
        "notes": notes,
        "url": row["url"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "undecryptable": password is None or notes is None,
    }


def validate_entry(body: dict[str, Any]) -> str | None:
    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        return "VAULT_TITLE_REQUIRED"
    if len(title) > 200:
        return "VAULT_TITLE_TOO_LONG"
    for field, limit, code in (
        ("username", 200, "VAULT_USERNAME_TOO_LONG"),
        ("password", 2000, "VAULT_PASSWORD_TOO_LONG"),
        ("notes", 5000, "VAULT_NOTES_TOO_LONG"),
        ("url", 500, "VAULT_URL_TOO_LONG"),
    ):
        value = body.get(field, "")
        if not isinstance(value, str) or len(value) > limit:
            return code
    return None


async def reencrypt_all(con: Any, user_id: int, old_key: bytes, new_key: bytes) -> int:
    """Re-encrypt every entry of one user, inside the caller's transaction.

    The re-encryption and the password/salt update must commit together: a crash
    between them would leave entries encrypted with the old key while the salt
    already points at the new one, which is permanently undecryptable.
    """
    rows = await con.fetch("SELECT * FROM vault_entries WHERE user_id = $1", user_id)
    touched = 0
    for row in rows:
        password = decrypt_field(row["encrypted_password"], old_key)
        notes = decrypt_field(row["encrypted_notes"], old_key)
        # None here would mean the OLD key was already wrong — it should not
        # happen (it just unlocked the vault at login). Skip defensively rather
        # than encrypting garbage over recoverable data.
        if password is None or notes is None:
            continue
        await con.execute(
            """UPDATE vault_entries SET encrypted_password = $1, encrypted_notes = $2
                WHERE id = $3 AND user_id = $4""",
            encrypt_field(password, new_key),
            encrypt_field(notes, new_key),
            row["id"],
            user_id,
        )
        touched += 1
    return touched
