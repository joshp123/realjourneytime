"""Write the site data: one file per route plus an index. Bike distances are added later by bike.py.

Run: uv run python build.py [trains]   (RJT_DATA=<folder> to build somewhere other than site/data;
"trains" rebuilds only the trains and keeps everything else in the index)
"""
import datetime as dt
import json
import sys

import kv78
import trains
from common import SITE_DATA
from shapes import Shapes


def day_type(date):
    weekday = dt.date.fromisoformat(date).weekday()
    return "saturday" if weekday == 5 else "sunday" if weekday == 6 else "weekdays"


def main(only=None):
    shapes = Shapes()
    out = SITE_DATA / "routes"
    out.mkdir(parents=True, exist_ok=True)
    index, days, bike = [], {}, False
    if only:
        old = json.loads((SITE_DATA / "index.json").read_text())
        bike = old.get("bike", False)
        for r in old["routes"]:
            if r["source"] == only:
                (out / f"{r['key']}.json").unlink(missing_ok=True)
            else:
                index.append(r)
        days = {k: {v["start"], v["end"]} for k, v in old["coverage"].items() if k != only}
    builders = {"transit": kv78.all_routes, "trains": trains.routes}
    for source, routes in ((s, builders[s]()) for s in builders if only in (None, s)):
        for route in routes:
            shapes.attach(route)
            route["days"] = [{"date": d, "type": day_type(d), "journeys": j} for d, j in sorted(route["days"].items())]
            (out / f"{route['key']}.json").write_text(json.dumps(route, separators=(",", ":"), ensure_ascii=False))
            dates = [d["date"] for d in route["days"]]
            days.setdefault(source, set()).update(dates)
            index.append({k: route[k] for k in ("key", "mode", "operator", "short_name", "name", "detail", "colour")}
                         | {"source": source, "stop_ids": route["stop_ids"], "start": dates[0], "end": dates[-1],
                            "days": len(dates), "journeys": sum(len(d["journeys"]) for d in route["days"])})
            print(source, route["key"], route["detail"][:60], len(dates), "days", flush=True)
    order = {"train": 0, "metro": 1, "tram": 2, "bus": 3}
    index.sort(key=lambda r: (order[r["mode"]], r["operator"], r["short_name"].zfill(6)))
    coverage = {source: {"days": len(d), "start": min(d), "end": max(d)} for source, d in days.items()}
    if only:
        coverage |= {k: v for k, v in old["coverage"].items() if k != only}
    (SITE_DATA / "index.json").write_text(json.dumps({"built": dt.date.today().isoformat(), "coverage": coverage,
                                                      "bike": bike, "routes": index}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
