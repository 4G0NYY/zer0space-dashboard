"""SSO broker: a real Crimson identity per zer0space user, with no login screen.

Crimson Haven's account auth (account_engine) is challenge/signature based: the
client holds an Ed25519 key, the server stores only the public key and verifies a
signature over a one-time challenge. The mnemonic/BIP39 dance in the upstream
client is just *one* way to derive that key — the server never sees it — so the
dashboard can derive the key deterministically instead:

    seed32  = HMAC-SHA256(CRIMSON_SSO_SECRET, "crimson-sso:<zer0space user id>")
    key     = Ed25519 from seed32           # public key == @noble/ed25519 getPublicKey

The same zer0space user always derives the same Crimson account, so favorites and
progress follow them across devices. This module hands the /crimson/api proxy a
valid Crimson **Bearer** for the current user, registering the account on first
sign-in and logging in thereafter, with the token cached until shortly before it
expires.

Wire format (crimson-backend account_engine/routes.py):
    POST /auth/challenge {public_key}                     -> {challenge}
    POST /auth/login     {public_key, challenge, signature}                -> {session_token, expires_at}
    POST /auth/register  {public_key, challenge, signature, invite_code}   -> {session_token, expires_at}
public_key = 64 hex chars, signature = 128 hex chars over challenge.encode("utf-8").
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
from datetime import datetime

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import config, crimson

# user_id -> (bearer, expiry_epoch). In-process, like the session store; a restart
# just re-logs in, which is cheap and rare.
_tokens: dict[str, tuple[str, float]] = {}
# One lock per user so concurrent requests don't each register/login.
_locks: dict[str, asyncio.Lock] = {}
# Refresh a little before the server expiry to avoid racing a 401 mid-request.
_REFRESH_MARGIN = 120.0
_FALLBACK_TTL = 1800.0


def _seed(user_id: str) -> bytes:
    return hmac.new(
        config.CRIMSON_SSO_SECRET.encode("utf-8"),
        f"crimson-sso:{user_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()


def _keypair(user_id: str) -> tuple[Ed25519PrivateKey, str]:
    priv = Ed25519PrivateKey.from_private_bytes(_seed(user_id))
    pub_hex = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    ).hex()
    return priv, pub_hex


def _parse_expiry(value: object) -> float:
    """Best-effort: accept an epoch number or an ISO-8601 string; else a default."""
    now = time.time()
    if isinstance(value, (int, float)):
        return float(value) if value > now else now + _FALLBACK_TTL
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return max(dt.timestamp(), now + 60)
        except ValueError:
            pass
    return now + _FALLBACK_TTL


async def _challenge(pub_hex: str) -> str:
    r = await crimson.client().post(
        f"{config.CRIMSON_API_URL}/auth/challenge", json={"public_key": pub_hex}
    )
    r.raise_for_status()
    return r.json()["challenge"]


def _sign(priv: Ed25519PrivateKey, challenge: str) -> str:
    return priv.sign(challenge.encode("utf-8")).hex()


async def _authenticate(user_id: str) -> tuple[str, float]:
    """Log in (registering on first use) and return (bearer, expiry_epoch)."""
    priv, pub_hex = _keypair(user_id)

    async def _post(path: str, extra: dict) -> "object":
        ch = await _challenge(pub_hex)
        body = {"public_key": pub_hex, "challenge": ch, "signature": _sign(priv, ch), **extra}
        return await crimson.client().post(f"{config.CRIMSON_API_URL}{path}", json=body)

    r = await _post("/auth/login", {})
    if r.status_code != 200:
        # No account yet — create it (invite-gated), then it is logged in.
        reg = await _post(
            "/auth/register",
            {"invite_code": config.CRIMSON_SSO_INVITE_CODE, "label": "zer0space"},
        )
        if reg.status_code == 409:
            # Created concurrently between our login and register — log in instead.
            reg = await _post("/auth/login", {})
        reg.raise_for_status()
        r = reg
    data = r.json()
    return data["session_token"], _parse_expiry(data.get("expires_at"))


async def token(user_id: str) -> str:
    """A valid Crimson Bearer for this zer0space user, minting/refreshing as needed."""
    cached = _tokens.get(user_id)
    if cached and cached[1] - _REFRESH_MARGIN > time.time():
        return cached[0]
    lock = _locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        # Re-check inside the lock: another request may have just refreshed it.
        cached = _tokens.get(user_id)
        if cached and cached[1] - _REFRESH_MARGIN > time.time():
            return cached[0]
        bearer, expiry = await _authenticate(user_id)
        _tokens[user_id] = (bearer, expiry)
        return bearer


def invalidate(user_id: str) -> None:
    """Drop a cached token (e.g. after the upstream rejected it), forcing a re-login."""
    _tokens.pop(user_id, None)
