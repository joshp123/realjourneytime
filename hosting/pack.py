"""Pack a completed site/data build for Sites."""
import argparse
from collections import defaultdict
import gzip
import json
from pathlib import Path
import re
import sys

import numpy as np

from bike_table import pack_bike_table

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
from common import DATA, SITE_DATA  # noqa: E402


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def zipped(value):
    return gzip.compress(encode(value), 4, mtime=0)


def put_json(out, key, value):
    target = out / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(zipped(value))


def pack_route(out, route):
    key = route["key"]
    days = route.pop("days")
    count = np.zeros(len(route["patterns"]), dtype=int)
    grouped = [[] for _ in count]
    calendar = []
    for day in days:
        pattern_order = []
        for journey in day["journeys"]:
            p = journey[0]
            grouped[p].append(journey[1:])
            pattern_order.append(p)
        calendar.append([day["date"], day["type"], pattern_order])
    timing = []
    for p, rows in enumerate(grouped):
        count[p] = len(rows)
        timing.append(np.array(rows, dtype=float))
        calls = timing[-1]
        calls[np.isnan(calls)] = -2
        timing[-1] = calls.astype("<i4")

    columns = [[] for _ in route["stop_ids"]]
    for p, pattern in enumerate(route["patterns"]):
        if not count[p]:
            continue
        for pos, stop in enumerate(pattern):
            columns[stop].append(timing[p][:, pos * 4:pos * 4 + 4].T.tobytes())

    target = out / "calls" / f"{key}.bin"
    target.parent.mkdir(parents=True, exist_ok=True)
    ranges = []
    with target.open("wb") as f:
        for column in columns:
            chunk = gzip.compress(b"".join(column), 4, mtime=0)
            ranges.append([f.tell(), len(chunk)])
            f.write(chunk)

    put_json(out, f"calls/{key}.json.gz", {
        "stop_ids": route["stop_ids"], "patterns": route["patterns"],
        "counts": count.tolist(), "days": calendar, "ranges": ranges,
    })
    route.update(weights=count.tolist(), first=days[0]["date"], last=days[-1]["date"], day_count=len(days))
    put_json(out, f"route/{key}.json.gz", route)


def pack_timings(source, out):
    index = json.loads((source / "index.json").read_bytes())
    put_json(out, "public/index.json.gz", index)
    for meta in index["routes"]:
        key = meta["key"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", key):
            raise ValueError(f"Unsupported route key: {key}")
        route = json.loads((source / "routes" / f"{key}.json").read_bytes())
        pack_route(out, route)
    print(f"Packed {len(index['routes'])} routes", flush=True)


def copy_compressed(source, out, relative):
    target = out / "public" / (str(relative) + ".gz")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Read the JSON source. The development server's .gz cache may cover an older build.
    with (source / relative).open("rb") as incoming, target.open("wb") as raw, \
            gzip.GzipFile(fileobj=raw, filename="", mode="wb", compresslevel=4, mtime=0) as outgoing:
        while block := incoming.read(1024 * 1024):
            outgoing.write(block)


def pack_planner(source, out):
    directory = source / "planner"
    for name in ("meta.json", "places.json", "trains.json"):
        if not (directory / name).is_file():
            raise ValueError("Generate the planner files with pipeline/packed.mjs for this source build")
    meta = json.loads((directory / "meta.json").read_bytes())
    index = json.loads((source / "index.json").read_bytes())
    if meta["coverage"] != index["coverage"]:
        raise ValueError("Planner data and route index cover different dates")
    for path in sorted(directory.rglob("*.json")):
        copy_compressed(source, out, path.relative_to(source))


def pack_tables(source, out):
    pack_planner(source, out)
    copy_compressed(source, out, Path("bike-pairs.json"))
    pack_bike_table(source, out, put_json)
    for history in sorted((source / "history").glob("*.json")):
        copy_compressed(source, out, history.relative_to(source))
    by_tile = defaultdict(dict)
    with (source / "reach.json").open() as f:
        profiles = json.load(f)["routes"]
    for route in profiles:
        stops = route["stops"]
        for a, b, *hours in route["pairs"]:
            lat, lon = stops[a]
            target = stops[b]
            if lat is None or lon is None or target[0] is None or target[1] is None:
                continue
            origins = by_tile[int(lat * 10), int(lon * 10)]
            dest = origins.setdefault((lat, lon), {})
            previous = dest.get(tuple(target))
            dest[tuple(target)] = hours if previous is None else [
                min(x, y) if x >= 0 and y >= 0 else max(x, y) for x, y in zip(previous, hours)
            ]
    for (r, c), origins in by_tile.items():
        rows = [[*origin, [[*target, *hours] for target, hours in dest.items()]] for origin, dest in origins.items()]
        put_json(out, f"reach/{r}/{c}.json.gz", rows)
    print(f"Packed tables and {len(by_tile)} transit reach tiles", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory, for example data/sites-NEXT")
    parser.add_argument("--source", type=Path, default=SITE_DATA)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if args.output.resolve().is_relative_to(source):
        parser.error("Write outside the development data directory")
    if not (source / "planner" / "meta.json").is_file():
        parser.error("Run pipeline/packed.mjs for this source build first")
    args.output.mkdir()
    pack_timings(source, args.output)
    pack_tables(source, args.output)
    from pack_map import pack_map
    pack_map(DATA, args.output)
    files = [p for p in args.output.rglob("*") if p.is_file()]
    print(f"{len(files)} objects, {sum(p.stat().st_size for p in files):,} bytes", flush=True)


if __name__ == "__main__":
    main()
