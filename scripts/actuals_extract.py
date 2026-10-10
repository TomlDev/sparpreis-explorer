#!/usr/bin/env python3
"""
Actual times for single train stops from the open DB raw data
(piebro/deutsche-bahn-data, raw_data: responses of DB's Timetables API).

stdin  JSON: {"files": [parquet paths], "stops": [{"key", "eva"?, "station", "number"?, "line"?,
              "kind": "dp"|"ar", "planned": "yyMMddHHmm"}]}
stdout JSON: {key: {"found", "pt", "ct", "cs", "codes", "final", "eva"}}

plan responses give the stop id (train number + planned time at that station);
fchg snapshots give its changes (ct = changed time, cs = "c" cancelled, m t="d"
= delay reason codes). A stop the station's snapshots don't mention ran on time.
"""
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

import duckdb


def norm(name):
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\bhauptbahnhof\b", "hbf", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def minutes(t):  # yyMMddHHmm → comparable minutes (same month is enough for ±window checks)
    return int(t[4:6]) * 1440 + int(t[6:8]) * 60 + int(t[8:10])


def parse(xml):
    try:
        return ET.fromstring(xml.encode())
    except Exception:
        return None


def main():
    job = json.load(sys.stdin)
    files = [f for f in job["files"]]
    stops = job["stops"]
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE r AS SELECT timestamp, api_name, url, response_data FROM read_parquet(?) "
        "WHERE api_name IN ('timetables/v1/plan', 'timetables/v1/fchg')",
        [files],
    )

    # Station name → EVA from the plan responses (for legs without a known EVA).
    by_name = {}
    for url, head in con.execute(
        "SELECT DISTINCT url, left(response_data, 200) FROM r WHERE api_name = 'timetables/v1/plan'"
    ).fetchall():
        m = re.search(r"/plan/0*(\d+)/", url)
        n = re.search(r"station=['\"]([^'\"]+)", head or "")
        if m and n:
            by_name.setdefault(norm(n.group(1)), m.group(1))

    out = {}
    cache = {}
    for st in stops:
        eva = st.get("eva") or by_name.get(norm(st.get("station")))
        res = {"found": False, "eva": eva, "final": False}
        out[st["key"]] = res
        if not eva:
            continue
        if eva not in cache:
            plan = con.execute(
                "SELECT response_data FROM r WHERE api_name = 'timetables/v1/plan' AND regexp_matches(url, ?)",
                [f"/plan/0*{eva}/"],
            ).fetchall()
            fchg = con.execute(
                "SELECT timestamp, response_data FROM r WHERE api_name = 'timetables/v1/fchg' AND regexp_matches(url, ?) "
                "ORDER BY timestamp",
                [f"/fchg/0*{eva}$"],
            ).fetchall()
            cache[eva] = ([parse(x) for (x,) in plan], [(ts, parse(x)) for ts, x in fchg])
        plans, snaps = cache[eva]

        # 1) The stop in the plan: same train number (or line), planned time within 10 min.
        want = minutes(st["planned"])
        best = None
        for root in plans:
            if root is None:
                continue
            for s in root.findall("s"):
                tl, e = s.find("tl"), s.find(st["kind"])
                if tl is None or e is None or not e.get("pt"):
                    continue
                if st.get("number"):
                    if tl.get("n") != st["number"]:
                        continue
                elif not st.get("line") or (e.get("l") or "").replace(" ", "") != st["line"].replace(" ", ""):
                    continue
                d = abs(minutes(e.get("pt")) - want)
                if d <= 10 and (best is None or d < best[0]):
                    best = (d, s.get("id"), e.get("pt"))
        if not best:
            continue
        _, sid, pt = best
        res.update(found=True, pt=pt, ct=None, cs=None, codes=[])

        # 2) Its changes: the latest snapshot that knows the stop wins.
        last_ts = None
        for ts, root in snaps:
            last_ts = ts
            if root is None:
                continue
            for s in root.findall("s"):
                if s.get("id") != sid:
                    continue
                e = s.find(st["kind"])
                if e is not None:
                    res["ct"] = e.get("ct") or res["ct"]
                    res["cs"] = e.get("cs") or res["cs"]
                codes = [m.get("c") for m in s.iter("m") if m.get("t") == "d" and m.get("c")]
                if codes:
                    res["codes"] = sorted(set(codes))
        # Final only if the station was polled after the (actual) time — else it's a forecast.
        if last_ts is not None:
            happened = res["ct"] or pt
            snap = last_ts.strftime("%y%m%d%H%M")
            res["final"] = minutes(snap) >= minutes(happened)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
