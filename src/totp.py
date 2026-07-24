"""TOTP (RFC 6238) two-factor authentication.

Optional, per user. A secret is generated at ``/api/2fa/setup``, held only in
the session until ``/api/2fa/verify`` proves the user actually scanned it, and
only then written to ``users.totp_secret`` — AES-256-GCM encrypted at rest with
a server-wide key (:func:`resolve_key`, resolved in ``auth.py`` the same way as
the session secret), not the per-user vault key. That separation is deliberate:
verifying a 2FA code — or an admin resetting one — must work without the user's
plaintext password in hand, which is the one thing the vault key is derived
from.

The setup QR is rendered here, server-side, as a PNG data URI (``qrcode`` +
``Pillow``) rather than client-side — this project has a real Python backend,
unlike the abandoned Node.js prototype this dashboard briefly had, so there is
no reason to vendor a JS QR library when the standard library for the job is
one ``pip install`` away.
"""

from __future__ import annotations

import base64
import io

import pyotp
import qrcode

ISSUER = "zer0space Dashboard"


def generate_secret() -> str:
    """32 base32 characters = 160 bits, pyotp's own default length."""
    return pyotp.random_base32()


def current_code(secret: str) -> str:
    """Only used by tests/tooling — the app itself never needs its own code."""
    return pyotp.TOTP(secret).now()


def verify_code(secret: str, code: str, *, valid_window: int = 1) -> bool:
    """``valid_window=1`` accepts the previous and next 30s step too, covering
    ordinary clock drift between the server and the user's phone."""
    if not isinstance(code, str) or not code.strip():
        return False
    try:
        return pyotp.TOTP(secret).verify(code.strip(), valid_window=valid_window)
    except Exception:  # noqa: BLE001 — a malformed code is simply "not valid"
        return False


def provisioning_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=ISSUER)


def qr_data_uri(otpauth_uri: str) -> str:
    """A scannable QR as a ``data:image/png;base64,...`` URI.

    Rendered once, in the ``/api/2fa/setup`` response, and never persisted or
    made retrievable again — the only copy that ever exists is what the user's
    authenticator app captures in that one scan.
    """
    img = qrcode.make(otpauth_uri, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
