#!/usr/bin/env python3
"""
Build punctuality statistics from open data (piebro/deutsche-bahn-data,
CC BY 4.0 by Deutsche Bahn) for the stations relevant to the user's routes.

Reads a JSON job description on stdin:
  {
    "dbPath": "/abs/path/bahn-finder.db",
    "buildId": "db_…",
    "months": [{"month": "2026-08", "url": "https://…parquet"} | {"month": …, "path": "/local.parquet"}],
    "evas": ["8000207", …],          # stations known by EVA number
    "names": ["Köln Hbf", …],        # stations known only by name (matched via the dataset's dictionary)
    "tmpDir": "/abs/tmp/dir",
    "keepRaw": false
  }
Writes delay_stations + delay_stats rows for buildId into the SQLite DB (in small
batches, so the running app is never blocked for long) and reports progress as
JSON lines on stdout: {"type": "progress"|"stations"|"done"|"error", …}.
Months are processed newest first; each raw file is deleted after aggregation.
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request

import duckdb

BATCH = 5000
UA = "bahn-finder delay ingest (self-hosted personal tool)"


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def norm(name, loose=False):
    """Normalized station name — MUST match normStation() in src/lib/delay/normalize.ts.
    loose=True also drops "(…)" qualifiers: "Freiburg (Breisgau) Hbf" → "freiburg hbf"."""
    n = (name or "").lower().replace("hauptbahnhof", "hbf")
    if loose:
        n = re.sub(r"\([^)]*\)", " ", n)
    toks = [t for t in re.split(r"[^a-z0-9ß-ÿ]+", n) if t and t not in ("bahnhof", "bf")]
    return " ".join(sorted(toks))


def download(url, dest, month):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest + ".part", "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, last = 0, 0.0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            now = time.time()
            if now - last > 0.5:
                emit(type="progress", stage="download", month=month, bytes=done, total=total)
                last = now
    os.replace(dest + ".part", dest)
    emit(type="progress", stage="download", month=month, bytes=done, total=total or done)


# delay (minutes, clamped ≥ 0) → histogram bin: 0..30 per minute, then 38 / 53 / 75
BIN = """CASE WHEN {x} IS NULL THEN NULL WHEN {x} <= 30 THEN {x}
             WHEN {x} <= 45 THEN 38 WHEN {x} <= 60 THEN 53 ELSE 75 END"""

BASE = """
CREATE OR REPLACE TEMP TABLE b AS
WITH base AS (
  SELECT ltrim(eva, '0') AS eva,
         train_number,
         -- line key: "RE7" (older months store "7" with train_type "RE"), FV → train type
         upper(CASE WHEN regexp_full_match(line_number, '[0-9]+') THEN train_type || line_number
                    ELSE coalesce(line_number, train_type) END) AS line,
         coalesce(departure_planned_time, arrival_planned_time) AS t,
         (coalesce(arrival_is_canceled, false) OR coalesce(departure_is_canceled, false)) AS canc,
         CASE WHEN arrival_planned_time IS NOT NULL AND NOT coalesce(arrival_is_canceled, false)
              THEN greatest(date_diff('minute', arrival_planned_time,
                                      coalesce(arrival_change_time, arrival_planned_time)), 0) END AS ad,
         CASE WHEN departure_planned_time IS NOT NULL AND NOT coalesce(departure_is_canceled, false)
              THEN greatest(date_diff('minute', departure_planned_time,
                                      coalesce(departure_change_time, departure_planned_time)), 0) END AS dd
  FROM read_parquet(?)
  WHERE ltrim(eva, '0') IN (SELECT eva FROM rel) AND coalesce(train_type, '') <> 'Bus'
)
SELECT eva, train_number, line, canc,
       CASE WHEN dayofweek(t) BETWEEN 1 AND 4 THEN 'wk' WHEN dayofweek(t) = 5 THEN 'fr' ELSE 'we' END AS dow,
       hour(t) AS hr,
       {ab} AS ab, {db} AS db
FROM base WHERE t IS NOT NULL
""".replace("{ab}", BIN.format(x="ad")).replace("{db}", BIN.format(x="dd"))

AGG = """
SELECT '{level}' AS level, {key} AS key, eva, {dow} AS dow,
       count(*) AS n, sum(CASE WHEN canc THEN 1 ELSE 0 END) AS cancelled,
       map_entries(histogram(ab) FILTER (WHERE ab IS NOT NULL)) AS ah,
       map_entries(histogram(db) FILTER (WHERE db IS NOT NULL)) AS dh
FROM b {where} GROUP BY ALL
"""
LEVELS = [
    ("train", "train_number", "dow", "WHERE train_number IS NOT NULL"),
    ("line_hour", "line || '|' || hr", "'all'", "WHERE line IS NOT NULL"),
    ("line", "line", "dow", "WHERE line IS NOT NULL"),
    ("station", "''", "dow", ""),
]


def hist(entries):
    return json.dumps(sorted([[int(e["key"]), int(e["value"])] for e in (entries or [])]))


def main():
    job = json.load(sys.stdin)
    months = sorted(job["months"], key=lambda m: m["month"], reverse=True)
    build = job["buildId"]
    os.makedirs(job["tmpDir"], exist_ok=True)
    db = sqlite3.connect(job["dbPath"], timeout=30)
    db.execute("PRAGMA busy_timeout = 30000")
    con = duckdb.connect()
    rel = set(str(e).lstrip("0") for e in job.get("evas", []))
    total_rows = 0

    for i, m in enumerate(months):
        month = m["month"]
        # The app marks the build failed when it was cancelled or restarted → stop.
        row = db.execute("SELECT status FROM delay_builds WHERE id = ?", (build,)).fetchone()
        if row is not None and row[0] != "running":
            raise RuntimeError("Build nicht mehr aktiv (abgebrochen)")
        src = m.get("path")
        tmp = None
        if not src:
            tmp = os.path.join(job["tmpDir"], f"data-{month}.parquet")
            download(m["url"], tmp, month)
            src = tmp
        try:
            if i == 0:
                # Station dictionary (all stations) from the newest month → match names.
                pairs = con.execute(
                    "SELECT DISTINCT ltrim(eva, '0'), station_name FROM read_parquet(?) "
                    "WHERE eva IS NOT NULL AND station_name IS NOT NULL", [src]
                ).fetchall()
                by_norm, by_loose = {}, {}
                for eva, name in pairs:
                    by_norm.setdefault(norm(name), set()).add(eva)
                    by_loose.setdefault(norm(name, True), set()).add(eva)
                for name in job.get("names", []):
                    # exact first, then loose — but only when it names exactly one station
                    hit = by_norm.get(norm(name)) or by_loose.get(norm(name, True)) or set()
                    if len(hit) == 1:
                        rel |= hit
                rows = [(build, eva, name, norm(name), norm(name, True)) for eva, name in pairs]
                for k in range(0, len(rows), BATCH):
                    db.executemany("INSERT INTO delay_stations (build_id, eva, name, norm, loose) VALUES (?,?,?,?,?)",
                                   rows[k:k + BATCH])
                    db.commit()
                emit(type="stations", count=len(rel), dictionary=len(rows))
                con.execute("CREATE OR REPLACE TEMP TABLE rel (eva VARCHAR)")
                con.executemany("INSERT INTO rel VALUES (?)", [[e] for e in sorted(rel)])

            emit(type="progress", stage="aggregate", month=month, index=i + 1, of=len(months))
            con.execute(BASE, [src])
            out = []
            for level, key, dow, where in LEVELS:
                q = AGG.format(level=level, key=key, dow=dow, where=where)
                for lv, k, eva, dw, n, canc, ah, dh in con.execute(q).fetchall():
                    out.append((build, lv, str(k), eva, month, dw, n, canc, hist(ah), hist(dh)))
            for k in range(0, len(out), BATCH):
                db.executemany(
                    "INSERT INTO delay_stats (build_id, level, key, eva, month, dow, n, cancelled, arr_hist, dep_hist) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)", out[k:k + BATCH])
                db.commit()
            total_rows += len(out)
            emit(type="progress", stage="written", month=month, index=i + 1, of=len(months), rows=len(out))
        finally:
            if tmp and not job.get("keepRaw") and os.path.exists(tmp):
                os.remove(tmp)

    emit(type="done", rows=total_rows, stations=len(rel), months=[m["month"] for m in months])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — report any failure to the job runner
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
