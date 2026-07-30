"""Reverse proxy for the zer0space ✕ Crimson gateway.

zer0space ✕ Crimson is the zer0space-styled frontend for **Crimson Haven**
(https://github.com/crimsonhaven-to). It has no login of its own: this dashboard
gates ``/crimson`` on the zer0space session and reverse-proxies it —

    /crimson, /crimson/<asset>   -> CRIMSON_CLIENT_URL   (the static SPA)
    /crimson/api/<path>          -> CRIMSON_API_URL       (the Crimson backend)

so a signed-in zer0space user reaches Crimson at the same origin (no CORS) and
nobody else does. The gate itself lives in main.py; this module only forwards.

Two things it is careful about:

* **Streaming.** The backend's ``/watch`` emits progressive NDJSON, one line per
  source as it resolves. Responses are streamed, never buffered, and carry
  ``x-accel-buffering: no`` so the line flushes through immediately.
* **The zer0space session cookie never leaves this hop.** It is stripped before
  forwarding, so the Crimson upstreams never see it.

Media bytes are NOT proxied here — the Crimson design sends stream segments
CDN → crimson-proxy → viewer directly (Cloudflare ToS §2.8), so only API/JSON and
the small static SPA pass through the dashboard.
"""

from __future__ import annotations

from typing import AsyncIterator
from urllib.parse import urlsplit

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import config


def bad_gateway(err: Exception) -> JSONResponse:
    """Clean 502 when a Crimson upstream can't be reached, instead of a bare 500.

    The usual cause is the crimson-backend / crimson-client stack not being up
    (or the overlay between nodes being unreachable). Logged so it's diagnosable.
    """
    print(f"[crimson] upstream unreachable: {err!r}")
    return JSONResponse(
        {
            "error": "Crimson is temporarily unreachable — the backend or client "
            "service may still be starting.",
            "code": "CRIMSON_UNREACHABLE",
        },
        status_code=502,
    )

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            # No read timeout: /watch is a long-lived NDJSON stream that stays
            # open while later sources keep resolving. Connect/write/pool are
            # still bounded so a dead upstream fails fast.
            timeout=httpx.Timeout(connect=10.0, read=None, write=30.0, pool=10.0),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=24),
            follow_redirects=False,
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


# A streaming aggregator reaches many hosts for posters (TMDB), media and iframe
# embeds — deliberately looser than the dashboard's own CSP, and scoped to the
# proxied /crimson responses only. Set here so the dashboard's append-only
# SecurityHeadersMiddleware leaves it untouched.
CRIMSON_CSP = "; ".join(
    [
        "default-src 'self'",
        "base-uri 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' https:",
        "frame-src https:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "frame-ancestors 'none'",
    ]
)

# Never copied through in either direction — connection-scoped or recomputed.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
    "content-length",
    "host",
}


# Forwarded headers we recompute ourselves (below) — drop any the client or an
# upstream CDN already set so the backend can't see a stale/spoofed value, and so
# we never emit the same header twice in different letter-casing.
_MANAGED_FORWARDED = {
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-prefix",
}


class UnsafePath(ValueError):
    """A subpath tried to escape the upstream mount point with ``..``."""


def _client_strip_set() -> set[str]:
    """Header names a client may never supply to an upstream, lower-cased.

    ``authorization`` and the identity header are in here **unconditionally**,
    not only on the branch where the gateway is about to set its own value. Both
    name who the caller is and the backend trusts them, so a client-supplied copy
    is an identity claim rather than a preference. Leaving either through on the
    branch that happens not to overwrite it is how a viewer reaches another
    user's Crimson account.
    """
    names = set(_HOP_BY_HOP) | set(_MANAGED_FORWARDED)
    # This hop's secret. The Crimson upstreams authenticate by their own scheme
    # and must never see the zer0space session.
    names.add("cookie")
    # Ask upstream for identity encoding so bytes stream through unmodified.
    names.add("accept-encoding")
    names.add("authorization")
    if config.CRIMSON_USER_HEADER:
        names.add(config.CRIMSON_USER_HEADER.lower())
    return names


def _forwarded_origin(request: Request) -> tuple[str, str]:
    """The (scheme, host) the backend should believe it is publicly reachable at.

    Prefers PUBLIC_BASE_URL, because ``Host`` and ``X-Forwarded-Proto`` are both
    client-controlled on any request that did not come through the tunnel, and
    the backend turns these into the absolute stream URLs it hands the player.
    Configuration is the only source here an attacker cannot set.
    """
    if config.PUBLIC_BASE_URL:
        parsed = urlsplit(config.PUBLIC_BASE_URL)
        if parsed.scheme and parsed.netloc:
            return parsed.scheme, parsed.netloc
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host") or request.url.netloc
    return proto.split(",")[0].strip(), host


def build_request_headers(
    request: Request,
    *,
    bearer: str | None = None,
    inject_user: str | None = None,
    forwarded_prefix: str | None = None,
) -> dict[str, str]:
    # Keys are lower-cased on the way in. HTTP header names are case-insensitive
    # but a dict is not, so mixing casings previously let a client-supplied
    # ``x-zer0space-user`` survive alongside the gateway's own
    # ``X-Zer0space-User``, and both went out on the wire.
    strip = _client_strip_set()
    out: dict[str, str] = {}
    for key, value in request.headers.items():
        lk = key.lower()
        if lk in strip:
            continue
        out[lk] = value

    # Tell the backend its *public* address, so the absolute stream/proxy URLs it
    # emits (e.g. the same-origin ``/voe_proxy`` VOE relay, whose CDN token is
    # ASN-bound and can't be served off-origin) point at the public gateway rather
    # than the internal Docker host httpx dialled. Without these the backend falls
    # back to its bind host (``crimson-api:8000``), which no browser can reach —
    # the classic "player stays grey at 0:00" cause. X-Forwarded-Prefix carries the
    # gateway mount so the emitted path includes it (``/crimson/api/voe_proxy``).
    proto, host = _forwarded_origin(request)
    out["x-forwarded-proto"] = proto
    out["x-forwarded-host"] = host
    if forwarded_prefix:
        out["x-forwarded-prefix"] = "/" + forwarded_prefix.strip("/")

    if bearer:
        out["authorization"] = f"Bearer {bearer}"
    elif inject_user and config.CRIMSON_USER_HEADER:
        out[config.CRIMSON_USER_HEADER.lower()] = inject_user
    return out


# Relayed from the upstream back to the browser. An allow list, not a deny list:
# these responses are served from the dashboard's own origin, so anything copied
# through speaks with the dashboard's authority. ``set-cookie`` would let a
# Crimson upstream write or clear the zer0space session cookie, and a relayed
# ``access-control-allow-origin`` would hand a third party cross-origin reads of
# this origin. Neither is something an upstream should be able to decide.
_RESPONSE_ALLOW = {
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-range",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "location",
    "retry-after",
    "vary",
}


def _response_headers(upstream: httpx.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in upstream.headers.items():
        if key.lower() in _RESPONSE_ALLOW:
            out[key.lower()] = value
    out["content-security-policy"] = CRIMSON_CSP
    # Keep NDJSON flushing through any buffering reverse proxy in front of us.
    out["x-accel-buffering"] = "no"
    return out


def _target(base_url: str, subpath: str, request: Request) -> str:
    cleaned = subpath.lstrip("/")
    # httpx resolves dot segments per RFC 3986, so ``a/../../x`` would silently
    # become ``/x`` upstream. It cannot cross to another host, but it does let the
    # narrow media-relay routes reach any path on the backend, so the segment is
    # rejected here rather than quietly normalised away.
    if any(segment == ".." for segment in cleaned.split("/")):
        raise UnsafePath(subpath)
    target = f"{base_url}/{cleaned}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return target


async def open_upstream(
    request: Request,
    base_url: str,
    subpath: str,
    body: bytes,
    headers: dict[str, str],
) -> httpx.Response:
    """Send the forwarded request and return the still-open streamed response.

    The caller must either build a StreamingResponse from it via
    ``stream_response`` or ``aclose`` it (e.g. to retry) — exposed separately so
    the SSO path can inspect the status code before committing to the stream.
    """
    upstream_req = client().build_request(
        request.method,
        _target(base_url, subpath, request),
        headers=headers,
        content=body if body else None,
    )
    return await client().send(upstream_req, stream=True)


def stream_response(upstream: httpx.Response) -> StreamingResponse:
    async def stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        stream(),
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )


async def proxy(
    request: Request,
    base_url: str,
    subpath: str,
    *,
    bearer: str | None = None,
    inject_user: str | None = None,
    forwarded_prefix: str | None = None,
) -> Response:
    """Forward ``request`` to ``base_url``/``subpath`` and stream the reply back."""
    body = await request.body()
    headers = build_request_headers(
        request, bearer=bearer, inject_user=inject_user, forwarded_prefix=forwarded_prefix
    )
    try:
        upstream = await open_upstream(request, base_url, subpath, body, headers)
    except UnsafePath:
        return JSONResponse(
            {"error": "Invalid path", "code": "CRIMSON_BAD_PATH"}, status_code=400
        )
    except httpx.RequestError as err:
        return bad_gateway(err)
    return stream_response(upstream)
