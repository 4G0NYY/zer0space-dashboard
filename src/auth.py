"""Authentication hardening: sessions, rate limiting, lockout, CSRF, policy.

This is split out of ``main.py`` because it is the part that has to be correct
for the dashboard to survive being reachable from the internet without
Cloudflare Access in front of it.

Everything that counts attempts is backed by the ``login_attempts`` table rather
than by a process-local dict. That is the whole point of the table: with
in-memory counters, restarting the container reset every lockout, so an attacker
who could provoke a restart — or who simply waited for a deploy — got a clean
slate.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import anyio
import bcrypt
# Explicit submodule import: `import anyio` alone does not bind anyio.to_thread,
# and relying on some other library having imported it first is how this breaks
# on a dependency bump rather than in CI.
from anyio import to_thread
from itsdangerous import BadData, URLSafeTimedSerializer
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config, db

# --- Policy -----------------------------------------------------------------

BCRYPT_COST = 12

# bcrypt only hashes the first 72 BYTES of its input; anything past that is
# silently ignored, so a longer password is not actually stronger. The maximum
# is enforced to make that boundary explicit rather than surprising.
PASSWORD_MIN = 12
PASSWORD_MAX = 72


@dataclass(frozen=True)
class Limit:
    max: int
    window: float  # seconds
    block: float  # seconds


LIMITS = {
    # Per source IP: 10 failed logins in 15 min -> 30 min block.
    "ip": Limit(max=10, window=15 * 60, block=30 * 60),
    # Per username, across all IPs: 5 failed logins in 10 min -> 15 min block.
    # Tighter than the IP limit because a distributed guess against one account
    # is the attack the IP limit cannot see.
    "username": Limit(max=5, window=10 * 60, block=15 * 60),
    # Per source IP: 3 registration attempts an hour. Invalid invite codes count,
    # so the 128-bit code space cannot be searched from one address.
    "register": Limit(max=3, window=60 * 60, block=60 * 60),
    # Per username: 5 wrong 2FA codes in 5 min -> 5 min block. A 6-digit TOTP
    # code is only ~20 bits of entropy per guess (unlike a password), so this
    # window is intentionally tighter than the main login limit above.
    "2fa": Limit(max=5, window=5 * 60, block=5 * 60),
}

# Invitations one admin may mint per hour. Not a brute-force defence — an admin
# is already trusted — but a blast-radius limit: a hijacked admin session should
# not be able to produce an unbounded supply of working registration codes
# faster than anyone would notice.
INVITE_MAX_PER_HOUR = 20

# Consecutive failures before the account itself is locked. Independent of the
# sliding windows above: it survives an attacker pacing their attempts to stay
# under the rate limit.
LOCKOUT_THRESHOLD = 10

# The automatic lock expires on its own. A permanent lock releasable only by an
# admin reads as the safer option, but it is not: the admin username is
# guessable, so anyone able to reach /login could lock the only admin out for
# good, and with /setup sealed after first run there would be no way back in.
# An admin can still clear a lock early, can set the separate manual
# ``users.locked`` flag when they *do* want an indefinite lock, and
# scripts/unlock-user.py is the break-glass path if every admin is locked at once.
LOCKOUT_SECONDS = 30 * 60

# Floor for how long /api/login takes to answer. A miss on the username lookup
# would otherwise return in a millisecond while a real username spends a full
# bcrypt round, which tells an attacker which usernames exist.
LOGIN_MIN_SECONDS = 0.4

ATTEMPT_RETENTION_DAYS = 30


# --- Password hashing -------------------------------------------------------

# A real bcrypt hash to verify against when the username does not exist, so the
# no-such-user path costs the same as the wrong-password path. Generated once at
# import from a random value — it must never match a real password.
_DUMMY_HASH = bcrypt.hashpw(secrets.token_hex(32).encode(), bcrypt.gensalt(BCRYPT_COST))


def _hash_sync(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8")[:PASSWORD_MAX], bcrypt.gensalt(BCRYPT_COST)).decode()


def _verify_sync(password: str, hashed: str | None) -> bool:
    raw = password.encode("utf-8")[:PASSWORD_MAX]
    if not hashed:
        bcrypt.checkpw(raw, _DUMMY_HASH)
        return False
    try:
        return bcrypt.checkpw(raw, hashed.encode("utf-8"))
    except ValueError:
        # Malformed hash in the DB. Still burn a round so this does not become a
        # faster path than a real comparison.
        bcrypt.checkpw(raw, _DUMMY_HASH)
        return False


async def hash_password(password: str) -> str:
    """Always async: a cost-12 round takes ~250 ms and would block the loop."""
    return await to_thread.run_sync(_hash_sync, password)


async def verify_password(password: str, hashed: str | None) -> bool:
    return await to_thread.run_sync(_verify_sync, password, hashed)


# --- 2FA recovery codes ------------------------------------------------------
#
# 8 single-use codes generated once at 2FA setup and shown exactly once.
# bcrypt-hashed like a password (never plaintext, never reversible) but at a
# lower cost: they are high-entropy CSPRNG tokens rather than user-memorised
# secrets, and up to 8 of them must be scanned per verification attempt.
RECOVERY_CODE_COST = 10
RECOVERY_CODE_COUNT = 8


def _generate_recovery_codes_sync() -> list[str]:
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = secrets.token_hex(5).upper()  # 10 hex chars
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def generate_recovery_codes() -> list[str]:
    return _generate_recovery_codes_sync()


def _hash_recovery_code_sync(code: str) -> str:
    return bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt(RECOVERY_CODE_COST)).decode()


async def hash_recovery_code(code: str) -> str:
    return await to_thread.run_sync(_hash_recovery_code_sync, code)


def _verify_recovery_code_sync(code: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(code.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


async def verify_recovery_code(code: str, hashed: str) -> bool:
    return await to_thread.run_sync(_verify_recovery_code_sync, code, hashed)


def normalize_recovery_code(code: str) -> str:
    return code.strip().upper()


async def store_recovery_codes(user_id: int, codes: list[str]) -> None:
    """Replaces every recovery code for this user with a freshly generated set."""
    async with db.transaction() as con:
        await con.execute("DELETE FROM recovery_codes WHERE user_id = $1", user_id)
        for code in codes:
            await con.execute(
                "INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)",
                user_id,
                await hash_recovery_code(code),
            )


async def consume_recovery_code(user_id: int, code: str) -> bool:
    """Marks one matching, unused recovery code as used. Returns whether one matched.

    Each code is bcrypt-hashed with its own salt, so lookup cannot be indexed —
    at most 8 unused rows per user, so a linear scan is cheap enough. The
    ``UPDATE ... WHERE used_at IS NULL`` makes "mark used" atomic: two parallel
    requests racing the same code cannot both consume it.
    """
    normalized = normalize_recovery_code(code)
    rows = await db.fetch(
        "SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL", user_id
    )
    for row in rows:
        if await verify_recovery_code(normalized, row["code_hash"]):
            result = await db.execute(
                "UPDATE recovery_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL", row["id"]
            )
            return not result.endswith(" 0")
    return False


async def pad_timing(started_at: float, minimum: float = LOGIN_MIN_SECONDS) -> None:
    """Hold the response until at least ``minimum`` has passed since the start."""
    elapsed = time.monotonic() - started_at
    if elapsed < minimum:
        await anyio.sleep(minimum - elapsed)


# --- Client IP --------------------------------------------------------------


def client_ip(request: Request) -> str:
    """The address per-IP limits are counted against.

    Behind the Cloudflare Tunnel every request arrives from the tunnel
    container, so the socket address is useless here. ``cf-connecting-ip`` is set
    by Cloudflare and is the value to trust when TRUST_PROXY is on; without that
    guard a single spoofed header would let an attacker dodge every per-IP limit.
    """
    if config.TRUST_PROXY:
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()[:100]
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()[:100]
    return (request.client.host if request.client else "unknown")[:100]


# --- Attempt log ------------------------------------------------------------


async def record_attempt(*, username: str = "", ip: str = "", success: bool = False, kind: str = "login") -> None:
    """Never called with a password, in any form. The columns cannot hold one."""
    await db.execute(
        "INSERT INTO login_attempts (username, ip, success, kind) VALUES ($1, $2, $3, $4)",
        (username or "")[:200].lower(),
        ip,
        success,
        kind,
    )


# A column name cannot be a bind parameter, so it is interpolated below — and is
# therefore restricted to this allowlist. Both call sites pass a literal today;
# the allowlist is what keeps that safe if a future one passes something derived
# from a request.
_COUNTABLE_COLUMNS = {"ip", "username"}


async def _is_blocked(column: str, value: str, limit: Limit, kind: str = "login") -> float | None:
    """Seconds remaining on a block, or ``None``.

    Reads the timestamps of the last ``limit.max`` failures. If that many fit
    inside ``limit.window``, the limit tripped and the block runs for
    ``limit.block`` from the most recent one. Attempts rejected *because* of a
    block are deliberately not logged by the callers, so a blocked client cannot
    extend its own block indefinitely by continuing to hammer the endpoint.
    """
    if column not in _COUNTABLE_COLUMNS:
        raise ValueError(f"illegal rate-limit column {column!r}")

    rows = await db.fetch(
        f"""SELECT created_at FROM login_attempts
             WHERE {column} = $1 AND success = FALSE AND kind = $2
             ORDER BY created_at DESC LIMIT $3""",
        value,
        kind,
        limit.max,
    )
    if len(rows) < limit.max:
        return None

    newest = rows[0]["created_at"].timestamp()
    oldest = rows[-1]["created_at"].timestamp()
    if newest - oldest > limit.window:
        return None

    remaining = (newest + limit.block) - time.time()
    return remaining if remaining > 0 else None


async def check_login_rate_limit(ip: str, username: str) -> float | None:
    by_ip = await _is_blocked("ip", ip, LIMITS["ip"])
    if by_ip:
        return by_ip
    return await _is_blocked("username", (username or "").lower(), LIMITS["username"])


async def check_register_rate_limit(ip: str) -> float | None:
    return await _is_blocked("ip", ip, LIMITS["register"], kind="register")


async def check_2fa_rate_limit(username: str) -> float | None:
    return await _is_blocked("username", (username or "").lower(), LIMITS["2fa"], kind="2fa")


async def check_invite_quota(user_id: int) -> int | None:
    """Counted against ``invite_codes`` itself rather than the attempt log.

    What matters is how many live codes one admin has produced, which is a
    property of the invites table, not of a request counter.
    """
    made = await db.fetchval(
        """SELECT COUNT(*)::int FROM invite_codes
            WHERE created_by = $1 AND created_at > NOW() - INTERVAL '1 hour'""",
        user_id,
    )
    return made if (made or 0) >= INVITE_MAX_PER_HOUR else None


# --- Account lockout --------------------------------------------------------


def is_locked(user: Any | None) -> bool:
    if not user:
        return False
    if user["locked"]:
        return True  # manual, admin-set — does not expire
    locked_until = user["locked_until"]
    return bool(locked_until and locked_until.timestamp() > time.time())


def lock_remaining_seconds(user: Any) -> float | None:
    if user["locked"]:
        return None  # indefinite
    locked_until = user["locked_until"]
    if not locked_until:
        return None
    return max(0.0, locked_until.timestamp() - time.time())


async def register_failed_login(user: Any | None) -> None:
    if not user:
        return
    nxt = (user["failed_attempts"] or 0) + 1
    if nxt >= LOCKOUT_THRESHOLD:
        await db.execute(
            """UPDATE users SET failed_attempts = $1,
                   locked_until = NOW() + ($2 || ' seconds')::interval
                WHERE id = $3""",
            nxt,
            str(int(LOCKOUT_SECONDS)),
            user["id"],
        )
    else:
        await db.execute("UPDATE users SET failed_attempts = $1 WHERE id = $2", nxt, user["id"])


async def clear_failed_logins(user_id: int) -> None:
    await db.execute(
        "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", user_id
    )


# --- Input policy -----------------------------------------------------------
#
# Returns None when acceptable, otherwise a stable error code. Server-side
# messages are never translated on the server — the client resolves the code
# through static/js/i18n.js, so a new code needs a matching err.* key in BOTH
# dictionaries.


def password_problem(password: Any) -> str | None:
    if not isinstance(password, str) or not password:
        return "PW_MISSING"
    if len(password) < PASSWORD_MIN:
        return "PW_TOO_SHORT"
    if len(password.encode("utf-8")) > PASSWORD_MAX:
        return "PW_TOO_LONG"
    return None


def username_problem(username: Any) -> str | None:
    if not isinstance(username, str) or not username.strip():
        return "USERNAME_MISSING"
    candidate = username.strip()
    if not (3 <= len(candidate) <= 32):
        return "USERNAME_INVALID"
    if not all(c.isascii() and (c.isalnum() or c in "._-") for c in candidate):
        return "USERNAME_INVALID"
    return None


INVITE_CODE_LENGTH = 32


def new_invite_code() -> str:
    """32 hex characters = 128 bits of entropy from the OS CSPRNG."""
    return secrets.token_hex(INVITE_CODE_LENGTH // 2)


def looks_like_invite_code(code: Any) -> bool:
    return (
        isinstance(code, str)
        and len(code) == INVITE_CODE_LENGTH
        and all(c in "0123456789abcdef" for c in code)
    )


# --- Housekeeping -----------------------------------------------------------


async def prune_login_attempts() -> None:
    """The attempt log is append-only and would otherwise grow without bound."""
    result = await db.execute(
        f"DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '{ATTEMPT_RETENTION_DAYS} days'"
    )
    # asyncpg returns the command tag, e.g. "DELETE 12".
    count = result.rsplit(" ", 1)[-1] if result else "0"
    if count not in ("0", ""):
        print(f"[auth] pruned {count} login attempt(s) older than {ATTEMPT_RETENTION_DAYS} days")


# --- Sessions ---------------------------------------------------------------
#
# The session store is deliberately IN-MEMORY and server-side, and the cookie
# carries nothing but a signed session id.
#
# Starlette's built-in SessionMiddleware serialises the whole session INTO the
# cookie. That is disqualifying here: the session holds the user's derived vault
# key, and putting that key in a cookie hands it to the browser (and to anyone
# who can read the browser's storage), which breaks the entire vault threat
# model. A database-backed store would write it to PostgreSQL, breaking the same
# model from the other side.
#
# The consequence is accepted and load-bearing: sessions are per-process, so the
# dashboard must stay at replicas: 1 and a restart signs everyone out.


@dataclass
class Session:
    sid: str
    data: dict[str, Any] = field(default_factory=dict)
    expires_at: float = 0.0

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.data[key] = value

    def pop(self, key: str, default: Any = None) -> Any:
        return self.data.pop(key, default)


class SessionStore:
    def __init__(self, max_age: int) -> None:
        self._sessions: dict[str, Session] = {}
        self.max_age = max_age

    def create(self) -> Session:
        sid = secrets.token_urlsafe(32)
        session = Session(sid=sid, expires_at=time.time() + self.max_age)
        self._sessions[sid] = session
        return session

    def get(self, sid: str | None) -> Session | None:
        if not sid:
            return None
        session = self._sessions.get(sid)
        if session is None:
            return None
        if session.expires_at <= time.time():
            self._sessions.pop(sid, None)
            return None
        return session

    def regenerate(self, session: Session) -> Session:
        """New session id, same contents.

        Session fixation: an attacker who can set a session cookie before login
        would otherwise still hold a valid one after it.
        """
        self._sessions.pop(session.sid, None)
        fresh = self.create()
        fresh.data = session.data
        return fresh

    def destroy(self, sid: str) -> None:
        self._sessions.pop(sid, None)

    def sweep(self) -> int:
        now = time.time()
        dead = [sid for sid, s in self._sessions.items() if s.expires_at <= now]
        for sid in dead:
            self._sessions.pop(sid, None)
        return len(dead)

    def __len__(self) -> int:
        return len(self._sessions)


class SecretHolder:
    """A late-bound session secret.

    The middleware stack is frozen the first time the app is called, which is
    before the lifespan handler runs — so the secret, which may have to be read
    out of PostgreSQL, cannot be passed in at construction time. The holder is
    installed at import and filled during startup instead.
    """

    def __init__(self, value: str | None = None) -> None:
        self.value = value

    def require(self) -> str:
        if not self.value:
            raise RuntimeError("session secret not initialised")
        return self.value


class SessionMiddleware:
    """Attaches ``request.state.session`` and manages the signed sid cookie."""

    def __init__(self, app: ASGIApp, store: SessionStore, secret: SecretHolder) -> None:
        self.app = app
        self.store = store
        self.secret = secret
        self._cached_for: str | None = None
        self._serializer: URLSafeTimedSerializer | None = None

    @property
    def serializer(self) -> URLSafeTimedSerializer:
        current = self.secret.require()
        if self._serializer is None or self._cached_for != current:
            self._serializer = URLSafeTimedSerializer(current, salt="zs.session")
            self._cached_for = current
        return self._serializer

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Not every ASGI server populates scope["state"]; Request.state and the
        # send wrapper below both need it to exist.
        scope.setdefault("state", {})

        request = Request(scope)
        raw = request.cookies.get(config.SESSION_COOKIE)
        sid: str | None = None
        if raw:
            try:
                sid = self.serializer.loads(raw, max_age=self.store.max_age)
            except BadData:
                # BadData, not BadSignature: a *tampered* cookie fails signature
                # verification, but a merely malformed one raises BadPayload,
                # which is a sibling. Catching only the former turns a garbage
                # cookie into a 500 on every request until the user clears it.
                sid = None

        session = self.store.get(sid)
        scope["state"]["session"] = session
        scope["state"]["session_store"] = self.store
        scope["state"]["session_changed"] = False

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                current: Session | None = scope["state"].get("session")
                cleared = scope["state"].get("session_cleared", False)
                if cleared:
                    self._set_cookie(message, "", max_age=0)
                elif current is not None and (current.sid != sid or scope["state"].get("session_changed")):
                    self._set_cookie(
                        message,
                        self.serializer.dumps(current.sid),
                        max_age=self.store.max_age,
                    )
            await send(message)

        await self.app(scope, receive, send_wrapper)

    def _set_cookie(self, message: Message, value: str, *, max_age: int) -> None:
        response = Response()
        response.set_cookie(
            config.SESSION_COOKIE,
            value,
            max_age=max_age,
            path="/",
            httponly=True,
            # 'strict' rather than 'lax': the dashboard is never legitimately
            # entered by a cross-site navigation, and strict is what covers the
            # three unauthenticated POST endpoints that cannot carry a CSRF token.
            samesite="strict",
            secure=config.COOKIE_SECURE,
        )
        headers = message.setdefault("headers", [])
        for key, val in response.raw_headers:
            if key.lower() == b"set-cookie":
                headers.append((key, val))


# --- CSRF -------------------------------------------------------------------
#
# Double-submit: the token lives in the server-side session and must be echoed
# in the X-CSRF-Token header. It is never put in a cookie, so a cross-site
# request cannot read it.
#
# The three unauthenticated entry points (/api/login, /api/setup, /api/register)
# are exempt because there is no session to hold a token yet, and minting one for
# every anonymous visitor would let an unauthenticated client fill the in-memory
# session store. They are covered instead by samesite='strict' plus their own
# rate limits above.

CSRF_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def issue_csrf_token(session: Session) -> str:
    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_hex(32)
    return session["csrf_token"]


def csrf_ok(session: Session | None, sent: str | None) -> bool:
    expected = session.get("csrf_token") if session else None
    if not sent or not expected:
        return False
    # compare_digest on fixed-size digests: the raw strings can differ in length,
    # which leaks through a naive comparison and raises in some implementations.
    return hmac.compare_digest(
        hashlib.sha256(sent.encode()).digest(), hashlib.sha256(expected.encode()).digest()
    )
