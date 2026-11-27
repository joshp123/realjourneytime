"""Prepare the five bike speeds and five mode filters the comparison view offers."""
import json
from collections import defaultdict

SPEEDS = (12, 15, 20, 25, 45)


def towns(source):
    """Stop id -> town, from the planner's tiles (stations have none)."""
    out = {}
    for path in (source / "planner").glob("*/*.json"):
        out.update((stop[0], stop[2]) for stop in json.loads(path.read_bytes())["stops"])
    return out


def pack_bike_table(source, out, put_json):
    with (source / "bike-pairs.json").open() as f:
        data = json.load(f)
    town = towns(source)
    fields = data["fields"] + ["from_town", "to_town"]
    start, end = fields.index("from"), fields.index("to")
    rows = [r + [town.get(r[start], ""), town.get(r[end], "")] for r in data["rows"]]
    mode, km, real, median, mean, timetable, cancelled = [
        fields.index(name) for name in ("mode", "km", "p90", "median", "mean", "timetable", "cancelled")
    ]
    for speed in SPEEDS:
        total = wins = timetable_wins = 0
        counts = defaultdict(lambda: {"total": 0, "wins": 0, "longTotal": 0, "longWins": 0})
        steady, flaky = [], []
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
            typical = record[median] if record[median] is not None else record[mean]
            saving = typical - bike
            if row_wins and saving >= 1:
                (flaky if record[cancelled] > 0.1 else steady).append((saving, record))
        steady.sort(key=lambda item: item[0], reverse=True)
        flaky.sort(key=lambda item: item[0], reverse=True)
        for selected in ("all", "train", "metro", "tram", "bus"):
            put_json(out, f"public/bike-comparison/{speed}/{selected}.json.gz", {
                "total": total, "wins": wins, "timetableWins": timetable_wins, "byMode": counts,
                "fields": fields,
                "steady": [r for _, r in steady if selected in ("all", r[mode])][:150],
                "flaky": [r for _, r in flaky if selected in ("all", r[mode])][:50],
            })
