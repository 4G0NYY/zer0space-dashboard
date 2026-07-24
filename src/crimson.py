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

import httpx
from fastapi import Request
from fastapi.responses import StreamingResponse

from . import config

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


def build_request_headers(
    request: Request,
    *,
    bearer: str | None = None,
    inject_user: str | None = None,
) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in request.headers.items():
        lk = key.lower()
        if lk in _HOP_BY_HOP:
            continue
        # The zer0space session cookie is this hop's secret; the Crimson
        # upstreams authenticate by their own scheme and must never see it.
        if lk == "cookie":
            continue
        # Ask upstream for identity encoding so we can stream bytes through
        # without having to re-encode.
        if lk == "accept-encoding":
            continue
        # The gateway supplies the Crimson identity (SSO) — never let the client's
        # own Authorization override it.
        if lk == "authorization" and bearer:
            continue
        out[key] = value
    if bearer:
        out["Authorization"] = f"Bearer {bearer}"
    elif inject_user:
        out[config.CRIMSON_USER_HEADER] = inject_user
    return out


def _response_headers(upstream: httpx.Response) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in upstream.headers.items():
        if key.lower() in _HOP_BY_HOP:
            continue
        out[key] = value
    out["content-security-policy"] = CRIMSON_CSP
    # Keep NDJSON flushing through any buffering reverse proxy in front of us.
    out["x-accel-buffering"] = "no"
    return out


def _target(base_url: str, subpath: str, request: Request) -> str:
    target = f"{base_url}/{subpath.lstrip('/')}"
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
) -> StreamingResponse:
    """Forward ``request`` to ``base_url``/``subpath`` and stream the reply back."""
    body = await request.body()
    headers = build_request_headers(request, bearer=bearer, inject_user=inject_user)
    upstream = await open_upstream(request, base_url, subpath, body, headers)
    return stream_response(upstream)
