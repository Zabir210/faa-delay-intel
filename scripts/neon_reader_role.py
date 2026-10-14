"""Create (or rotate) the dashboard's read-only Neon role and hand it to Vercel.

    .venv/bin/python scripts/neon_reader_role.py            # create/rotate + verify
    .venv/bin/python scripts/neon_reader_role.py --vercel   # ...and set Vercel Production DATABASE_URL

Reads the OWNER connection string from DATABASE_URL (environment, else the
gitignored .env.local at the repo root). The dashboard only SELECTs from the
tables in TABLES, so that is all the role gets; default_transaction_read_only
and a statement_timeout are set on the role as a second line of defence.

Rerunning rotates the password. Nothing secret is printed: the reader URL is
passed to `vercel env add` on stdin and never written to disk.
"""
import os
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
ROLE = "dashboard_reader"
# Every table dashboard/lib/db/queries.ts reads. Add here if the dashboard grows.
TABLES = ("observations", "delay_events", "ingest_runs")


def owner_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        env = ROOT / ".env.local"
        for line in env.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    if not url:
        sys.exit("DATABASE_URL not set and not found in .env.local")
    return url


def reader_url(owner: str, password: str) -> str:
    p = urlsplit(owner)
    netloc = f"{ROLE}:{quote(password, safe='')}@{p.hostname}" + (f":{p.port}" if p.port else "")
    return urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))


def setup(owner: str) -> str:
    password = secrets.token_urlsafe(32)
    with psycopg.connect(owner, autocommit=True) as c:
        db = c.execute("SELECT current_database()").fetchone()[0]
        exists = c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,)).fetchone()
        verb = "ALTER" if exists else "CREATE"
        done = "rotated password for" if exists else "created"
        c.execute(sql.SQL(verb + " ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(ROLE), sql.Literal(password)))
        c.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(sql.Identifier(ROLE)))
        c.execute(sql.SQL("ALTER ROLE {} SET statement_timeout = '15s'").format(sql.Identifier(ROLE)))
        c.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(db), sql.Identifier(ROLE)))
        c.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(ROLE)))
        c.execute(sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}").format(sql.Identifier(ROLE)))
        c.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(
            sql.SQL(", ").join(sql.Identifier(t) for t in TABLES), sql.Identifier(ROLE)))
    print(f"{done} role {ROLE}; SELECT on {', '.join(TABLES)}")
    return password


def verify(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as c:
        for t in TABLES:
            n = c.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(t))).fetchone()[0]
            print(f"  reader can read {t}: {n:,} rows")
        print("  default_transaction_read_only =", c.execute("SHOW default_transaction_read_only").fetchone()[0])
        probes = ("DELETE FROM ingest_runs WHERE false", "CREATE TABLE reader_probe (x int)")
        for stmt in probes:
            refuse(c, stmt, psycopg.errors.ReadOnlySqlTransaction)
        # A write must still fail with read-only switched off for the session
        # (it is only a role default): the grants themselves allow no writes.
        c.execute("SET default_transaction_read_only = off")
        for stmt in probes:
            refuse(c, stmt, psycopg.errors.InsufficientPrivilege)


def refuse(c: psycopg.Connection, stmt: str, expected: type[psycopg.Error]) -> None:
    try:
        c.execute(stmt)
    except expected as e:
        print(f"  write refused ({type(e).__name__}): {stmt}")
    else:
        sys.exit(f"FAIL: reader was allowed to run: {stmt}")


def push_to_vercel(url: str) -> None:
    subprocess.run(
        ["vercel", "env", "add", "DATABASE_URL", "production", "--force", "--sensitive", "--yes"],
        input=url, text=True, check=True, cwd=ROOT / "dashboard",
        stdout=subprocess.DEVNULL,
    )
    print("set Vercel Production DATABASE_URL to the reader role (redeploy to apply)")


def main() -> None:
    owner = owner_url()
    url = reader_url(owner, setup(owner))
    verify(url)
    if "--vercel" in sys.argv:
        push_to_vercel(url)


if __name__ == "__main__":
    main()
