#!/usr/bin/env python3
"""Break-glass account unlock.

The situation this exists for: every admin account is locked at the same time.
The automatic lockout expires on its own after 30 minutes, and an admin can
clear another admin's lock from the UI — but if the *only* admin is locked and
somebody set the manual ``users.locked`` flag, there is no path back in through
the browser, because /setup sealed itself when the first account was created.

Run it on a host that can reach PostgreSQL, with the same credentials the
dashboard uses:

    DB_PASS=... python scripts/unlock-user.py --list
    DB_PASS=... python scripts/unlock-user.py --user siro
    DB_PASS=... python scripts/unlock-user.py --all

Inside the running container the password is already mounted as a Swarm secret,
so no environment variable is needed at all:

    docker exec -it <container> python scripts/unlock-user.py --list

It deliberately cannot set a password. Restoring access to a locked account is a
different operation from taking one over, and a script that could do both would
be the most dangerous file in the repository.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Run from a checkout as well as from /app inside the image.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncpg  # noqa: E402

from src import config  # noqa: E402


def _connect_kwargs() -> dict:
    if config.DATABASE_URL:
        return {"dsn": config.DATABASE_URL}
    return {
        "host": config.DB_HOST,
        "port": config.DB_PORT,
        "database": config.DB_NAME,
        "user": config.DB_USER,
        "password": config.DB_PASS,
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Clear dashboard account lockouts.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="show every account and its lock state")
    group.add_argument("--user", metavar="USERNAME", help="unlock one account")
    group.add_argument("--all", action="store_true", help="unlock every locked account")
    args = parser.parse_args()

    print(f"[unlock] target: {config.describe_db_target()}")
    try:
        con = await asyncpg.connect(**_connect_kwargs())
    except Exception as err:  # noqa: BLE001
        print(f"[unlock] cannot connect: {err}", file=sys.stderr)
        return 2

    try:
        if args.list:
            rows = await con.fetch(
                """SELECT id, username, role, failed_attempts, locked,
                          CASE WHEN locked_until > NOW() THEN locked_until END AS locked_until
                     FROM users ORDER BY id"""
            )
            if not rows:
                print("[unlock] no accounts — the setup wizard at /setup is open")
                return 0
            print(f"{'id':>4}  {'username':<24} {'role':<8} {'fails':>5}  state")
            for row in rows:
                if row["locked"]:
                    state = "LOCKED (manual)"
                elif row["locked_until"]:
                    state = f"locked until {row['locked_until']:%Y-%m-%d %H:%M %Z}"
                else:
                    state = "ok"
                print(f"{row['id']:>4}  {row['username']:<24} {row['role']:<8} "
                      f"{row['failed_attempts']:>5}  {state}")
            return 0

        if args.user:
            result = await con.execute(
                """UPDATE users SET failed_attempts = 0, locked_until = NULL, locked = FALSE
                    WHERE username = $1""",
                args.user,
            )
            if result.endswith(" 0"):
                print(f"[unlock] no such account: {args.user}", file=sys.stderr)
                return 1
            print(f"[unlock] '{args.user}' unlocked")
            return 0

        result = await con.execute(
            """UPDATE users SET failed_attempts = 0, locked_until = NULL, locked = FALSE
                WHERE locked OR locked_until IS NOT NULL OR failed_attempts > 0"""
        )
        print(f"[unlock] {result.rsplit(' ', 1)[-1]} account(s) unlocked")
        return 0
    finally:
        await con.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
