"""Runtime configuration.

Everything the process needs to know about its environment is resolved here,
once, at import time — so the rest of the code never reads ``os.environ``
directly and there is exactly one place to look when a deployment behaves
differently than expected.

Secret resolution order is **Docker Swarm secret file -> environment variable**,
never the other way round. A secret mounted at ``/run/secrets/<name>`` is the
authoritative value; the env var exists only so local development works without
a Swarm. This is why no password appears in ``docker-compose.yml``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Any

SECRETS_DIR = Path(os.environ.get("SECRETS_DIR", "/run/secrets"))


def read_secret_source(secret_name: str, env_name: str) -> tuple[str | None, str | None]:
    """Resolve a secret and report where it came from.

    Same order as :func:`read_secret` — Swarm secret file first, env var second —
    but returns ``(value, source)`` where ``source`` is ``"swarm secret"``,
    ``"env"`` or ``None``. Used where the boot log should state which persistent
    source a key actually came from, so an operator can confirm at a glance that
    a restart-surviving key is in effect rather than an ephemeral one.
    """
    try:
        value = (SECRETS_DIR / secret_name).read_text(encoding="utf-8").strip()
        if value:
            return value, "swarm secret"
    except OSError:
        pass
    env = os.environ.get(env_name)
    if env:
        return env, "env"
    return None, None


def read_secret(secret_name: str, env_name: str) -> str | None:
    """Swarm secret file first, env var second, ``None`` if neither exists."""
    return read_secret_source(secret_name, env_name)[0]


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default


# --- Standalone hosts -------------------------------------------------------


@dataclass(frozen=True)
class ExtraHost:
    """A machine that runs Glances but is deliberately not a Swarm member.

    zs-state-01 (PostgreSQL) and zs-store-01 (NFS) sit outside the cluster, so
    they never appear in the Docker API's ``/nodes`` and used to go unmonitored
    — which is backwards, since the database and the shared storage are the two
    hosts whose failure takes everything else with them.
    """

    hostname: str
    addr: str
    label: str | None = None


def parse_extra_hosts(raw: str | None) -> list[ExtraHost]:
    """``name:ip[:label],name:ip[:label]`` -> list of hosts.

    A malformed entry is logged and skipped rather than raised: one typo in an
    environment variable must not cost the whole list, and it must certainly not
    take the dashboard down at boot.
    """
    out: list[ExtraHost] = []
    if not raw or not raw.strip():
        return out
    for entry in raw.split(","):
        part = entry.strip()
        if not part:
            continue
        pieces = [p.strip() for p in part.split(":")]
        name = pieces[0] if len(pieces) > 0 else ""
        addr = pieces[1] if len(pieces) > 1 else ""
        label = pieces[2] if len(pieces) > 2 and pieces[2] else None
        if not name or not addr:
            print(f'[config] EXTRA_HOSTS: ignoring malformed entry "{part}" (expected name:ip[:label])')
            continue
        out.append(ExtraHost(hostname=name, addr=addr, label=label))
    return out


# --- Database ---------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL") or None
DB_HOST = os.environ.get("DB_HOST", "192.168.0.16")
DB_PORT = _int("DB_PORT", 5432)
DB_NAME = os.environ.get("DB_NAME", "zer0space")
DB_USER = os.environ.get("DB_USER", "dashboard")
DB_PASS = read_secret("db_password", "DB_PASS")

DB_POOL_MIN = _int("DB_POOL_MIN", 1)
DB_POOL_MAX = _int("DB_POOL_MAX", 10)


def describe_db_target() -> str:
    """Safe-to-log description of where we are connecting. Never the password."""
    if DATABASE_URL:
        return "DATABASE_URL (credentials hidden)"
    return f"{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}"


# --- Sessions ---------------------------------------------------------------

SESSION_SECRET = read_secret("session_secret", "SESSION_SECRET")
SESSION_COOKIE = "zs.sid"

# Encrypts users.totp_secret at rest (AES-256-GCM). Same resolution order and
# same auto-generate-and-persist fallback as SESSION_SECRET — see
# main.resolve_totp_key(). Deliberately a separate secret from SESSION_SECRET:
# rotating one must not silently invalidate the other.
TOTP_ENC_KEY = read_secret("totp_enc_key", "TOTP_ENC_KEY")
# 24h. The session holds the derived vault key, so this is also the window in
# which a stolen session cookie could decrypt the vault.
SESSION_MAX_AGE = _int("SESSION_MAX_AGE", 24 * 60 * 60)

# HSTS + upgrade-insecure-requests + Secure cookie. Defaults to false so plain
# HTTP on the LAN (http://node:8080) keeps working — once a browser stores an
# HSTS entry it upgrades every later request and the page breaks.
FORCE_HTTPS = _bool("FORCE_HTTPS", False)
COOKIE_SECURE = FORCE_HTTPS or _bool("COOKIE_SECURE", False)

# Behind the Cloudflare Tunnel every request arrives from the tunnel container,
# so the socket address is useless for per-IP rate limiting and cf-connecting-ip
# is the value to trust. Set to false when the dashboard is exposed directly,
# where that header would be attacker-controlled.
TRUST_PROXY = _bool("TRUST_PROXY", True)

# Which peers are allowed to speak for someone else via cf-connecting-ip /
# x-forwarded-for. TRUST_PROXY alone is not enough: it says "read the header",
# not "and only from the tunnel". With this list empty the header is taken from
# any peer, which is what let anyone reachable on the LAN port forge a fresh
# source address per request and walk straight through the per-IP rate limits.
#
# Comma-separated CIDRs, e.g. "10.0.0.0/8". Entries that do not parse are logged
# and skipped rather than raised: one typo must not take the dashboard down at
# boot, and the failure mode of skipping is "trust less", not "trust more".
def _parse_networks(raw: str | None) -> list[Any]:
    out: list[Any] = []
    for piece in (raw or "").split(","):
        entry = piece.strip()
        if not entry:
            continue
        try:
            out.append(ip_network(entry, strict=False))
        except ValueError:
            print(f'[config] TRUSTED_PROXY_IPS: ignoring malformed entry "{entry}"')
    return out


TRUSTED_PROXY_IPS = _parse_networks(os.environ.get("TRUSTED_PROXY_IPS"))


def peer_is_trusted_proxy(addr: str | None) -> bool:
    """May this immediate peer speak for another address?

    An empty TRUSTED_PROXY_IPS means "no list configured", which preserves the
    previous behaviour of trusting the header from anyone. An unparseable peer
    address is never trusted.
    """
    if not TRUSTED_PROXY_IPS:
        return True
    if not addr:
        return False
    try:
        parsed = ip_address(addr)
    except ValueError:
        return False
    return any(parsed in net for net in TRUSTED_PROXY_IPS)

# The address the dashboard is publicly reachable at, e.g.
# "https://zer0space.com". When set it is the source of truth for the
# X-Forwarded-Proto / X-Forwarded-Host the Crimson gateway hands its backend,
# which otherwise come from the client's own Host header and steer the absolute
# stream URLs the backend generates. Unset keeps the previous header-derived
# behaviour, so this is inert until a deployment opts in.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/") or None

# Host header allow list. Empty disables the check and keeps current behaviour;
# set it in production so a forged Host cannot reach request-handling code at
# all. Comma-separated; a leading "." works as a subdomain wildcard.
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]

# --- Metrics ----------------------------------------------------------------

DOCKER_PROXY_URL = os.environ.get("DOCKER_PROXY_URL", "http://socketproxy:2375").rstrip("/")
GLANCES_SERVICE = os.environ.get("GLANCES_SERVICE", "dashboard_glances")
GLANCES_PORT = _int("GLANCES_PORT", 61208)
METRICS_TIMEOUT = float(os.environ.get("METRICS_TIMEOUT", "4.0"))
EXTRA_HOSTS = parse_extra_hosts(os.environ.get("EXTRA_HOSTS"))

# --- Files ------------------------------------------------------------------
# The dashboard holds no database state of its own (that lives in PostgreSQL on
# zs-state-01), but /data still holds files that are not DB rows.

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
BACKGROUND_DIR = DATA_DIR / "background"
BACKUP_STATUS_DIR = Path(os.environ.get("BACKUP_STATUS_DIR", str(DATA_DIR / "backup-status")))
# A backup older than this counts as stale. 26h rather than 24h so a nightly job
# that runs an hour late does not light up the tile.
BACKUP_STALE_SECONDS = _int("BACKUP_STALE_HOURS", 26) * 3600

# --- Application ------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

PORT = _int("PORT", 3000)
# Serve the maintenance page instead of the app. Deliberately an env flag rather
# than a DB setting: the case you need it for is "the database is unreachable".
MAINTENANCE_MODE = _bool("MAINTENANCE_MODE", False)

GITHUB_URL = os.environ.get("GITHUB_URL", "https://github.com/zer0space-net")
STATUS_URL = os.environ.get("STATUS_URL", "https://status.zer0space.com")

# --- Crimson gateway --------------------------------------------------------
# zer0space ✕ Crimson (the Crimson Haven frontend, github.com/crimsonhaven-to)
# is served at /crimson, gated on the zer0space session and reverse-proxied by
# this dashboard — the SPA to CRIMSON_CLIENT_URL and its /crimson/api calls to
# CRIMSON_API_URL. Both must be set for the gateway to mount; when either is
# unset /crimson simply 404s and the dashboard behaves exactly as before, so
# this is inert until a deployment opts in.
CRIMSON_PATH = "/crimson"
CRIMSON_CLIENT_URL = os.environ.get("CRIMSON_CLIENT_URL", "").rstrip("/") or None
CRIMSON_API_URL = os.environ.get("CRIMSON_API_URL", "").rstrip("/") or None
CRIMSON_ENABLED = bool(CRIMSON_CLIENT_URL and CRIMSON_API_URL)
# Forwarded to the backend as the per-user identity for the SSO bridge (phase 6).
# Header name the backend trusts for a gateway-authenticated user; empty = off.
CRIMSON_USER_HEADER = os.environ.get("CRIMSON_USER_HEADER", "X-Zer0space-User")

# --- Crimson SSO broker -----------------------------------------------------
# Gives each zer0space user a real, persistent Crimson account so /account/*
# (favorites, progress, continue-watching) syncs across devices — without any
# Crimson login screen. The dashboard derives a deterministic Ed25519 key per
# user from this secret (Crimson auth is challenge/signature, so the server only
# ever sees the public key), registers/logs the account in on the backend, and
# injects the returned Bearer when proxying /crimson/api.
#
# Off unless the secret AND an invite code are set — then /crimson still works,
# just without per-user accounts. The invite code must be one the backend's
# SIGNUP_INVITE_CODE accepts (needed once per user, at first sign-in).
CRIMSON_SSO_SECRET = read_secret("crimson_sso_secret", "CRIMSON_SSO_SECRET")
CRIMSON_SSO_INVITE_CODE = os.environ.get("CRIMSON_SSO_INVITE_CODE", "") or None
CRIMSON_SSO_ENABLED = bool(CRIMSON_ENABLED and CRIMSON_SSO_SECRET and CRIMSON_SSO_INVITE_CODE)

# --- AI assistant -----------------------------------------------------------
# The assistant lives in a separate service (github.com/zer0space-net/zer0space-ai)
# that this dashboard gates and proxies at /api/ai/*. Only the *address* is
# configured here: everything about the assistant itself (provider, model, API
# keys, system prompt, context toggles) lives in PostgreSQL and is edited by an
# admin in the dashboard, so changing the model is a dropdown and not a redeploy.
#
# Blank turns the whole feature off: /api/ai/* answers 503 and the AI chat panel
# stays hidden, so this is inert until a deployment opts in.
AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://ai:8000").rstrip("/") or None
# Header the AI service checks. Its counterpart secret is resolved in ai.py with
# the same chain as session_secret: Swarm secret, env var, DB row, generated.
AI_TOKEN_HEADER = "x-zer0space-ai-token"
AI_ENABLED = bool(AI_SERVICE_URL)
