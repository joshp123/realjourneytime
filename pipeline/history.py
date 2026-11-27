"""Timetables from earlier years for the history view: site/data/history/<route key>.json.

One weekday a year, the second Tuesday of October. Buses, trams and metros come from KV78 days reduced by
kv78_history.py, one file per operator and mode (RET-tram.json, CXX-bus.json and so on), matched to today's stops
by name: RET renumbered its trams in 2025, so the view takes any line of the same operator and mode between the
two stops and names the lines it used. Trains come from
the Rijden de Treinen archive and are matched by train series and station code.
"""
import csv
import datetime as dt
import gzip
import json
import re
from collections import defaultdict
from zoneinfo import ZoneInfo

from common import DATA, SITE_DATA
from kv78_dates import HISTORY

DAYS = sorted(HISTORY) + ["2025-10-14"]
AMS = ZoneInfo("Europe/Amsterdam")


def label(name, town=""):
    """Town and stop name, in one format across years ("Rotterdam, Delfshaven" against "Delfshaven" in Rotterdam).
    The town matters: dozens of stops are just called "Station"."""
    if ", " in name:
        town, name = name.split(", ", 1)
    norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    return f"{norm(town)}|{norm(name)}"


def seconds(clock):
    # 00:00:00 is the feed's placeholder for "no time here".
    if not clock or clock in ("\\0", "00:00:00"):
        return None
    h, m, s = clock.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def ret_years(quays, index):
    years = defaultdict(dict)  # (operator, mode) -> year -> list of (labels, times, public number)
    paths = {d: DATA / "history-nl" / f"{d}.json.gz" for d in DAYS}
    for d, p in paths.items():
        if not p.exists():
            print("missing", d)
    paths = {d: p for d, p in paths.items() if p.exists()}
    # Some archive days carry only part of the line table: fill gaps from other years, then from today's routes.
    # Days are read one at a time (each is over a gigabyte in memory).
    fallback = {f"{r['key'].split('-', 1)[0]}|{r['key'].split('-', 1)[1]}": [r["short_name"], r["mode"].title()]
                for r in index if r["mode"] != "train"}
    for p in paths.values():
        fallback |= json.loads(gzip.open(p, "rt").read())["lines"]
    for date, p in paths.items():
        day = json.loads(gzip.open(p, "rt").read())
        day["lines"] = fallback | day["lines"]
        for key, calls in day["journeys"].items():
            operator, lpn = key.split("|")[:2]
            line = day["lines"].get(f"{operator}|{lpn}")
            if not line or len(calls) < 2:
                continue
            named = [(day["names"].get(c[1]), "") if day["names"].get(c[1]) else
                     (quays.get(f"NL:Q:{c[1]}", {}).get("name"), quays.get(f"NL:Q:{c[1]}", {}).get("town")) for c in calls]
            times = [t for c in calls for t in (seconds(c[2]), seconds(c[3]))]
            years[(operator, line[1].lower())].setdefault(date, []).append(([label(n, t) if n else "" for n, t in named], times, line[0]))
    return years


def train_years():
    years = defaultdict(dict)  # route key -> year -> list of (station codes, times)
    wanted = set(DAYS)
    files = [DATA / "trains" / f"services-{d[:4]}.csv.gz" for d in DAYS if d < "2025"] + \
            [DATA / "trains" / "services-2025-10.csv.gz"]
    for path in files:
        current, rows = None, []
        with gzip.open(path, "rt", newline="") as f:
            for row in csv.DictReader(f):
                if row["Service:Date"] not in wanted:
                    continue
                if row["Service:RDT-ID"] != current:
                    add_train(rows, years)
                    current, rows = row["Service:RDT-ID"], []
                rows.append(row)
        add_train(rows, years)
        print(path.name, "read")
    return years


def add_train(rows, years):
    if len(rows) < 2 or "ipv" in rows[0]["Service:Type"] or "i.p.v" in rows[0]["Service:Type"]:
        return
    series = int(rows[0]["Service:Train number"]) % 100000 // 100 * 100
    key = f"{rows[0]['Service:Type']}-{series}".replace(" ", "_")
    date = rows[0]["Service:Date"]
    y, m, d = map(int, date.split("-"))
    midnight = dt.datetime(y, m, d, tzinfo=AMS)
    stamp = lambda s: int((dt.datetime.fromisoformat(s) - midnight).total_seconds()) if s else None
    codes = ["S:" + r["Stop:Station code"].upper() for r in rows]
    times = [t for r in rows for t in (stamp(r["Stop:Arrival time"]), stamp(r["Stop:Departure time"]))]
    years[key].setdefault(date, []).append((codes, times, rows[0]["Service:Type"]))


def write(key, by_year, match):
    patterns, out = {}, []
    for date in sorted(by_year):
        journeys = []
        for stops, times, line in by_year[date]:
            p = patterns.setdefault((line, tuple(stops)), len(patterns))
            journeys.append([p] + times)
        out.append({"date": date, "journeys": journeys})
    (SITE_DATA / "history" / f"{key}.json").write_text(json.dumps(
        {"match": match, "patterns": [list(p) for _, p in patterns], "lines": [line for line, _ in patterns],
         "years": out}, separators=(",", ":")))


def main():
    (SITE_DATA / "history").mkdir(parents=True, exist_ok=True)
    for old in (SITE_DATA / "history").glob("*.json"):
        old.unlink()
    index = json.loads((SITE_DATA / "index.json").read_text())["routes"]
    quays = json.loads((DATA / "ref" / "quays.json").read_text())
    ret = ret_years(quays, index)
    trains = train_years()
    for (operator, mode), found in ret.items():
        if mode not in {"tram", "metro", "bus"}:
            continue
        write(f"{operator}-{mode}", found, "name")
        print(f"{operator}-{mode}", "history")
    for r in index:
        if r["mode"] != "train":
            continue
        elif r["key"] in trains:
            write(r["key"], trains[r["key"]], "id")
        print(r["key"], "history" if (SITE_DATA / "history" / f"{r['key']}.json").exists() else "none")


if __name__ == "__main__":
    main()
