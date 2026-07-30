"""Gateway to the zer0space AI service.

The assistant itself lives in a separate service (github.com/zer0space-net/zer0space-ai)
that is stateless, scalable and deliberately unreachable from anywhere but here.
This module is the only thing that talks to it.

The split is the point. The dashboard is pinned to ``replicas: 1`` because its
session store holds per-user vault keys in process memory; the AI service holds
nothing, so it can scale. Keeping the model calls out of this process also keeps
a slow streaming answer from occupying the single dashboard worker.

What this module does:

* gates every AI route on the existing session, so the AI service never has to
  know what a zer0space session is,
* forwards who is asking in headers the AI service trusts,
* attaches the live cluster snapshot to a chat request, because ``metrics.py``
  here is the authoritative view of the cluster and duplicating it over there
  would produce a second, disagreeing implementation,
* streams the answer back untouched.

The shared token is resolved the same way ``session_secret`` and ``totp_enc_key``
are: Swarm secret, then env var, then a row in ``settings``, then generated and
stored. That last step is what lets both services agree with no configuration at
all on a fresh deployment, since they read the same row.
"""

from __future__ import annotations

import json
import secrets
from typing import Any, AsyncIterator

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import config, db

# Filled during startup by resolve_service_token().
_token: str = ""
_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            # No read timeout: a chat answer streams for as long as the model
            # keeps talking, and a read timeout here would cut long answers off
            # mid-sentence. The AI service enforces its own wall-clock deadline,
            # so this connection cannot hang forever.
            timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0),
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
            follow_redirects=False,
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


async def resolve_service_token() -> str:
    """Swarm secret file, then env var, then the DB, then generated and stored.

    Same chain as ``resolve_totp_key`` in main.py and for the same reason: a
    value that arrives from a Swarm secret or an env var is used as-is and is NOT
    written back, so a stale auto-generated row cannot clobber the real,
    restart-surviving value on the next boot.
    """
    global _token
    material, source = config.read_secret_source("ai_service_token", "AI_SERVICE_TOKEN")
    if not material:
        row = await db.fetchrow("SELECT value FROM settings WHERE key = 'ai_service_token'")
        if row and row["value"]:
            material, source = row["value"], "database"
    if not material:
        generated = secrets.token_hex(32)
        # ON CONFLICT guards the race where the dashboard and an AI replica start
        # at the same moment: the loser keeps the winner's value instead of
        # overwriting it, which would leave the two unable to talk to each other.
        material = await db.fetchval(
            """INSERT INTO settings (key, value) VALUES ('ai_service_token', $1)
                ON CONFLICT (key) DO UPDATE SET value = settings.value
                RETURNING value""",
            generated,
        )
        source = "auto-generated"
    print(f"[config] ai_service_token loaded from: {source}")
    _token = material
    return material


def configured() -> bool:
    """Is the gateway wired up at all?

    False means /api/ai/* answers 503 and the AI entry stays out of the sidebar,
    which is the correct behaviour on a deployment that has not opted in.
    """
    return bool(config.AI_SERVICE_URL and _token)


def _headers(session: Any, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Auth for the AI service plus the caller identity it trusts.

    The identity comes from the server-side session, never from anything the
    browser sent, which is what makes it safe for the AI service to treat these
    headers as authoritative.
    """
    headers = {
        config.AI_TOKEN_HEADER: _token,
        "x-zer0space-user-id": str(session.get("user_id")),
        "x-zer0space-user-name": str(session.get("username") or ""),
        "x-zer0space-user-role": str(session.get("role") or "viewer"),
        "content-type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def unavailable(err: Exception | None = None) -> JSONResponse:
    """Clean 503 when the AI service cannot be reached.

    The usual cause is the ai service not being up yet, or not sharing the
    overlay network. Logged so it is diagnosable, and given its own code so the
    client can say something more useful than "internal error".
    """
    if err is not None:
        print(f"[ai] service unreachable: {err!r}")
    return JSONResponse(
        {
            "error": "The AI service is not reachable right now.",
            "code": "AI_UNREACHABLE",
        },
        status_code=503,
    )


async def call(
    method: str,
    path: str,
    session: Any,
    *,
    body: dict[str, Any] | None = None,
    params: dict[str, str] | None = None,
) -> Response:
    """Forward a non-streaming request and pass the answer back verbatim.

    The AI service already answers with the dashboard's error shape (an ``error``
    string and a stable ``code``), so its responses need no translation: the
    browser resolves an ``AI_*`` code through i18n.js exactly like any other.
    """
    if not configured():
        return JSONResponse(
            {
                "error": "The AI assistant is not configured for this deployment.",
                "code": "AI_NOT_CONFIGURED",
            },
            status_code=503,
        )

    url = f"{config.AI_SERVICE_URL}{path}"
    try:
        response = await client().request(
            method,
            url,
            headers=_headers(session),
            json=body,
            params=params,
            timeout=httpx.Timeout(connect=5.0, read=60.0, write=30.0, pool=5.0),
        )
    except httpx.HTTPError as err:
        return unavailable(err)

    # Content-type is echoed rather than assumed: a 204 has no body at all, and
    # inventing application/json for it produces a parse error in the browser.
    media_type = response.headers.get("content-type", "application/json")
    if response.status_code == 204 or not response.content:
        return Response(status_code=response.status_code)
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=media_type,
        headers={"cache-control": "no-store"},
    )


async def stream_chat(request: Request, session: Any, body: dict[str, Any]) -> Response:
    """Forward a chat request and stream the Server-Sent Events back.

    Errors that happen before the upstream responds can still be an HTTP status.
    Once the stream is open they cannot, so the AI service reports them as
    ``error`` events inside the stream and this function simply relays whatever
    arrives.
    """
    if not configured():
        return JSONResponse(
            {
                "error": "The AI assistant is not configured for this deployment.",
                "code": "AI_NOT_CONFIGURED",
            },
            status_code=503,
        )

    url = f"{config.AI_SERVICE_URL}/api/chat"
    upstream_request = client().build_request(
        "POST", url, headers=_headers(session), json=body
    )
    try:
        upstream = await client().send(upstream_request, stream=True)
    except httpx.HTTPError as err:
        return unavailable(err)

    if upstream.status_code >= 400:
        # A failure before the stream started: read the body and hand the AI
        # service's own error shape back, rather than opening an SSE stream whose
        # first and only event is a failure the client has to special-case.
        try:
            await upstream.aread()
            content = upstream.content
        finally:
            await upstream.aclose()
        return Response(
            content=content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    async def relay() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type="text/event-stream",
        headers={
            "cache-control": "no-store",
            # Keeps events flushing through the Cloudflare tunnel and any other
            # buffering hop, which is the difference between a live typewriter
            # effect and the whole answer arriving at once when it finishes.
            "x-accel-buffering": "no",
        },
    )


async def purge_user(user_id: int, session: Any) -> None:
    """Delete a user's conversations when their account is deleted.

    Called from the account deletion route. It is best effort on purpose: the
    account deletion has already committed by the time this runs, and failing the
    whole request because the AI service is down would leave an admin unable to
    remove an account for a reason that has nothing to do with accounts.

    This is also why ai_conversations has no foreign key to users(id) over in the
    AI service: a constraint there would make the DELETE itself fail instead.
    Anything missed here is swept up by that service's retention prune.
    """
    if not configured():
        return
    try:
        await client().delete(
            f"{config.AI_SERVICE_URL}/api/conversations",
            headers=_headers(session),
            params={"userId": str(user_id)},
            timeout=httpx.Timeout(10.0),
        )
    except httpx.HTTPError as err:
        print(
            f"[ai] could not purge conversations for deleted user {user_id}: {err!r}. "
            "They will be removed by the AI service's retention prune."
        )


def parse_event(payload: str) -> dict[str, Any]:
    """Parse one SSE payload. Used by tests and by the health probe."""
    try:
        parsed = json.loads(payload)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
