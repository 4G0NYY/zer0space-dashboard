"""FastAPI application: routes, middleware, startup.

Layout of this file, top to bottom:

1. helpers (error shape, JSON body parsing, auth guards)
2. middleware (security headers, sessions, CSRF)
3. public pages and the three unauthenticated POST endpoints
4. the authenticated API
5. admin-only routes
6. startup / lifespan

Two boundaries in here are load-bearing and worth being deliberate about when
adding a route:

* ``_require_session`` / ``_require_admin`` — a new endpoint is public unless it
  depends on one of them. There is no blanket "everything under /api is
  protected" rule, because /api/login, /api/setup and /api/register must not be.
* ``CsrfMiddleware`` — covers every state-changing request that carries a
  session. The three exempt endpoints are exempt because they run before a
  session exists; they are covered by ``samesite=strict`` and their rate limits.

Error responses always carry a stable ``code`` alongside the English ``error``
text. The client resolves the code through ``static/js/i18n.js`` into German or
English; an unknown code falls back to the English text, so a missed
translation degrades gracefully instead of rendering blank.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import ai, auth, config, crimson, crimson_sso, db, metrics, totp, vault

# Bump when static assets change in a way browsers must not keep. Templates
# append it to every CSS/JS URL, which is what makes it safe to serve them with
# a long max-age despite there being no build step and no content hashes.
ASSET_VERSION = "4.3.1"

# Ceiling on a buffered request body. The API only ever receives small JSON
# objects — the largest legitimate one is a vault entry, capped by
# vault.validate_entry at a few kB — so 512 kB is generous. The Crimson gateway
# forwards for a third-party API and gets its own, looser limit.
MAX_BODY_BYTES = 512 * 1024
MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024

templates = Jinja2Templates(directory=str(config.TEMPLATES_DIR))
session_store = auth.SessionStore(max_age=config.SESSION_MAX_AGE)
# Filled during startup — see resolve_session_secret() and auth.SecretHolder.
session_secret = auth.SecretHolder()
# Encrypts users.totp_secret at rest — filled during startup, see
# resolve_totp_key() below. A plain module global rather than a SecretHolder:
# unlike the session secret, nothing needs it before the lifespan handler runs.
totp_key: bytes = b""


# --- Helpers ----------------------------------------------------------------


def fail(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, "code": code, **extra}, status_code=status)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.response = fail(status, code, message, **extra)


async def json_body(request: Request) -> dict[str, Any]:
    """Parse a JSON object body, or raise a clean 400.

    Anything that is not a JSON object is rejected here rather than causing an
    AttributeError three lines into a handler.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise ApiError(400, "BAD_JSON", "Request body must be JSON") from None
    if not isinstance(body, dict):
        raise ApiError(400, "BAD_JSON", "Request body must be a JSON object")
    return body


def get_session(request: Request) -> auth.Session | None:
    return request.scope.get("state", {}).get("session")


def _require_session(request: Request) -> auth.Session:
    session = get_session(request)
    if not session or not session.get("user_id"):
        raise ApiError(401, "UNAUTHORIZED", "Not signed in")
    return session


def _require_admin(request: Request) -> auth.Session:
    session = _require_session(request)
    if session.get("role") != "admin":
        raise ApiError(403, "FORBIDDEN_ADMIN", "Not permitted (admin required)")
    return session


def _require_db() -> None:
    if not db.is_ready():
        raise ApiError(503, "DB_UNAVAILABLE", "Database unavailable — please try again later")


def _path_id(raw: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_ID", "Invalid id") from None
    if value < 1:
        raise ApiError(400, "INVALID_ID", "Invalid id")
    return value


async def no_users_yet() -> bool:
    """Is the users table still empty?

    Deliberately NOT cached: /setup must seal itself the instant the first
    account exists, and a cached ``True`` would keep the wizard open until the
    next restart.
    """
    return (await db.fetchval("SELECT COUNT(*)::int FROM users")) == 0


def page(request: Request, name: str, **context: Any) -> Response:
    return templates.TemplateResponse(
        request=request,
        name=name,
        context={
            "asset_version": ASSET_VERSION,
            "github_url": config.GITHUB_URL,
            "status_url": config.STATUS_URL,
            # Show the Crimson entry in the sidebar only when the gateway is wired.
            "crimson_enabled": config.CRIMSON_ENABLED,
            # Show the AI chat panel only when the gateway is wired. The panel is
            # useless without it, and an empty view is worse than no view.
            "ai_enabled": config.AI_ENABLED,
            **context,
        },
    )


# --- Middleware -------------------------------------------------------------


class SecurityHeadersMiddleware:
    """CSP and friends.

    ``script-src`` has no ``'unsafe-inline'`` — injected inline scripts are
    blocked on purpose, which is why every bit of JavaScript in this project
    lives in a file under ``static/js/``. ``style-src`` does allow inline styles
    because metric bar widths are set as inline ``style`` attributes.

    HSTS is only sent when FORCE_HTTPS is on. Once a browser stores an HSTS
    entry it upgrades every later request to https://, which breaks the plain
    HTTP LAN access on http://node:8080 until the entry expires.
    """

    def __init__(self, app: Any) -> None:
        self.app = app
        directives = [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self'",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
        ]
        if config.FORCE_HTTPS:
            directives.append("upgrade-insecure-requests")
        self.headers: list[tuple[bytes, bytes]] = [
            (b"content-security-policy", "; ".join(directives).encode()),
            (b"x-content-type-options", b"nosniff"),
            (b"x-frame-options", b"DENY"),
            (b"referrer-policy", b"same-origin"),
            (b"cross-origin-opener-policy", b"same-origin"),
            (b"permissions-policy", b"geolocation=(), microphone=(), camera=(), interest-cohort=()"),
        ]
        if config.FORCE_HTTPS:
            self.headers.append(
                (b"strict-transport-security", b"max-age=31536000; includeSubDomains")
            )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # /api/* answers routinely carry decrypted vault entries, TOTP
        # provisioning URIs and recovery codes. Without this they are eligible
        # for the browser's on-disk cache, which leaves plaintext passwords in a
        # file that outlives the session and survives signing out.
        is_api = scope.get("path", "").startswith("/api/")

        async def send_wrapper(message: Any) -> None:
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                existing = {k.lower() for k, _ in headers}
                for key, value in self.headers:
                    if key not in existing:
                        headers.append((key, value))
                if is_api and b"cache-control" not in existing:
                    headers.append((b"cache-control", b"no-store, private"))
            await send(message)

        await self.app(scope, receive, send_wrapper)


class BodyLimitMiddleware:
    """Reject oversized request bodies before anything buffers them.

    ``json_body`` and the Crimson proxy both read the whole body into memory,
    and neither Starlette nor uvicorn caps it. /api/login is unauthenticated and
    reaches that path, so without a limit any anonymous client can make the
    process buffer an arbitrarily large body. The service runs at replicas: 1
    because the session store is in-process, so there is no second instance to
    absorb it and a kill signs everyone out.

    Content-Length is checked first because it is free. A chunked body carries no
    length, so the receive channel is metered as it streams and the request is cut
    off the moment it crosses the cap.
    """

    def __init__(self, app: Any, max_bytes: int, proxy_max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.proxy_max_bytes = proxy_max_bytes

    def _limit_for(self, path: str) -> int:
        # The Crimson gateway forwards uploads and POST bodies for a third-party
        # API, so it gets its own, looser ceiling rather than the API's.
        if path == config.CRIMSON_PATH or path.startswith(config.CRIMSON_PATH + "/"):
            return self.proxy_max_bytes
        return self.max_bytes

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or scope.get("method") in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return

        limit = self._limit_for(scope.get("path", "/"))
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > limit:
                    await self._too_large(scope, receive, send)
                    return
            except ValueError:
                await self._too_large(scope, receive, send)
                return

        seen = 0

        async def metered_receive() -> Any:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    # Signalling disconnect stops the body generator rather than
                    # letting the handler keep pulling an unbounded stream.
                    return {"type": "http.disconnect"}
            return message

        await self.app(scope, metered_receive, send)

    async def _too_large(self, scope: Any, receive: Any, send: Any) -> None:
        response = fail(413, "BODY_TOO_LARGE", "Request body too large")
        await response(scope, receive, send)


class CsrfMiddleware:
    """Double-submit CSRF check on every state-changing request."""

    EXEMPT = {"/api/login", "/api/setup", "/api/register"}

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        path = request.url.path
        # The /crimson gateway is exempt from the dashboard's double-submit CSRF:
        # the Crimson SPA authenticates to its backend by its own scheme and has
        # no zer0space CSRF token to echo. Cross-site POSTs are still blocked the
        # same way the login endpoints are — the session cookie is samesite=strict.
        is_crimson = path == config.CRIMSON_PATH or path.startswith(config.CRIMSON_PATH + "/")
        if (
            request.method not in auth.CSRF_SAFE_METHODS
            and path not in self.EXEMPT
            and not is_crimson
        ):
            session = scope.get("state", {}).get("session")
            if not auth.csrf_ok(session, request.headers.get("x-csrf-token")):
                response = fail(403, "CSRF_INVALID", "CSRF token invalid or missing")
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


class MaintenanceMiddleware:
    """Serve the maintenance page for everything but health checks and assets.

    An environment flag rather than a database setting on purpose: the situation
    you need this for is "the database is unreachable".
    """

    ALLOWED_PREFIXES = ("/static/", "/healthz", "/favicon")

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not config.MAINTENANCE_MODE:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "/")
        if path.startswith(self.ALLOWED_PREFIXES):
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        response = page(request, "maintenance.html")
        response.status_code = 503
        response.headers["retry-after"] = "300"
        await response(scope, receive, send)


# --- Lifespan ---------------------------------------------------------------


async def resolve_session_secret() -> str:
    """Docker secret -> env var -> value in the DB -> freshly generated and stored.

    Storing it in ``settings`` is what makes sessions survive a restart on a
    deployment that never configured a secret. If PostgreSQL is unreachable we
    fall back to an ephemeral value so the process can still boot; that is logged
    loudly rather than crashing.
    """
    from_secret = config.SESSION_SECRET
    if from_secret:
        return from_secret

    row = await db.fetchrow("SELECT value FROM settings WHERE key = 'session_secret'")
    if row:
        return row["value"]

    generated = secrets.token_hex(32)
    # ON CONFLICT guards the race where two instances start at the same moment:
    # the loser keeps the winner's value instead of overwriting it.
    stored = await db.fetchval(
        """INSERT INTO settings (key, value) VALUES ('session_secret', $1)
            ON CONFLICT (key) DO UPDATE SET value = settings.value
            RETURNING value""",
        generated,
    )
    print("[dashboard] auto-generated SESSION_SECRET stored in DB (persistent across restarts)")
    return stored


async def resolve_totp_key() -> bytes:
    """Swarm secret file -> env var -> value in the DB -> freshly generated.

    Same fallback chain as :func:`resolve_session_secret`, and deliberately a
    separate secret from it: rotating the session secret (which signs out every
    session) must not also silently re-encrypt-fail every stored TOTP secret.

    A key that arrives from the Swarm secret or an env var is used as-is and is
    NOT written to the settings table. That write-back is the whole bug this
    guards against: a stale auto-generated row left over from before the secret
    existed would otherwise clobber the real, restart-surviving key on the next
    boot, and every enrolled user's TOTP would stop decrypting. Only a genuinely
    absent key is generated and stored. The source is logged so an operator can
    confirm at a glance that the persistent key is in effect.

    The resolved material is hashed to exactly 32 bytes for AES-256 regardless
    of what shape it arrived in (a hex secret, or an operator-supplied phrase).
    """
    material, source = config.read_secret_source("totp_enc_key", "TOTP_ENC_KEY")
    if not material:
        row = await db.fetchrow("SELECT value FROM settings WHERE key = 'totp_enc_key'")
        if row and row["value"]:
            material, source = row["value"], "database"
    if not material:
        generated = secrets.token_hex(32)
        material = await db.fetchval(
            """INSERT INTO settings (key, value) VALUES ('totp_enc_key', $1)
                ON CONFLICT (key) DO UPDATE SET value = settings.value
                RETURNING value""",
            generated,
        )
        source = "auto-generated"
    print(f"[config] totp_enc_key loaded from: {source}")
    return hashlib.sha256(material.encode("utf-8")).digest()


async def _housekeeping() -> None:
    """Daily attempt-log prune and hourly session sweep, for the process lifetime."""
    last_prune = 0.0
    while True:
        await asyncio.sleep(3600)
        session_store.sweep()
        if db.is_ready() and time.time() - last_prune > 24 * 3600:
            try:
                await auth.prune_login_attempts()
                last_prune = time.time()
            except Exception as err:  # noqa: BLE001
                print(f"[auth] prune failed: {err}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[dashboard] PostgreSQL target: {config.describe_db_target()}")
    if config.EXTRA_HOSTS:
        joined = ", ".join(f"{h.hostname}({h.addr})" for h in config.EXTRA_HOSTS)
        print(f"[metrics] standalone hosts: {joined}")

    connected = await db.connect()
    secret: str | None = None
    global totp_key
    if connected:
        try:
            await db.init_schema()
            secret = await resolve_session_secret()
            totp_key = await resolve_totp_key()
            if config.AI_ENABLED:
                await ai.resolve_service_token()
            await auth.prune_login_attempts()
            if await no_users_yet():
                print("[dashboard] no accounts yet — the setup wizard is open at /setup")
            print("[dashboard] database ready (schema verified)")
        except Exception as err:  # noqa: BLE001
            print(f"[dashboard] database setup failed: {err}")

    if not totp_key:
        # Same reasoning as the ephemeral session secret below: boot anyway so
        # the rest of the app works, but 2FA secrets encrypted with this key
        # will not decrypt after a restart until the database is back and the
        # real key is resolved — which only matters for the (rare) case of a
        # user completing 2FA setup while PostgreSQL is unreachable.
        totp_key = hashlib.sha256(secrets.token_bytes(32)).digest()

    if not secret:
        secret = config.SESSION_SECRET or secrets.token_hex(32)
        print(
            "[dashboard] STARTING WITHOUT DATABASE — login and all DB-backed routes return 503 "
            "until PostgreSQL is reachable. Check DB_HOST/DB_PORT/DB_USER/DB_PASS and that "
            "postgres on zs-state-01 accepts connections from this node."
        )
        if not config.SESSION_SECRET:
            print(
                "[dashboard] NOTE: using a temporary session secret — existing sessions are "
                "invalid and will not survive a restart. Set the session_secret Docker secret "
                "(or SESSION_SECRET) to avoid this entirely."
            )

    # The middleware stack is already frozen at this point, so the secret is
    # published into the holder the session middleware reads from instead.
    session_secret.value = secret

    tasks = [
        asyncio.create_task(db.retry_in_background()),
        asyncio.create_task(_housekeeping()),
    ]
    if config.CRIMSON_ENABLED:
        sso = "on" if config.CRIMSON_SSO_ENABLED else "off"
        print(
            f"[crimson] gateway on {config.CRIMSON_PATH} "
            f"(spa={config.CRIMSON_CLIENT_URL}, api={config.CRIMSON_API_URL}, sso={sso})"
        )
    if config.AI_ENABLED:
        state = "ready" if ai.configured() else "no shared token yet"
        print(f"[ai] gateway on /api/ai (service={config.AI_SERVICE_URL}, {state})")
    print(f"[dashboard] listening :{config.PORT}")
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await metrics.close()
        await crimson.close()
        await ai.close()
        await db.close()


app = FastAPI(
    title="zer0space dashboard",
    version=ASSET_VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# Added last = outermost. Order of execution is therefore:
#   TrustedHost -> BodyLimit -> Maintenance -> SecurityHeaders -> Session -> CSRF -> routes
# CSRF must sit inside Session (it reads request.state.session), and Session must
# sit inside SecurityHeaders so the Set-Cookie header is never dropped. BodyLimit
# sits outside everything that reads a body, so an oversized request is refused
# before any of it is buffered.
app.add_middleware(CsrfMiddleware)
app.add_middleware(auth.SessionMiddleware, store=session_store, secret=session_secret)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(MaintenanceMiddleware)
app.add_middleware(
    BodyLimitMiddleware,
    max_bytes=MAX_BODY_BYTES,
    proxy_max_bytes=MAX_PROXY_BODY_BYTES,
)
# Only mounted when ALLOWED_HOSTS is configured. A forged Host reaches the
# Crimson gateway's forwarded headers and any absolute URL built from it, and
# nothing else in the stack validates it. Left off by default so an existing
# deployment that has not set the variable keeps working unchanged.
if config.ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.ALLOWED_HOSTS)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")


# --- zer0space ✕ Crimson gateway --------------------------------------------
# Mounted only when both upstreams are configured, so on a normal dashboard
# /crimson simply 404s and nothing here runs. See src/crimson.py for why it
# streams and strips the session cookie. Crimson has no login of its own: the
# zer0space session below is the only door. Registration order matters — the
# API route is declared before the SPA catch-all so /crimson/api/* wins.
if config.CRIMSON_ENABLED:

    def _crimson_user(request: Request) -> str | None:
        session = get_session(request)
        if not session or not session.get("user_id"):
            return None
        return str(session["user_id"])

    @app.api_route(
        "/crimson/api/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    async def crimson_api(request: Request, path: str) -> Response:
        user = _crimson_user(request)
        if user is None:
            return fail(401, "UNAUTHORIZED", "Sign in to zer0space to use Crimson")

        # With the SSO broker on, mint/inject this user's Crimson Bearer so
        # /account/* is per-user. If the upstream rejects a cached token, drop it
        # and re-login once. An SSO failure falls through to an unauthenticated
        # proxy rather than 500-ing — browse/play keep working, only per-user
        # account data is unavailable.
        if config.CRIMSON_SSO_ENABLED:
            try:
                body = await request.body()
                for attempt in (0, 1):
                    bearer = await crimson_sso.token(user)
                    headers = crimson.build_request_headers(
                        request, bearer=bearer, forwarded_prefix="/crimson/api"
                    )
                    upstream = await crimson.open_upstream(
                        request, config.CRIMSON_API_URL, path, body, headers
                    )
                    if upstream.status_code == 401 and attempt == 0:
                        await upstream.aclose()
                        crimson_sso.invalidate(user)
                        continue
                    return crimson.stream_response(upstream)
            except crimson.UnsafePath:
                # Not an SSO failure, and retrying it unauthenticated below would
                # just reject it a second time.
                return fail(400, "CRIMSON_BAD_PATH", "Invalid path")
            except Exception as err:  # noqa: BLE001
                print(f"[crimson] SSO auth failed for zer0space user {user}: {err!r}")
                # fall through to the unauthenticated proxy below

        # SSO off: no per-user accounts, but browse/play still work. Pass the user
        # id as a hint header in case the backend is configured to trust it.
        return await crimson.proxy(
            request, config.CRIMSON_API_URL, path,
            inject_user=user, forwarded_prefix="/crimson/api",
        )

    # Media sub-resource relays at the *root*. The backend's same-origin HLS
    # proxies (VOE, PlayIMDb, …) rewrite every playlist sub-resource to a
    # ROOT-relative path like ``/voe_proxy?u=…`` — correct for their own
    # root-mounted deployment, but behind our ``/crimson/api`` mount hls.js
    # resolves them against the origin, so a segment lands at
    # ``zer0space.com/voe_proxy`` instead of ``…/crimson/api/voe_proxy`` and 404s
    # (the classic "master playlist loads, then the player greys out" for VOE).
    # Forward any ``/<name>_proxy`` back to the backend so the whole segment chain
    # resolves. The links are HMAC-signed with the backend's PROXY_SECRET and
    # re-verified there; the session gate just keeps the relay signed-in-only.
    # These two sit at the dashboard root, so every URL ending in _proxy belongs
    # to Crimson once the gateway is on. The relay name is checked against a
    # conservative character class rather than accepting any segment: it is
    # pasted straight into the upstream URL, and the routes exist only to carry
    # the backend's own ``/<name>_proxy`` links.
    _RELAY_NAME_OK = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$", re.IGNORECASE)

    @app.api_route(
        "/{proxy_name}_proxy", methods=["GET", "HEAD", "OPTIONS"], include_in_schema=False
    )
    async def crimson_media_proxy(request: Request, proxy_name: str) -> Response:
        if _crimson_user(request) is None:
            return fail(401, "UNAUTHORIZED", "Sign in to zer0space to use Crimson")
        if not _RELAY_NAME_OK.match(proxy_name):
            return fail(404, "NOT_FOUND", "Not found")
        return await crimson.proxy(request, config.CRIMSON_API_URL, f"{proxy_name}_proxy")

    @app.api_route(
        "/{proxy_name}_proxy/{rest:path}",
        methods=["GET", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    async def crimson_media_proxy_sub(
        request: Request, proxy_name: str, rest: str
    ) -> Response:
        if _crimson_user(request) is None:
            return fail(401, "UNAUTHORIZED", "Sign in to zer0space to use Crimson")
        if not _RELAY_NAME_OK.match(proxy_name):
            return fail(404, "NOT_FOUND", "Not found")
        return await crimson.proxy(
            request, config.CRIMSON_API_URL, f"{proxy_name}_proxy/{rest}"
        )

    @app.get("/crimson", include_in_schema=False)
    async def crimson_root(request: Request) -> Response:
        if _crimson_user(request) is None:
            return RedirectResponse("/login", status_code=303)
        return await crimson.proxy(request, config.CRIMSON_CLIENT_URL, "")

    @app.api_route("/crimson/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def crimson_spa(request: Request, path: str) -> Response:
        # A browser deep-link into the SPA; unauthenticated visitors go through
        # the zer0space front door. The client's own server answers unknown
        # routes with index.html (SPA fallback).
        if _crimson_user(request) is None:
            return RedirectResponse("/login", status_code=303)
        return await crimson.proxy(request, config.CRIMSON_CLIENT_URL, path)


@app.exception_handler(ApiError)
async def _api_error_handler(_request: Request, exc: ApiError) -> Response:
    return exc.response


@app.exception_handler(db.DatabaseUnavailable)
async def _db_down_handler(request: Request, exc: Exception) -> Response:
    """The database went away mid-request.

    A 503, not a 500: nothing is wrong with the request. db.py converts every
    connection-level failure into this one exception type precisely so this
    handler can stay a single line rather than an open-ended catch of OSError.
    """
    print(f"[dashboard] DB unavailable on {request.method} {request.url.path}: {exc}")
    return fail(503, "DB_UNAVAILABLE", "Database unavailable — please try again later")


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> Response:
    # The exception text is deliberately NOT sent to the client: it routinely
    # contains table names, column names and query fragments.
    print(f"[dashboard] error on {request.method} {request.url.path}: {exc!r}")
    return fail(500, "INTERNAL", "Internal error")


@app.exception_handler(404)
async def _not_found(request: Request, _exc: Any) -> Response:
    if request.url.path.startswith("/api/"):
        return fail(404, "NOT_FOUND", "Not found")
    response = page(request, "404.html")
    response.status_code = 404
    return response


# --- Public pages -----------------------------------------------------------


@app.get("/healthz", include_in_schema=False)
async def healthz() -> JSONResponse:
    """Liveness only — deliberately does not touch the database.

    A health check that fails when PostgreSQL is down would have Swarm restart a
    container that is working exactly as designed during a database outage.
    """
    return JSONResponse({"ok": True, "db": db.is_ready(), "version": ASSET_VERSION})


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return FileResponse(config.STATIC_DIR / "img" / "favicon.svg", media_type="image/svg+xml")


@app.get("/", response_class=HTMLResponse)
async def landing(request: Request) -> Response:
    return page(request, "landing.html", signed_in=bool(get_session(request) and get_session(request).get("user_id")))


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request) -> Response:
    session = get_session(request)
    if session and session.get("user_id"):
        return RedirectResponse("/dashboard", status_code=303)
    # A fresh install has no account to log into — send the operator to the
    # wizard rather than to a form that cannot succeed.
    if db.is_ready() and await no_users_yet():
        return RedirectResponse("/setup", status_code=303)
    return page(request, "login.html")


@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request) -> Response:
    session = get_session(request)
    if session and session.get("user_id"):
        return RedirectResponse("/dashboard", status_code=303)
    if db.is_ready() and await no_users_yet():
        return RedirectResponse("/setup", status_code=303)
    # The page renders regardless of whether the code in ?code= is valid.
    # Telling an anonymous visitor "this code does not exist" would turn the
    # page into an oracle for probing the code space; validation happens in
    # POST /api/register, which is rate limited.
    return page(request, "register.html")


@app.get("/setup", response_class=HTMLResponse)
async def setup_page(request: Request) -> Response:
    """Reachable only while the users table is empty.

    Once the first admin exists this redirects forever, which is what makes it
    safe to leave unauthenticated.
    """
    if not db.is_ready():
        # A page route, so answer with a page. Sending the JSON error body a
        # ``_require_db()`` would raise here means the operator's first
        # impression of a fresh install is a raw API response.
        response = page(request, "maintenance.html")
        response.status_code = 503
        return response
    if not await no_users_yet():
        return RedirectResponse("/login", status_code=303)
    return page(request, "setup.html")


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page(request: Request) -> Response:
    session = get_session(request)
    if not session or not session.get("user_id"):
        return RedirectResponse("/login", status_code=303)
    return page(request, "dashboard.html", username=session.get("username"), role=session.get("role"))


@app.get("/monitoring", response_class=HTMLResponse)
async def monitoring_page(request: Request) -> Response:
    """A stripped-down, always-on view of the cluster — built for a wall display
    or a kiosk iPad that should show at a glance that everything is fine.

    Behind the same session gate as the dashboard: it reads /api/overview, which
    discloses internal topology, so it is not public. A kiosk stays signed in for
    the session's lifetime (24h) and needs a fresh login only after a restart.
    """
    session = get_session(request)
    if not session or not session.get("user_id"):
        return RedirectResponse("/login", status_code=303)
    return page(request, "monitoring.html")


@app.get("/maintenance", response_class=HTMLResponse)
async def maintenance_page(request: Request) -> Response:
    return page(request, "maintenance.html")


@app.get("/loading", response_class=HTMLResponse)
async def loading_page(request: Request) -> Response:
    return page(request, "loading.html")


# --- Unauthenticated POST endpoints ----------------------------------------


@app.post("/api/setup")
async def api_setup(request: Request) -> Response:
    _require_db()
    body = await json_body(request)
    username, password = body.get("username"), body.get("password")

    problem = auth.username_problem(username) or auth.password_problem(password)
    if problem:
        return fail(400, problem, "Invalid username or password")

    hashed = await auth.hash_password(password)

    # The empty-table check and the INSERT run in one transaction with the table
    # locked. Two operators hitting /setup at the same moment on a fresh install
    # would otherwise both pass the check and both become admin.
    async with db.transaction() as con:
        await con.execute("LOCK TABLE users IN EXCLUSIVE MODE")
        if await con.fetchval("SELECT COUNT(*)::int FROM users") != 0:
            created = None
        else:
            created = await con.fetchrow(
                """INSERT INTO users (username, hash, role) VALUES ($1, $2, 'admin')
                    RETURNING id, username, role""",
                username.strip(),
                hashed,
            )

    if created is None:
        # Somebody won the race, or the wizard was replayed. Never say more than
        # this — that /setup is closed is all the caller is entitled to know.
        return fail(403, "SETUP_CLOSED", "Setup is already complete")

    print(f"[dashboard] setup complete — initial admin '{created['username']}' created")
    return JSONResponse({"ok": True}, status_code=201)


@app.post("/api/login")
async def api_login(request: Request) -> Response:
    _require_db()
    started = time.monotonic()
    ip = auth.client_ip(request)
    body = await json_body(request)
    username, password = body.get("username"), body.get("password")

    if not isinstance(username, str) or not isinstance(password, str) or not username or not password:
        return fail(400, "INPUT_MISSING", "Input missing")

    async def generic_fail() -> Response:
        # Every rejection past this point answers with the same body after the
        # same elapsed time, so the response cannot be used to enumerate
        # usernames or to discover which accounts are locked.
        await auth.pad_timing(started)
        return fail(401, "BAD_CREDENTIALS", "Invalid credentials")

    # Checked BEFORE anything is recorded: a blocked caller must not be able to
    # extend its own block by continuing to hammer the endpoint.
    blocked = await auth.check_login_rate_limit(ip, username)
    if blocked:
        await auth.pad_timing(started)
        return fail(
            429,
            "RATE_LIMITED",
            "Too many attempts. Try again later.",
            retryAfterMinutes=max(1, round(blocked / 60)),
        )

    user = await db.fetchrow("SELECT * FROM users WHERE username = $1", username)

    # Run the password check even when the account is missing or locked, so all
    # three paths cost exactly one bcrypt round.
    password_ok = await auth.verify_password(password, user["hash"] if user else None)

    if auth.is_locked(user):
        await auth.record_attempt(username=username, ip=ip, success=False)
        # The one non-generic answer, and only for a caller who already proved
        # they know the password: without it, a locked-out user has no way to
        # understand why a correct password keeps failing.
        if password_ok:
            await auth.pad_timing(started)
            remaining = auth.lock_remaining_seconds(user)
            return fail(
                423,
                "ACCOUNT_LOCKED",
                "Account locked after repeated failed logins",
                retryAfterMinutes=(max(1, round(remaining / 60)) if remaining else None),
            )
        return await generic_fail()

    if not user or not password_ok:
        await auth.record_attempt(username=username, ip=ip, success=False)
        await auth.register_failed_login(user)
        return await generic_fail()

    await auth.record_attempt(username=username, ip=ip, success=True)
    await auth.clear_failed_logins(user["id"])

    store: auth.SessionStore = request.scope["state"]["session_store"]
    existing = get_session(request)
    session = store.regenerate(existing) if existing else store.create()
    session.data.clear()

    if user["totp_enabled"]:
        # Step 1 of 2 passed. Deliberately NOT setting user_id here:
        # _require_session (and therefore every other /api/* route) keys off
        # it, so this pending session cannot reach anything but
        # /api/2fa/login. The vault key is likewise not derived yet — that
        # only happens once the second factor succeeds, below.
        session["pending_2fa_user_id"] = user["id"]
        session["pending_2fa_username"] = user["username"]
        session["pending_2fa_password"] = password  # kept only until /api/2fa/login succeeds
        session["pending_2fa_expires"] = time.time() + 5 * 60
        auth.issue_csrf_token(session)
        request.scope["state"]["session"] = session
        request.scope["state"]["session_changed"] = True
        return JSONResponse({"requires_2fa": True, "csrfToken": session["csrf_token"]}, status_code=202)

    # Derive this user's vault key from their plaintext password — available
    # only here, before it goes out of scope — plus their PBKDF2 salt. The key
    # lives ONLY in the server-side session and is never written to the DB.
    vault_salt = user["vault_salt"]
    if not vault_salt:
        vault_salt = vault.new_salt()
        await db.execute("UPDATE users SET vault_salt = $1 WHERE id = $2", vault_salt, user["id"])
    vault_key = await vault.derive_vault_key(password, vault_salt)

    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"] or "viewer"
    session["vault_key"] = vault_key
    auth.issue_csrf_token(session)

    request.scope["state"]["session"] = session
    request.scope["state"]["session_changed"] = True

    return JSONResponse({"ok": True, "role": session["role"]})


@app.post("/api/2fa/login")
async def api_2fa_login(request: Request) -> Response:
    """Step 2 of the 2FA login flow.

    Reachable with only a *pending* session (no ``user_id``), which is exactly
    what keeps every other authenticated route closed to it — see the comment
    in ``api_login`` above. NOT in ``CsrfMiddleware.EXEMPT``: unlike the three
    truly anonymous endpoints, a session (and therefore a CSRF token) already
    exists by this point, so there is no reason to exempt it.
    """
    _require_db()
    session = get_session(request)
    pending_id = session.get("pending_2fa_user_id") if session else None
    if not session or not pending_id or time.time() > (session.get("pending_2fa_expires") or 0):
        return fail(401, "TWOFA_SESSION_EXPIRED", "Session expired — please log in again")

    pending_username = session.get("pending_2fa_username") or ""
    blocked = await auth.check_2fa_rate_limit(pending_username)
    if blocked:
        return fail(
            429,
            "RATE_LIMITED",
            "Too many attempts. Try again later.",
            retryAfterMinutes=max(1, round(blocked / 60)),
        )

    body = await json_body(request)
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        return fail(400, "INPUT_MISSING", "Input missing")

    user = await db.fetchrow("SELECT * FROM users WHERE id = $1", pending_id)
    if not user or not user["totp_enabled"]:
        return fail(401, "TWOFA_SESSION_EXPIRED", "Session expired — please log in again")
    # Re-checked here, not just in api_login: the pending session lives for five
    # minutes, and an admin locking the account inside that window must not leave
    # the holder of a half-finished login able to complete it.
    if auth.is_locked(user):
        return fail(401, "TWOFA_SESSION_EXPIRED", "Session expired — please log in again")

    ip = auth.client_ip(request)
    secret = vault.decrypt_field(user["totp_secret"], totp_key) if user["totp_secret"] else None
    valid_code = bool(secret) and totp.verify_code(secret, code)
    valid_recovery = False if valid_code else await auth.consume_recovery_code(user["id"], code)

    if not valid_code and not valid_recovery:
        await auth.record_attempt(username=pending_username, ip=ip, success=False, kind="2fa")
        return fail(401, "TWOFA_INVALID", "Invalid code")
    await auth.record_attempt(username=pending_username, ip=ip, success=True, kind="2fa")

    password = session.pop("pending_2fa_password", None)
    vault_salt = user["vault_salt"]
    if not vault_salt:
        vault_salt = vault.new_salt()
        await db.execute("UPDATE users SET vault_salt = $1 WHERE id = $2", vault_salt, user["id"])
    vault_key = await vault.derive_vault_key(password, vault_salt)

    # Same session-fixation guard as the password-only path: a fresh sid, not
    # a reuse of the pending one.
    store: auth.SessionStore = request.scope["state"]["session_store"]
    session = store.regenerate(session)
    session.data.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["role"] = user["role"] or "viewer"
    session["vault_key"] = vault_key
    auth.issue_csrf_token(session)

    request.scope["state"]["session"] = session
    request.scope["state"]["session_changed"] = True

    return JSONResponse({"ok": True, "role": session["role"], "usedRecoveryCode": valid_recovery})


@app.post("/api/logout")
async def api_logout(request: Request) -> Response:
    session = get_session(request)
    if session:
        request.scope["state"]["session_store"].destroy(session.sid)
    request.scope["state"]["session"] = None
    request.scope["state"]["session_cleared"] = True
    return JSONResponse({"ok": True})


@app.post("/api/register")
async def api_register(request: Request) -> Response:
    _require_db()
    started = time.monotonic()
    ip = auth.client_ip(request)
    body = await json_body(request)
    code = body.get("code")
    username = body.get("username")
    password = body.get("password")

    async def reject() -> Response:
        # Every invite failure returns this exact response. An attacker must not
        # be able to tell "no such code" from "expired", "already used" or
        # "username taken" — each of those distinctions leaks something.
        await auth.record_attempt(username=username if isinstance(username, str) else "",
                                  ip=ip, success=False, kind="register")
        await auth.pad_timing(started)
        return fail(400, "INVITE_INVALID", "Invitation code invalid or expired")

    blocked = await auth.check_register_rate_limit(ip)
    if blocked:
        await auth.pad_timing(started)
        return fail(
            429,
            "RATE_LIMITED",
            "Too many attempts. Try again later.",
            retryAfterMinutes=max(1, round(blocked / 60)),
        )

    # Input problems are reported honestly — the client needs to be able to fix
    # them, and none of them reveal anything about the invite.
    problem = auth.username_problem(username) or auth.password_problem(password)
    if problem:
        return fail(400, problem, "Invalid username or password")
    if not auth.looks_like_invite_code(code):
        return await reject()

    hashed = await auth.hash_password(password)

    async with db.transaction() as con:
        # FOR UPDATE so two people redeeming the same code at once cannot both win.
        invite = await con.fetchrow(
            "SELECT id, expires_at, used_by, max_role FROM invite_codes WHERE code = $1 FOR UPDATE",
            code,
        )
        outcome = "invalid"
        if invite and not invite["used_by"] and invite["expires_at"].timestamp() > time.time():
            role = "admin" if invite["max_role"] == "admin" else "viewer"
            inserted = await con.fetchrow(
                """INSERT INTO users (username, hash, role) VALUES ($1, $2, $3)
                    ON CONFLICT (username) DO NOTHING
                    RETURNING id""",
                username.strip(),
                hashed,
                role,
            )
            if inserted:  # a taken username gets the same generic answer
                await con.execute(
                    "UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE id = $2",
                    inserted["id"],
                    invite["id"],
                )
                outcome = "ok"

    if outcome != "ok":
        return await reject()

    await auth.record_attempt(username=username, ip=ip, success=True, kind="register")
    await auth.pad_timing(started)
    print(f"[dashboard] new account '{username.strip()}' registered via invite")
    return JSONResponse({"ok": True}, status_code=201)


# --- Authenticated API ------------------------------------------------------


@app.get("/api/me")
async def api_me(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    user = await db.fetchrow(
        "SELECT username, role, theme, totp_enabled FROM users WHERE id = $1", session["user_id"]
    )
    return JSONResponse(
        {
            "username": user["username"] if user else session.get("username"),
            "role": (user["role"] if user else session.get("role")) or "viewer",
            "theme": user["theme"] if user else None,
            "csrfToken": session.get("csrf_token"),
            "vaultUnlocked": bool(session.get("vault_key")),
            "totpEnabled": bool(user["totp_enabled"]) if user else False,
        }
    )


@app.post("/api/change-password")
async def api_change_password(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    body = await json_body(request)
    current_password = body.get("currentPassword")
    new_password = body.get("newPassword")
    if not isinstance(current_password, str) or not isinstance(new_password, str):
        return fail(400, "FIELDS_MISSING", "Fields missing")
    problem = auth.password_problem(new_password)
    if problem:
        return fail(400, problem, "Invalid password")

    user = await db.fetchrow("SELECT * FROM users WHERE id = $1", session["user_id"])
    if not user or not await auth.verify_password(current_password, user["hash"]):
        return fail(401, "PW_CURRENT_WRONG", "Current password is wrong")

    # A self-service change is the ONE place we hold both the old and the new
    # plaintext password in the same request, so the vault can be re-encrypted
    # losslessly. Rotate the salt too — a fresh key, not a re-derivation with
    # the same salt.
    new_salt = vault.new_salt()
    old_key = session.get("vault_key")
    new_key = await vault.derive_vault_key(new_password, new_salt) if old_key else None
    new_hash = await auth.hash_password(new_password)

    async with db.transaction() as con:
        if new_key:
            await vault.reencrypt_all(con, user["id"], old_key, new_key)
        await con.execute(
            "UPDATE users SET hash = $1, vault_salt = $2 WHERE id = $3",
            new_hash,
            new_salt,
            user["id"],
        )

    # Only swap the in-session key after the transaction committed.
    if new_key:
        session["vault_key"] = new_key
    return JSONResponse({"ok": True})


# --- 2FA (TOTP) — setup / verify / disable -----------------------------------
#
# /api/2fa/setup and /api/2fa/disable re-check the current password even though
# the session is already authenticated: turning a second factor on or off is
# sensitive enough to re-confirm identity, which also covers a
# hijacked-but-unlocked browser tab.
#
# /api/2fa/verify deliberately does NOT, because it cannot be reached without
# first passing the password check in /api/2fa/setup — it only confirms that the
# secret that setup handed out was actually scanned. Stated explicitly because
# the previous wording claimed all three check the password, and a reader
# trusting that would not notice which one does not.


@app.post("/api/2fa/setup")
async def api_2fa_setup(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    body = await json_body(request)
    password = body.get("password")
    if not isinstance(password, str) or not password:
        return fail(400, "PW_REQUIRED", "Current password required")

    user = await db.fetchrow("SELECT * FROM users WHERE id = $1", session["user_id"])
    if not user or not await auth.verify_password(password, user["hash"]):
        return fail(401, "PW_CURRENT_WRONG", "Current password is wrong")
    if user["totp_enabled"]:
        return fail(409, "TWOFA_ALREADY_ENABLED", "2FA is already enabled")

    # Held in the session only until /api/2fa/verify proves the user actually
    # scanned it — NOT written to the DB yet, so an abandoned setup leaves no
    # trace and can simply be started over.
    secret = totp.generate_secret()
    session["pending_totp_secret"] = secret
    uri = totp.provisioning_uri(secret, user["username"])
    return JSONResponse({"secret": secret, "qrDataUri": totp.qr_data_uri(uri)})


@app.post("/api/2fa/verify")
async def api_2fa_verify(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    secret = session.get("pending_totp_secret")
    if not secret:
        return fail(409, "TWOFA_NO_SETUP", "No 2FA setup in progress")

    blocked = await auth.check_2fa_rate_limit(session.get("username") or "")
    if blocked:
        return fail(
            429,
            "RATE_LIMITED",
            "Too many attempts. Try again later.",
            retryAfterMinutes=max(1, round(blocked / 60)),
        )

    body = await json_body(request)
    code = body.get("code")
    ip = auth.client_ip(request)
    if not totp.verify_code(secret, code if isinstance(code, str) else ""):
        await auth.record_attempt(username=session.get("username") or "", ip=ip, success=False, kind="2fa")
        return fail(401, "TWOFA_INVALID", "Invalid code")
    await auth.record_attempt(username=session.get("username") or "", ip=ip, success=True, kind="2fa")

    recovery_codes = auth.generate_recovery_codes()
    await db.execute(
        "UPDATE users SET totp_secret = $1, totp_enabled = TRUE WHERE id = $2",
        vault.encrypt_field(secret, totp_key),
        session["user_id"],
    )
    await auth.store_recovery_codes(session["user_id"], recovery_codes)
    session.pop("pending_totp_secret", None)

    # recoveryCodes is returned exactly once, in this response — no route can
    # ever retrieve them again; only their bcrypt hashes are stored.
    return JSONResponse({"ok": True, "recoveryCodes": recovery_codes})


@app.post("/api/2fa/disable")
async def api_2fa_disable(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    body = await json_body(request)
    password = body.get("password")
    code = body.get("code")
    if not isinstance(password, str) or not password or not isinstance(code, str) or not code:
        return fail(400, "FIELDS_MISSING", "Password and code required")

    user = await db.fetchrow("SELECT * FROM users WHERE id = $1", session["user_id"])
    if not user or not await auth.verify_password(password, user["hash"]):
        return fail(401, "PW_CURRENT_WRONG", "Current password is wrong")
    if not user["totp_enabled"]:
        return fail(409, "TWOFA_NOT_ENABLED", "2FA is not enabled")

    blocked = await auth.check_2fa_rate_limit(user["username"])
    if blocked:
        return fail(
            429,
            "RATE_LIMITED",
            "Too many attempts. Try again later.",
            retryAfterMinutes=max(1, round(blocked / 60)),
        )

    ip = auth.client_ip(request)
    secret = vault.decrypt_field(user["totp_secret"], totp_key) if user["totp_secret"] else None
    if not secret or not totp.verify_code(secret, code):
        await auth.record_attempt(username=user["username"], ip=ip, success=False, kind="2fa")
        return fail(401, "TWOFA_INVALID", "Invalid code")
    await auth.record_attempt(username=user["username"], ip=ip, success=True, kind="2fa")

    async with db.transaction() as con:
        await con.execute(
            "UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1", session["user_id"]
        )
        await con.execute("DELETE FROM recovery_codes WHERE user_id = $1", session["user_id"])
    return JSONResponse({"ok": True})


@app.put("/api/user/theme")
async def api_set_theme(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    body = await json_body(request)
    theme = body.get("theme")
    # A named preset or a hex colour — nothing else means anything to the
    # client, and an unbounded string here is a free write primitive into the
    # users table.
    if not isinstance(theme, str) or not theme:
        return fail(400, "THEME_REQUIRED", "Theme required")
    valid_hex = theme.startswith("#") and len(theme) == 7 and all(c in "0123456789abcdefABCDEF" for c in theme[1:])
    valid_name = theme.isascii() and theme.isalpha() and 3 <= len(theme) <= 16 and theme.islower()
    if not (valid_hex or valid_name):
        return fail(400, "THEME_INVALID", "Invalid theme")
    await db.execute("UPDATE users SET theme = $1 WHERE id = $2", theme, session["user_id"])
    return JSONResponse({"ok": True})


# The settings table is NOT purely UI configuration — the session signing key is
# stored in it. This route is readable by any authenticated user, so returning
# the table wholesale would hand every viewer the secret used to sign session
# cookies, which is enough to forge an admin session.
#
# Hence an allowlist rather than a denylist: an internal key added later must not
# silently become world-readable because nobody remembered to exclude it.
PUBLIC_SETTINGS = {"theme", "bg_mode", "bg_file"}


@app.get("/api/settings")
async def api_get_settings(request: Request) -> Response:
    _require_session(request)
    _require_db()
    rows = await db.fetch(
        "SELECT key, value FROM settings WHERE key = ANY($1::text[])", sorted(PUBLIC_SETTINGS)
    )
    return JSONResponse({r["key"]: r["value"] for r in rows})


@app.get("/api/services")
async def api_get_services(request: Request) -> Response:
    _require_session(request)
    _require_db()
    return JSONResponse(db.rows_to_dicts(await db.fetch("SELECT * FROM services ORDER BY id")))


@app.get("/api/overview")
async def api_overview(request: Request) -> Response:
    """Everything the dashboard home view needs, in one request.

    The five status tiles are computed here rather than in the browser: each of
    them is an X-of-Y that was wrong at some point because two views counted it
    differently. One implementation, one answer.
    """
    _require_session(request)
    data = await metrics.collect()
    backup = metrics.backup_status()
    return JSONResponse(
        {
            "tiles": metrics.build_tiles(data, backup),
            "nodes": data["nodes"],
            "extraHosts": data["extraHosts"],
            "swarm": data["swarm"],
            "backup": backup,
            "error": data["error"],
        }
    )


@app.get("/api/metrics")
async def api_metrics(request: Request) -> Response:
    _require_session(request)
    data = await metrics.collect()
    status = 503 if data["error"] else 200
    return JSONResponse(data, status_code=status)


@app.get("/api/status")
async def api_status(request: Request) -> Response:
    _require_session(request)
    try:
        snap = await metrics.swarm_snapshot()
    except Exception:  # noqa: BLE001
        return fail(503, "PROXY_UNAVAILABLE", "Docker proxy unavailable")
    nodes = [metrics.node_info(n) for n in snap["nodes"]]
    return JSONResponse(metrics.swarm_summary(nodes, snap))


@app.get("/api/backup")
async def api_backup(request: Request) -> Response:
    _require_session(request)
    return JSONResponse(metrics.backup_status())


# --- Vault ------------------------------------------------------------------


def _vault_key(session: auth.Session) -> bytes:
    key = session.get("vault_key")
    if not key:
        raise ApiError(409, "VAULT_LOCKED", "The vault is locked — sign out and back in to unlock it.")
    return key


@app.get("/api/vault")
async def api_vault_list(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    key = _vault_key(session)
    # SQLite's COLLATE NOCASE has no PostgreSQL equivalent; LOWER() gives the
    # same case-insensitive ordering.
    rows = await db.fetch(
        "SELECT * FROM vault_entries WHERE user_id = $1 ORDER BY LOWER(title)", session["user_id"]
    )
    return JSONResponse([vault.row_to_entry(r, key) for r in rows])


@app.post("/api/vault")
async def api_vault_create(request: Request) -> Response:
    session = _require_session(request)
    _require_db()
    key = _vault_key(session)
    body = await json_body(request)
    problem = vault.validate_entry(body)
    if problem:
        return fail(400, problem, "Invalid vault entry")
    row = await db.fetchrow(
        """INSERT INTO vault_entries
             (user_id, title, username, encrypted_password, encrypted_notes, url, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
           RETURNING *""",
        session["user_id"],
        body["title"].strip(),
        body.get("username", "").strip(),
        vault.encrypt_field(body.get("password", ""), key),
        vault.encrypt_field(body.get("notes", ""), key),
        body.get("url", "").strip(),
    )
    return JSONResponse(vault.row_to_entry(row, key), status_code=201)


@app.put("/api/vault/{entry_id}")
async def api_vault_update(request: Request, entry_id: str) -> Response:
    session = _require_session(request)
    _require_db()
    key = _vault_key(session)
    eid = _path_id(entry_id)
    body = await json_body(request)
    problem = vault.validate_entry(body)
    if problem:
        return fail(400, problem, "Invalid vault entry")
    # user_id stays in the WHERE clause, not just in the application logic — a
    # user can never even address another user's row, regardless of code path.
    # RETURNING makes the existence check and the update one statement.
    row = await db.fetchrow(
        """UPDATE vault_entries
              SET title = $1, username = $2, encrypted_password = $3,
                  encrypted_notes = $4, url = $5, updated_at = NOW()
            WHERE id = $6 AND user_id = $7
            RETURNING *""",
        body["title"].strip(),
        body.get("username", "").strip(),
        vault.encrypt_field(body.get("password", ""), key),
        vault.encrypt_field(body.get("notes", ""), key),
        body.get("url", "").strip(),
        eid,
        session["user_id"],
    )
    if not row:
        return fail(404, "ENTRY_NOT_FOUND", "Entry not found")
    return JSONResponse(vault.row_to_entry(row, key))


@app.delete("/api/vault/{entry_id}")
async def api_vault_delete(request: Request, entry_id: str) -> Response:
    session = _require_session(request)
    _require_db()
    result = await db.execute(
        "DELETE FROM vault_entries WHERE id = $1 AND user_id = $2",
        _path_id(entry_id),
        session["user_id"],
    )
    if result.endswith(" 0"):
        return fail(404, "ENTRY_NOT_FOUND", "Entry not found")
    return Response(status_code=204)


# --- AI assistant -----------------------------------------------------------
#
# Every route here is a thin gate in front of the zer0space AI service: check the
# session, forward who is asking, pass the answer back. The AI service holds the
# provider keys and the chat history and is not reachable from anywhere else, so
# this is the only door into it.
#
# The one route that does real work is the chat one, which attaches the live
# cluster snapshot. metrics.py here is the authoritative view of the cluster, so
# the snapshot is built server-side and sent along rather than the AI service
# growing a second, disagreeing implementation of "how many nodes are up".


async def _ai_context_bundle() -> dict[str, Any]:
    """The cluster snapshot the assistant reasons over.

    Deliberately built here and not accepted from the browser. The client already
    has most of this on screen, so taking it from the request would be cheaper,
    but it would also mean the model's view of the cluster is whatever the client
    said it was.

    Every part is best effort: a failed poll means one section of the prompt says
    "no data", which is a far better outcome than the chat box refusing to answer
    because Glances timed out on one host.
    """
    bundle: dict[str, Any] = {}
    try:
        data = await metrics.collect()
        backup = metrics.backup_status()
        bundle.update(
            {
                "tiles": metrics.build_tiles(data, backup),
                "nodes": data["nodes"],
                "extraHosts": data["extraHosts"],
                "swarm": data["swarm"],
                "backup": backup,
                "error": data["error"],
            }
        )
    except Exception as err:  # noqa: BLE001 context is a bonus, never a blocker
        print(f"[ai] could not collect cluster context: {err!r}")
        bundle["error"] = "PROXY_UNAVAILABLE"

    try:
        rows = await db.fetch(
            "SELECT id, name, description, url, category, status FROM services ORDER BY id"
        )
        bundle["services"] = db.rows_to_dicts(rows)
    except Exception as err:  # noqa: BLE001
        print(f"[ai] could not load the service catalogue: {err!r}")

    return bundle


@app.get("/api/ai/status")
async def api_ai_status(request: Request) -> Response:
    """Can this user chat, and to which model?

    Answers without contacting the AI service when the gateway is off, so the
    chat view can hide itself on a deployment that never opted in.
    """
    session = _require_session(request)
    if not config.AI_ENABLED:
        return JSONResponse({"enabled": False, "ready": False, "reason": "AI_NOT_CONFIGURED"})
    return await ai.call("GET", "/api/status", session)


@app.get("/api/ai/providers")
async def api_ai_providers(request: Request) -> Response:
    return await ai.call("GET", "/api/providers", _require_admin(request))


@app.post("/api/ai/chat")
async def api_ai_chat(request: Request) -> Response:
    """Send one message and stream the answer back as Server-Sent Events."""
    session = _require_session(request)
    body = await json_body(request)

    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        return fail(400, "AI_MESSAGE_REQUIRED", "A message is required")

    payload: dict[str, Any] = {"message": message}
    if isinstance(body.get("conversationId"), int):
        payload["conversationId"] = body["conversationId"]
    payload["context"] = await _ai_context_bundle()

    return await ai.stream_chat(request, session, payload)


@app.get("/api/ai/conversations")
async def api_ai_conversations(request: Request) -> Response:
    return await ai.call("GET", "/api/conversations", _require_session(request))


@app.get("/api/ai/conversations/{conversation_id}")
async def api_ai_conversation(request: Request, conversation_id: str) -> Response:
    session = _require_session(request)
    return await ai.call("GET", f"/api/conversations/{_path_id(conversation_id)}", session)


@app.delete("/api/ai/conversations/{conversation_id}")
async def api_ai_delete_conversation(request: Request, conversation_id: str) -> Response:
    session = _require_session(request)
    return await ai.call("DELETE", f"/api/conversations/{_path_id(conversation_id)}", session)


@app.delete("/api/ai/conversations")
async def api_ai_delete_conversations(request: Request) -> Response:
    """Clear the caller's own history.

    No userId is forwarded, so a user can only ever clear their own. The admin
    form of this call is made by the account deletion route, not from the UI.
    """
    return await ai.call("DELETE", "/api/conversations", _require_session(request))


@app.get("/api/ai/config")
async def api_ai_get_config(request: Request) -> Response:
    return await ai.call("GET", "/api/config", _require_admin(request))


@app.put("/api/ai/config")
async def api_ai_put_config(request: Request) -> Response:
    """Update the assistant's configuration.

    The body is forwarded as-is and validated by the AI service, which owns the
    document's shape. Validating it here too would mean two implementations of
    the same rules, drifting apart one release at a time.
    """
    session = _require_admin(request)
    return await ai.call("PUT", "/api/config", session, body=await json_body(request))


@app.post("/api/ai/config/test")
async def api_ai_test_config(request: Request) -> Response:
    session = _require_admin(request)
    return await ai.call("POST", "/api/config/test", session, body=await json_body(request))


@app.get("/api/ai/models")
async def api_ai_models(request: Request) -> Response:
    session = _require_admin(request)
    provider = request.query_params.get("provider") or ""
    return await ai.call(
        "GET", "/api/models", session, params={"provider": provider} if provider else None
    )


# --- Admin: services --------------------------------------------------------


SERVICE_CATEGORIES = ("general", "ai", "cloud", "tools")
SERVICE_STATUSES = ("unknown", "online", "offline", "maintenance")


def _validate_service(body: dict[str, Any]) -> str | None:
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return "SERVICE_NAME_REQUIRED"
    if len(name) > 100:
        return "SERVICE_NAME_TOO_LONG"
    for field, limit, code in (
        ("description", 300, "SERVICE_DESC_TOO_LONG"),
        ("url", 500, "SERVICE_URL_TOO_LONG"),
        ("icon", 60, "SERVICE_ICON_TOO_LONG"),
    ):
        value = body.get(field, "")
        if not isinstance(value, str) or len(value) > limit:
            return code
    if body.get("category", "general") not in SERVICE_CATEGORIES:
        return "SERVICE_CATEGORY_INVALID"
    if body.get("status", "unknown") not in SERVICE_STATUSES:
        return "SERVICE_STATUS_INVALID"
    return None


@app.post("/api/services")
async def api_create_service(request: Request) -> Response:
    _require_admin(request)
    _require_db()
    body = await json_body(request)
    problem = _validate_service(body)
    if problem:
        return fail(400, problem, "Invalid service")
    row = await db.fetchrow(
        """INSERT INTO services (name, description, url, icon, status, category)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
        body["name"].strip(),
        body.get("description", "").strip(),
        body.get("url", "").strip(),
        body.get("icon", "").strip() or "grid",
        body.get("status", "unknown"),
        body.get("category", "general"),
    )
    return JSONResponse(dict(row), status_code=201)


@app.put("/api/services/{service_id}")
async def api_update_service(request: Request, service_id: str) -> Response:
    _require_admin(request)
    _require_db()
    sid = _path_id(service_id)
    body = await json_body(request)
    problem = _validate_service(body)
    if problem:
        return fail(400, problem, "Invalid service")
    row = await db.fetchrow(
        """UPDATE services SET name = $1, description = $2, url = $3, icon = $4,
                status = $5, category = $6
            WHERE id = $7 RETURNING *""",
        body["name"].strip(),
        body.get("description", "").strip(),
        body.get("url", "").strip(),
        body.get("icon", "").strip() or "grid",
        body.get("status", "unknown"),
        body.get("category", "general"),
        sid,
    )
    if not row:
        return fail(404, "SERVICE_NOT_FOUND", "Service not found")
    return JSONResponse(dict(row))


@app.delete("/api/services/{service_id}")
async def api_delete_service(request: Request, service_id: str) -> Response:
    _require_admin(request)
    _require_db()
    await db.execute("DELETE FROM services WHERE id = $1", _path_id(service_id))
    return Response(status_code=204)


@app.put("/api/settings")
async def api_put_setting(request: Request) -> Response:
    _require_admin(request)
    _require_db()
    body = await json_body(request)
    key, value = body.get("key"), body.get("value")
    if not isinstance(key, str) or value is None:
        return fail(400, "KEY_VALUE_REQUIRED", "Key and value required")
    # Same allowlist as the read side: without it an admin could overwrite
    # session_secret through the settings UI and invalidate every session — or
    # set it to a value of their own choosing.
    if key not in PUBLIC_SETTINGS:
        return fail(400, "SETTING_UNKNOWN", "Unknown setting")
    if len(str(value)) > 512:
        return fail(400, "SETTING_TOO_LONG", "Value too long")
    await db.execute(
        """INSERT INTO settings (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""",
        key,
        str(value),
    )
    return JSONResponse({"ok": True})


# --- Admin: invitations -----------------------------------------------------
#
# After setup, an invite code is the ONLY way an account can come into existence.
# There is no open registration and no admin-set password for a new user, so a
# new user's password is never known to anyone but themselves.


@app.post("/api/invite")
async def api_create_invite(request: Request) -> Response:
    session = _require_admin(request)
    _require_db()
    body = await json_body(request)

    raw_days = body.get("expiresInDays", 7)
    try:
        days = int(raw_days)
    except (TypeError, ValueError):
        days = 7
    if not 1 <= days <= 90:
        return fail(400, "INVITE_EXPIRY_INVALID", "Expiry must be between 1 and 90 days")
    role = "admin" if body.get("maxRole") == "admin" else "viewer"

    if await auth.check_invite_quota(session["user_id"]):
        return fail(
            429,
            "INVITE_QUOTA",
            f"Invite limit reached ({auth.INVITE_MAX_PER_HOUR} per hour)",
        )

    row = await db.fetchrow(
        """INSERT INTO invite_codes (code, created_by, expires_at, max_role)
            VALUES ($1, $2, NOW() + ($3 || ' days')::interval, $4)
            RETURNING id, code, created_at, expires_at, max_role""",
        auth.new_invite_code(),
        session["user_id"],
        str(days),
        role,
    )
    print(f"[dashboard] invite created by '{session.get('username')}' (role {role}, {days}d)")
    return JSONResponse(
        {
            "id": row["id"],
            "code": row["code"],
            "created_at": row["created_at"].isoformat(),
            "expires_at": row["expires_at"].isoformat(),
            "max_role": row["max_role"],
            "status": "active",
            "created_by_name": session.get("username"),
            "used_by_name": None,
            "used_at": None,
        },
        status_code=201,
    )


@app.get("/api/invites")
async def api_list_invites(request: Request) -> Response:
    _require_admin(request)
    _require_db()
    rows = await db.fetch(
        """SELECT i.id, i.code, i.created_at, i.expires_at, i.used_at, i.max_role,
                  c.username AS created_by_name,
                  u.username AS used_by_name,
                  CASE
                    WHEN i.used_by IS NOT NULL THEN 'used'
                    WHEN i.expires_at <= NOW() THEN 'expired'
                    ELSE 'active'
                  END AS status
             FROM invite_codes i
             LEFT JOIN users c ON c.id = i.created_by
             LEFT JOIN users u ON u.id = i.used_by
            ORDER BY i.created_at DESC"""
    )
    return JSONResponse(
        [
            {
                **dict(r),
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "expires_at": r["expires_at"].isoformat() if r["expires_at"] else None,
                "used_at": r["used_at"].isoformat() if r["used_at"] else None,
            }
            for r in rows
        ]
    )


@app.delete("/api/invite/{invite_id}")
async def api_delete_invite(request: Request, invite_id: str) -> Response:
    _require_admin(request)
    _require_db()
    # A redeemed code is kept: it is the audit record of how an account came to
    # exist. Only unredeemed codes can be revoked.
    result = await db.execute(
        "DELETE FROM invite_codes WHERE id = $1 AND used_by IS NULL", _path_id(invite_id)
    )
    if result.endswith(" 0"):
        return fail(404, "INVITE_NOT_FOUND", "Invite not found or already redeemed")
    return JSONResponse({"ok": True})


# --- Admin: users -----------------------------------------------------------


@app.get("/api/users")
async def api_list_users(request: Request) -> Response:
    _require_admin(request)
    _require_db()
    rows = await db.fetch(
        """SELECT id, username, role, failed_attempts, locked, totp_enabled, created_at,
                  CASE WHEN locked_until > NOW() THEN locked_until ELSE NULL END AS locked_until
             FROM users ORDER BY id"""
    )
    return JSONResponse(
        [
            {
                **dict(r),
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "locked_until": r["locked_until"].isoformat() if r["locked_until"] else None,
            }
            for r in rows
        ]
    )


@app.post("/api/users/{user_id}/unlock")
async def api_unlock_user(request: Request, user_id: str) -> Response:
    _require_admin(request)
    _require_db()
    result = await db.execute(
        "UPDATE users SET failed_attempts = 0, locked_until = NULL, locked = FALSE WHERE id = $1",
        _path_id(user_id),
    )
    if result.endswith(" 0"):
        return fail(404, "USER_NOT_FOUND", "User not found")
    return JSONResponse({"ok": True})


@app.post("/api/users/{user_id}/reset-2fa")
async def api_reset_2fa(request: Request, user_id: str) -> Response:
    """For when the user loses their authenticator device.

    Drops the encrypted secret and every recovery code; the user re-enrols from
    scratch via /api/2fa/setup next time they sign in. 2FA is optional per user,
    so this does not lock them out of the account — it just turns TOTP back off.
    """
    _require_admin(request)
    _require_db()
    uid = _path_id(user_id)
    async with db.transaction() as con:
        exists = await con.fetchval("SELECT id FROM users WHERE id = $1", uid)
        if not exists:
            return fail(404, "USER_NOT_FOUND", "User not found")
        await con.execute("UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1", uid)
        await con.execute("DELETE FROM recovery_codes WHERE user_id = $1", uid)
    return JSONResponse({"ok": True})


@app.post("/api/users/{user_id}/lock")
async def api_lock_user(request: Request, user_id: str) -> Response:
    """Manual, indefinite lock — the deliberate counterpart to the automatic one.

    The automatic lockout expires on its own so a guessable admin username
    cannot be used to disable the dashboard for good. When an admin genuinely
    wants an account held shut, this is the flag that does it.
    """
    session = _require_admin(request)
    _require_db()
    uid = _path_id(user_id)
    if uid == session["user_id"]:
        return fail(400, "SELF_LOCK", "You cannot lock your own account")
    async with db.transaction() as con:
        target = await con.fetchrow("SELECT role FROM users WHERE id = $1 FOR UPDATE", uid)
        if not target:
            return fail(404, "USER_NOT_FOUND", "User not found")
        if target["role"] == "admin":
            admins = await con.fetchval("SELECT COUNT(*)::int FROM users WHERE role = 'admin' AND NOT locked")
            if admins <= 1:
                return fail(400, "LAST_ADMIN_LOCK", "The last admin cannot be locked")
        await con.execute("UPDATE users SET locked = TRUE WHERE id = $1", uid)
    return JSONResponse({"ok": True})


@app.put("/api/users/{user_id}/password")
async def api_reset_password(request: Request, user_id: str) -> Response:
    _require_admin(request)
    _require_db()
    uid = _path_id(user_id)
    body = await json_body(request)
    password = body.get("password")
    problem = auth.password_problem(password)
    if problem:
        return fail(400, problem, "Invalid password")

    hashed = await auth.hash_password(password)
    # An admin-forced reset never has the target's OLD plaintext password, so
    # their vault key cannot be re-derived and existing entries would become
    # permanently undecryptable. Wipe them rather than leaving dead ciphertext
    # behind, and rotate the salt for the next login.
    async with db.transaction() as con:
        exists = await con.fetchval("SELECT id FROM users WHERE id = $1", uid)
        if not exists:
            return fail(404, "USER_NOT_FOUND", "User not found")
        await con.execute("DELETE FROM vault_entries WHERE user_id = $1", uid)
        await con.execute(
            """UPDATE users SET hash = $1, vault_salt = $2, failed_attempts = 0,
                   locked_until = NULL, locked = FALSE
                WHERE id = $3""",
            hashed,
            vault.new_salt(),
            uid,
        )
    return JSONResponse({"ok": True, "vaultWiped": True})


@app.put("/api/users/{user_id}/role")
async def api_set_role(request: Request, user_id: str) -> Response:
    _require_admin(request)
    _require_db()
    uid = _path_id(user_id)
    body = await json_body(request)
    role = body.get("role")
    if role not in ("admin", "viewer"):
        return fail(400, "INVALID_ROLE", "Invalid role")

    # The last-admin check and the update must be atomic — otherwise two
    # parallel demotions could both pass the check and leave no admin at all.
    async with db.transaction() as con:
        target = await con.fetchrow("SELECT role FROM users WHERE id = $1 FOR UPDATE", uid)
        if not target:
            return fail(404, "USER_NOT_FOUND", "User not found")
        if target["role"] == "admin" and role != "admin":
            admins = await con.fetchval("SELECT COUNT(*)::int FROM users WHERE role = 'admin'")
            if admins <= 1:
                return fail(400, "LAST_ADMIN_DEMOTE", "The last admin cannot be demoted")
        await con.execute("UPDATE users SET role = $1 WHERE id = $2", role, uid)
    return JSONResponse({"ok": True})


@app.delete("/api/users/{user_id}")
async def api_delete_user(request: Request, user_id: str) -> Response:
    session = _require_admin(request)
    _require_db()
    uid = _path_id(user_id)
    if uid == session["user_id"]:
        return fail(400, "SELF_DELETE", "You cannot delete your own account")

    async with db.transaction() as con:
        target = await con.fetchrow("SELECT role FROM users WHERE id = $1 FOR UPDATE", uid)
        if not target:
            return fail(404, "USER_NOT_FOUND", "User not found")
        if target["role"] == "admin":
            admins = await con.fetchval("SELECT COUNT(*)::int FROM users WHERE role = 'admin'")
            if admins <= 1:
                return fail(400, "LAST_ADMIN_DELETE", "The last admin cannot be deleted")
        # Explicit cleanup before the user row goes: vault_entries,
        # recovery_codes and invite_codes all reference users(id). The invite
        # rows are kept but detached — they are the record of how accounts
        # were created, and losing that on a user deletion would punch a hole
        # in the audit trail.
        await con.execute("DELETE FROM vault_entries WHERE user_id = $1", uid)
        await con.execute("DELETE FROM recovery_codes WHERE user_id = $1", uid)
        await con.execute("UPDATE invite_codes SET created_by = NULL WHERE created_by = $1", uid)
        await con.execute("UPDATE invite_codes SET used_by = NULL WHERE used_by = $1", uid)
        await con.execute("DELETE FROM users WHERE id = $1", uid)

    # The AI service keeps chat history in its own tables, which deliberately
    # carry no foreign key to users(id): one would make the DELETE above fail
    # from a table this repo has never heard of. So the cleanup is an explicit
    # call, made after the commit and best effort. If the AI service is down, its
    # own retention prune sweeps the rows later; failing an account deletion
    # because a chat service is unreachable would be the wrong trade.
    await ai.purge_user(uid, session)
    return JSONResponse({"ok": True})


@app.get("/api/login-attempts")
async def api_login_attempts(request: Request) -> Response:
    """Login audit trail — lets an admin see whether anyone is knocking."""
    _require_admin(request)
    _require_db()
    try:
        limit = int(request.query_params.get("limit", 100))
    except ValueError:
        limit = 100
    limit = min(max(limit, 1), 500)
    rows = await db.fetch(
        """SELECT username, ip, success, kind, created_at
             FROM login_attempts ORDER BY created_at DESC LIMIT $1""",
        limit,
    )
    return JSONResponse(
        [{**dict(r), "created_at": r["created_at"].isoformat()} for r in rows]
    )


@app.get("/api/health/schema")
async def api_schema_health(request: Request) -> Response:
    """Is the schema actually complete?

    Exists because a partially-applied schema is invisible from the UI:
    everything that was already there keeps working, and the only symptom is one
    feature returning 500. This answers the question without shell access to
    PostgreSQL.
    """
    _require_admin(request)
    _require_db()
    missing = await db.missing_tables()
    return JSONResponse(
        {"ok": not missing, "missing": missing, "required": db.REQUIRED_TABLES},
        status_code=503 if missing else 200,
    )
