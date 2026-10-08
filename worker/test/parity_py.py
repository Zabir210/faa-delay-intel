"""Parity harness, Python side. LOCAL DOCKER DATABASES ONLY.

Usage:
  python worker/test/parity_py.py snapshots <dsn> <out.jsonl>
      Reconstruct a full feed XML document for every snapshot stored in the
      DB (from each observation's verbatim `raw` fragment).
  python worker/test/parity_py.py parse <in.jsonl> <out.jsonl>
      Parse every document with ingest/parser.py; emit records as JSON.
  python worker/test/parity_py.py events <dsn> <out.json>
      derive_events over the full observation history.
  python worker/test/parity_py.py replay <dsn> <snapshots.jsonl> <first_idx> <out.jsonl>
      Replay snapshots[first_idx:] through ingest.run._run_once with a pinned
      clock (public.now()) and a mocked fetch.
"""
import contextlib
import io
import json
import re
import sys
import time
from datetime import timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import psycopg  # noqa: E402

from detect.events import derive_events  # noqa: E402
from ingest import run as run_mod  # noqa: E402
from ingest.parser import parse_nas_status  # noqa: E402

LIST_FOR = {
    "delay": ("General Arrival/Departure Delay Info", "Arrival_Departure_Delay_List"),
    "closure": ("Airport Closures", "Airport_Closure_List"),
    "ground_delay": ("Ground Delay Programs", "Ground_Delay_List"),
    "ground_stop": ("Ground Stop Programs", "Ground_Stop_List"),
}


def guard(dsn):
    host = urlparse(dsn).hostname
    if host not in ("127.0.0.1", "localhost"):
        sys.exit(f"refusing non-local database host: {host}")


def iso(v):
    return v.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if v else None


def cmd_snapshots(dsn, out):
    guard(dsn)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT update_time, delay_type, raw FROM observations ORDER BY update_time, id")
        rows = cur.fetchall()
    snaps = {}
    for ut, dtype, raw in rows:
        snaps.setdefault(ut, []).append((dtype, raw))
    with open(out, "w") as f:
        for ut, items in snaps.items():
            blocks, seen = {}, set()
            for dtype, raw in items:
                if (dtype, raw) in seen:
                    continue  # both legs of one <Delay> share the same raw
                seen.add((dtype, raw))
                blocks.setdefault(dtype, []).append(raw)
            parts = [f"<AIRPORT_STATUS_INFORMATION><Update_Time>"
                     f"{ut.astimezone(timezone.utc).strftime('%a %b %d %H:%M:%S %Y')} GMT"
                     f"</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>"]
            for dtype, raws in blocks.items():
                name, lst = LIST_FOR[dtype]
                parts.append(f"<Delay_type><Name>{name}</Name><{lst}>{''.join(raws)}</{lst}></Delay_type>")
            parts.append("</AIRPORT_STATUS_INFORMATION>")
            f.write(json.dumps({"id": iso(ut), "xml": "".join(parts)}) + "\n")


def cmd_parse(inp, out):
    with open(inp) as f, open(out, "w") as g:
        for line in f:
            doc = json.loads(line)
            try:
                r = parse_nas_status(doc["xml"])
                res = {"id": doc["id"], "update_time": iso(r["update_time"]), "records": r["records"]}
            except Exception as exc:  # noqa: BLE001
                res = {"id": doc["id"], "error": type(exc).__name__}
            g.write(json.dumps(res, sort_keys=True) + "\n")


def cmd_events(dsn, out):
    guard(dsn)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("""SELECT airport, delay_type, direction, reason, update_time,
                              min_delay_minutes, max_delay_minutes
                       FROM observations ORDER BY update_time""")
        cols = [d.name for d in cur.description]
        obs = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.execute("SELECT DISTINCT update_time FROM observations ORDER BY update_time")
        snaps = [r[0] for r in cur.fetchall()]
    events = derive_events(obs, snaps)
    for e in events:
        for k in ("started_at", "last_seen_at", "ended_at"):
            e[k] = iso(e[k])
    Path(out).write_text(json.dumps(events, sort_keys=True))


OK_RE = re.compile(r"ok: (\d+) seen, (\d+) new, (\d+) events, (\d+) anomalies")


def cmd_replay(dsn, snapshots, first_idx, out):
    guard(dsn)
    docs = [json.loads(line) for line in open(snapshots)][int(first_idx):]
    clock = psycopg.connect(dsn, autocommit=True)
    with open(out, "w") as g:
        for doc in docs:
            # Pin now() to two minutes after this snapshot's feed time.
            clock.execute("UPDATE fake_clock SET t = %s::timestamptz + interval '2 minutes'",
                          (doc["id"],))
            run_mod.fetch_nas_status = lambda xml=doc["xml"]: xml
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
                rc = run_mod._run_once(dsn, time.monotonic())
            m = OK_RE.search(buf_out.getvalue())
            g.write(json.dumps({
                "id": doc["id"], "rc": rc,
                "summary": [int(x) for x in m.groups()] if m else None,
                "warnings": buf_err.getvalue().strip() or None,
            }) + "\n")
    clock.close()


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"snapshots": cmd_snapshots, "parse": cmd_parse,
     "events": cmd_events, "replay": cmd_replay}[cmd](*args)
