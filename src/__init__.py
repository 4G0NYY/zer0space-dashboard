"""zer0space dashboard — FastAPI backend.

Module map:

* ``config``  — environment and Swarm secrets, resolved once at import
* ``db``      — asyncpg pool, idempotent schema bootstrap, query helpers
* ``auth``    — sessions, rate limiting, lockout, CSRF, password policy
* ``vault``   — PBKDF2 key derivation + AES-256-GCM, unchanged wire format
* ``metrics`` — Docker socket proxy + Glances polling, status tiles
* ``main``    — the FastAPI app: middleware, routes, lifespan
"""
