"""Train journeys calling at Dutch stations, from the Rijden de Treinen service archive."""
import csv
import datetime as dt
import gzip
from collections import defaultdict
from zoneinfo import ZoneInfo

from common import DATA, pack, unpack

AMS = ZoneInfo("Europe/Amsterdam")


def stations():
    with open(DATA / "ref" / "stations-2023-09-nl.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    return {r["code"].upper(): {"name": r["name_long"], "lat": float(r["geo_lat"]), "lon": float(r["geo_lng"])}
            for r in rows if r["country"] == "NL"}


def seconds(stamp, midnight):
    if not stamp:
        return None
    return int((dt.datetime.fromisoformat(stamp) - midnight).total_seconds())


def services():
    for path in sorted((DATA / "trains").glob("services-????-??.csv.gz")):
        with gzip.open(path, "rt", newline="") as f:
            current, rows = None, []
            for row in csv.DictReader(f):
                if row["Service:RDT-ID"] != current:
                    if rows:
                        yield rows
                    current, rows = row["Service:RDT-ID"], []
                rows.append(row)
            if rows:
                yield rows


def routes():
    local = stations()
    by_series = defaultdict(lambda: {"patterns": {}, "days": defaultdict(list), "ends": defaultdict(int),
                                     "companies": defaultdict(int)})
    for rows in services():
        first = rows[0]
        date = first["Service:Date"]
        calls = [r for r in rows if r["Stop:Station code"].upper() in local]
        if len(calls) < 2:
            continue
        if "ipv" in first["Service:Type"] or "i.p.v" in first["Service:Type"]:
            continue  # replacement buses and metros
        series = int(first["Service:Train number"]) % 100000 // 100 * 100
        route = by_series[(first["Service:Type"], series)]
        route["companies"][first["Service:Company"].split("_")[0]] += 1
        stops = tuple("S:" + r["Stop:Station code"].upper() for r in calls)
        pattern = route["patterns"].setdefault(stops, len(route["patterns"]))
        route["ends"][(rows[0]["Stop:Station name"], rows[-1]["Stop:Station name"])] += 1
        y, m, d = map(int, date.split("-"))
        midnight = dt.datetime(y, m, d, tzinfo=AMS)
        times = [pattern]
        for r in calls:
            sa = seconds(r["Stop:Arrival time"], midnight)
            sd = seconds(r["Stop:Departure time"], midnight)
            aa = -1 if r["Stop:Arrival cancelled"] == "true" else (
                sa + 60 * int(r["Stop:Arrival delay"]) if sa is not None and r["Stop:Arrival delay"] else None)
            ad = -1 if r["Stop:Departure cancelled"] == "true" else (
                sd + 60 * int(r["Stop:Departure delay"]) if sd is not None and r["Stop:Departure delay"] else None)
            times += [sa, sd, aa, ad]
        route["days"][date].append(pack(times))

    for (kind, series), route in by_series.items():
        stop_ids = sorted({s for p in route["patterns"] for s in p})
        index = {s: i for i, s in enumerate(stop_ids)}
        journeys = sum(len(v) for v in route["days"].values())
        if journeys < 300 or len(route["days"]) < 30:
            continue
        company = max(route["companies"], key=route["companies"].get)
        ends = sorted(route["ends"].items(), key=lambda kv: -kv[1])
        termini = sorted({ends[0][0][0], ends[0][0][1]})
        yield {
            "key": f"{kind}-{series}".replace(" ", "_"),
            "mode": "train",
            "operator": company,
            "short_name": f"{kind} {series}",
            "name": f"{company} {kind}",
            "detail": " – ".join(termini),
            "colour": None,
            "stops": {s: local[s[2:]] for s in stop_ids},
            "stop_ids": stop_ids,
            "patterns": [[index[s] for s in p] for p in route["patterns"]],
            "days": {d: [unpack(j) for j in js] for d, js in route["days"].items()},
        }
