"""The bike against public transport at five speeds: the share of trips it wins, and its biggest win on each line."""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

SPEEDS = (12, 15, 20, 25, 45)


def stops(source):
    """Stop id -> (town, the name of the place it belongs to), from the planner's tiles and its list of places."""
    places = json.loads((source / "planner" / "places.json").read_bytes())
    out = {}
    for path in (source / "planner").glob("*/*.json"):
        out.update((stop[0], (stop[2], places[stop[6]][0])) for stop in json.loads(path.read_bytes())["stops"])
    return out


def best_of_each_line(rows, speed, mode, route, km, real, median, cancelled, n, limit=40):
    """The trip on each line where the bike saves most against the nine-in-ten time, in whole minutes as shown.

    Left out: hops under a kilometre, trips with fewer than 500 recorded journeys, and trips whose nine-in-ten time is more than twice the usual one, which
    is a missed hourly bus and not a slow line.
    """
    best = {}
    for record in rows:
        if mode not in ("all", record[2]) or record[cancelled] > 0.1 or record[km] < 1 or record[n] < 500 or \
                record[median] is None or record[real] > 2 * record[median]:
            continue
        saving = math.ceil(record[real] - 1e-9) - round(record[km] / speed * 60)
        if saving >= 1 and saving > best.get(record[route], (0,))[0]:
            best[record[route]] = (saving, record)
    return [record for _, record in sorted(best.values(), key=lambda item: item[0], reverse=True)[:limit]]


def pack_bike_table(source, out, put_json):
    with (source / "bike-pairs.json").open() as f:
        data = json.load(f)
    stop = stops(source)
    fields = data["fields"] + ["from_town", "to_town", "from_place", "to_place"]
    start, end = fields.index("from"), fields.index("to")
    none = ("", "")
    rows = [r + [stop.get(r[start], none)[0], stop.get(r[end], none)[0], stop.get(r[start], none)[1], stop.get(r[end], none)[1]]
            for r in data["rows"]]
    assert fields.index("mode") == 2
    mode, km, real, timetable, cancelled = [fields.index(name) for name in ("mode", "km", "p90", "timetable", "cancelled")]
    for speed in SPEEDS:
        total = wins = timetable_wins = 0
        counts = defaultdict(lambda: {"total": 0, "wins": 0, "longTotal": 0, "longWins": 0})
        for record in rows:
            total += 1
            bike = record[km] / speed * 60
            row_wins = bike <= record[real] - 1
            wins += row_wins
            timetable_wins += bike <= record[timetable] - 1
            stats = counts[record[mode]]
            stats["total"] += 1
            stats["wins"] += row_wins
            if record[km] >= 3:
                stats["longTotal"] += 1
                stats["longWins"] += row_wins
        for selected in ("all", "train", "metro", "tram", "bus"):
            put_json(out, f"public/bike-comparison/{speed}/{selected}.json.gz", {
                "total": total, "wins": wins, "timetableWins": timetable_wins, "byMode": counts,
                "fields": fields,
                "lines": best_of_each_line(rows, speed, selected, fields.index("route"), km, real, fields.index("median"), cancelled, fields.index("n")),
            })


if __name__ == "__main__":
    # For this machine's server: the same tables as plain files under site/data/bike-comparison.
    source = Path(sys.argv[1])

    def put(out, key, value):
        target = out / key.removeprefix("public/").removesuffix(".gz")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    pack_bike_table(source, source, put)
