"""PostgreSQL access layer (asyncpg).

The dashboard holds **no state of its own**: users, services, settings, vault
entries and the login audit trail all live in PostgreSQL on zs-state-01, which
is why the service can be scheduled onto any Swarm node instead of being pinned
to one host.

All SQL in this project is parameterised with ``$1``/``$2`` placeholders. There
is no ORM and no query builder — and no string concatenation into SQL, ever.

The pool is created lazily in :func:`connect` and may be ``None``: the app boots
even when PostgreSQL is unreachable so the login page, the metrics and the
backup card still work, and :func:`retry_in_background` heals the connection on
its own once the database comes back. Every DB-backed route answers 503 in the
meantime rather than the process dying at startup.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Sequence

import asyncpg

from . import config

# Tables the application cannot work without. Verified after the schema runs so
# a partially-applied bootstrap is reported loudly instead of surfacing weeks
# later as one feature returning 500.
REQUIRED_TABLES = [
    "users",
    "settings",
    "services",
    "vault_entries",
    "invite_codes",
    "login_attempts",
]

_pool: asyncpg.Pool | None = None
_ready = False

# Failures that mean "the database is not reachable" rather than "the query was
# wrong". They are answered with 503, not 500, and they flip the pool back to
# not-ready so retry_in_background picks the connection up again.
#
# Built defensively rather than referencing asyncpg's names directly: the
# SQLSTATE-derived exception classes are generated, and a missing attribute here
# would be an ImportError at startup — the single worst place to discover a
# version difference.
CONNECTION_ERRORS: tuple[type[BaseException], ...] = tuple(
    exc
    for exc in (
        getattr(asyncpg, "PostgresConnectionError", None),
        getattr(asyncpg, "InterfaceError", None),
        getattr(asyncpg, "CannotConnectNowError", None),
        ConnectionError,
        OSError,
        TimeoutError,
    )
    if isinstance(exc, type) and issubclass(exc, BaseException)
)


class DatabaseUnavailable(RuntimeError):
    """The database is not reachable.

    Every connection-level failure is converted into this ONE exception type
    before it leaves this module. That is what lets ``main.py`` answer 503 with
    a single handler instead of registering one for ``OSError`` — which would
    quietly turn every unrelated file or socket error in the process into
    "database unavailable".
    """


def _mark_not_ready() -> None:
    global _ready
    _ready = False


def _as_unavailable(err: BaseException) -> DatabaseUnavailable:
    _mark_not_ready()
    return DatabaseUnavailable(str(err) or err.__class__.__name__)


def is_ready() -> bool:
    return _ready and _pool is not None


def _connect_kwargs() -> dict[str, Any]:
    if config.DATABASE_URL:
        return {"dsn": config.DATABASE_URL}
    return {
        "host": config.DB_HOST,
        "port": config.DB_PORT,
        "database": config.DB_NAME,
        "user": config.DB_USER,
        "password": config.DB_PASS,
    }


async def connect(attempts: int = 5, delay: float = 2.0) -> bool:
    """Open the pool, retrying with a short backoff.

    Returns True on success. A briefly-unavailable PostgreSQL (a restart, a slow
    boot on zs-state-01) must not take the dashboard down with it.
    """
    global _pool, _ready
    for i in range(1, attempts + 1):
        try:
            _pool = await asyncpg.create_pool(
                min_size=config.DB_POOL_MIN,
                max_size=config.DB_POOL_MAX,
                command_timeout=15,
                timeout=5,
                **_connect_kwargs(),
            )
            _ready = True
            return True
        except Exception as err:  # noqa: BLE001 — any failure here is "not reachable"
            last = i == attempts
            suffix = "" if last else f" — retrying in {delay}s"
            print(f"[db] connection attempt {i}/{attempts} failed: {err}{suffix}")
            if not last:
                await asyncio.sleep(delay)
    _pool = None
    _ready = False
    return False


async def close() -> None:
    global _pool, _ready
    if _pool is not None:
        await _pool.close()
    _pool = None
    _ready = False


def _require_pool() -> asyncpg.Pool:
    if _pool is None:
        raise DatabaseUnavailable("no database connection")
    return _pool


async def execute(sql: str, *args: Any) -> str:
    global _ready
    try:
        result = await _require_pool().execute(sql, *args)
        _ready = True
        return result
    except CONNECTION_ERRORS as err:
        raise _as_unavailable(err) from err


async def fetch(sql: str, *args: Any) -> list[asyncpg.Record]:
    global _ready
    try:
        rows = await _require_pool().fetch(sql, *args)
        _ready = True
        return rows
    except CONNECTION_ERRORS as err:
        raise _as_unavailable(err) from err


async def fetchrow(sql: str, *args: Any) -> asyncpg.Record | None:
    global _ready
    try:
        row = await _require_pool().fetchrow(sql, *args)
        _ready = True
        return row
    except CONNECTION_ERRORS as err:
        raise _as_unavailable(err) from err


async def fetchval(sql: str, *args: Any) -> Any:
    row = await fetchrow(sql, *args)
    if row is None:
        return None
    return row[0]


def transaction():
    """``async with db.transaction() as con:`` — a dedicated connection.

    Every statement inside the block must use that connection, not the module
    level helpers, or it silently runs outside the transaction.
    """
    return _Transaction(_require_pool())


class _Transaction:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool
        self._con: asyncpg.Connection | None = None
        self._tx = None

    async def __aenter__(self) -> asyncpg.Connection:
        try:
            self._con = await self._pool.acquire()
            self._tx = self._con.transaction()
            await self._tx.start()
        except CONNECTION_ERRORS as err:
            if self._con is not None:
                await self._pool.release(self._con)
                self._con = None
            raise _as_unavailable(err) from err
        return self._con

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        assert self._con is not None and self._tx is not None
        try:
            if exc_type is None:
                await self._tx.commit()
            else:
                # A rollback on a connection that is already gone raises again;
                # the original exception is the one worth propagating.
                try:
                    await self._tx.rollback()
                except CONNECTION_ERRORS:
                    _mark_not_ready()
        except CONNECTION_ERRORS as err:
            raise _as_unavailable(err) from err
        finally:
            await self._pool.release(self._con)
        # False: never swallow the exception that caused the rollback.
        return False


# --- Schema -----------------------------------------------------------------
#
# Idempotent: safe to run on every start. Creates the tables on a fresh database
# and adds later columns to an existing one. There is no migration framework —
# schema changes go in here and must stay backwards-compatible with deployments
# that already have data.

SCHEMA = """
CREATE TABLE IF NOT EXISTS services (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'grid',
  status      TEXT NOT NULL DEFAULT 'unknown',
  -- Which sidebar section the tile appears under. 'general' keeps every service
  -- that predates this column visible on the home view instead of silently
  -- vanishing into a section nobody opened yet.
  category    TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  hash            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'viewer',
  theme           TEXT DEFAULT NULL,
  vault_salt      TEXT DEFAULT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ DEFAULT NULL,
  locked          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_entries (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  username           TEXT NOT NULL DEFAULT '',
  encrypted_password TEXT NOT NULL DEFAULT '',
  encrypted_notes    TEXT NOT NULL DEFAULT '',
  url                TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id);

CREATE TABLE IF NOT EXISTS invite_codes (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by    INTEGER REFERENCES users(id) DEFAULT NULL,
  used_at    TIMESTAMPTZ DEFAULT NULL,
  max_role   TEXT NOT NULL DEFAULT 'viewer'
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         SERIAL PRIMARY KEY,
  username   TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  success    BOOLEAN NOT NULL DEFAULT FALSE,
  kind       TEXT NOT NULL DEFAULT 'login',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip   ON login_attempts(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role            TEXT NOT NULL DEFAULT 'viewer';
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme           TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_salt      TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'login';
ALTER TABLE services ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';
"""


def _split_statements(schema: str) -> list[str]:
    """Split the schema into individual statements, comments stripped first.

    A ``--`` comment containing a semicolon would otherwise cut a statement in
    half. Safe here because no string literal in the schema contains ``--``.
    """
    stripped = "\n".join(re.sub(r"--.*$", "", line) for line in schema.splitlines())
    return [s.strip() for s in stripped.split(";") if s.strip()]


async def init_schema() -> dict[str, list]:
    """Apply the schema one statement at a time and verify the result.

    Statements are executed **individually**, not as one multi-statement string.
    That matters more than it looks: a batch runs in an implicit transaction, so
    one failing statement silently rolls back every other statement with it. On
    a database that already has the older tables the result is confusing —
    everything that existed before keeps working, a newly added table is simply
    missing, and the only symptom is one feature returning 500.
    """
    failures: list[dict[str, str]] = []
    for stmt in _split_statements(SCHEMA):
        try:
            await execute(stmt)
        except DatabaseUnavailable:
            # The database went away. No point grinding through the rest, and
            # the caller needs to see it.
            raise
        except Exception as err:  # noqa: BLE001
            first = stmt.splitlines()[0][:80]
            failures.append({"statement": first, "message": str(err)})
            print(f"[db] schema statement failed: {first} … — {err}")

    await execute(
        "INSERT INTO settings (key, value) VALUES ('theme', 'aurora') ON CONFLICT (key) DO NOTHING"
    )

    rows = await fetch(
        """SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ANY($1::text[])""",
        REQUIRED_TABLES,
    )
    present = {r["table_name"] for r in rows}
    missing = [t for t in REQUIRED_TABLES if t not in present]

    if missing:
        print(
            f"[db] SCHEMA INCOMPLETE — missing table(s): {', '.join(missing)}. "
            "Features backed by them will fail. Check the statement errors above "
            "and that the database user may CREATE TABLE."
        )
    elif failures:
        print(
            f"[db] schema applied with {len(failures)} non-fatal statement error(s) "
            "— all required tables present"
        )
    return {"missing": missing, "failures": failures}


async def retry_in_background(interval: float = 30.0) -> None:
    """Heal the connection on its own once PostgreSQL comes back.

    Runs for the lifetime of the process. Without it a database that was down at
    boot would need a container restart to be picked up, which is exactly the
    manual step you do not want during an outage.
    """
    while True:
        await asyncio.sleep(interval)
        if is_ready():
            continue
        try:
            if _pool is None:
                if not await connect(attempts=1):
                    continue
            await init_schema()
            print("[db] PostgreSQL reachable again — schema verified, DB routes are live")
        except Exception as err:  # noqa: BLE001
            print(f"[db] still unreachable: {err}")


async def missing_tables() -> list[str]:
    rows = await fetch(
        """SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ANY($1::text[])""",
        REQUIRED_TABLES,
    )
    present = {r["table_name"] for r in rows}
    return [t for t in REQUIRED_TABLES if t not in present]


def rows_to_dicts(rows: Sequence[asyncpg.Record]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]
