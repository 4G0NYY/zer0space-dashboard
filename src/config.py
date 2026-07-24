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
from pathlib import Path

SECRETS_DIR = Path(os.environ.get("SECRETS_DIR", "/run/secrets"))


def read_secret(secret_name: str, env_name: str) -> str | None:
    """Swarm secret file first, env var second, ``None`` if neither exists."""
    try:
        value = (SECRETS_DIR / secret_name).read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    return os.environ.get(env_name) or None


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
