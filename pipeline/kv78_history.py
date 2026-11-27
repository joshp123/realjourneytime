"""Reduce one KV78 day to the bus, tram and metro timetable for the history view: line, stop names, planned times.

Works on every archive year: older files (2019) carry line numbers and stop names in separate LINE and
TIMINGPOINT tables instead of columns on each passing time, so each table is read by its own header.
Output: <out>/<date>.json.gz with {"lines": {"operator|line": [public number, mode]}, "names": {timing point: name},
"journeys": {"operator|line|journey": [[stop order, timing point, planned arrival, planned departure], ...]}}.
"""
import gzip
import json
import lzma
import sys
from pathlib import Path

OPERATORS = (b"CXX|", b"ARR|", b"QBUZZ|", b"EBS|", b"GVB|", b"KEOLIS|", b"RET|", b"HTM|")


def main(source, out_dir):
    source = Path(source)
    date = source.name.split("_")[1].split(".")[0]
    header, table = {}, None
    lines, names, calls = {}, {}, {}
    with lzma.open(source, "rb") as raw:
        for line in raw:
            if line.startswith(b"\\T"):
                table = line[2:].split(b"|")[0].decode()
                continue
            if line.startswith(b"\\L"):
                header[table] = {n: i for i, n in enumerate(line[2:].decode().rstrip("\r\n").split("|"))}
                continue
            if line.startswith(b"\\") or table not in header:
                continue
            h = header[table]
            if table == "TIMINGPOINT":
                f = line.decode("utf-8", "replace").rstrip("\r\n").split("|")
                names[f[h["TimingPointCode"]]] = f[h["TimingPointName"]]
            elif not line.startswith(OPERATORS):
                continue
            elif table == "LINE":
                f = line.decode("utf-8", "replace").rstrip("\r\n").split("|")
                lines[f"{f[0]}|{f[h['LinePlanningNumber']]}"] = [f[h["LinePublicNumber"]], f[h["TransportType"]].title()]
            elif table == "DATEDPASSTIME":
                f = line.decode("utf-8", "replace").rstrip("\r\n").split("|")
                if f[h["OperationDate"]] != date:
                    continue
                lpn = f"{f[0]}|{f[h['LinePlanningNumber']]}"
                if "LinePublicNumber" in h:
                    lines.setdefault(lpn, [f[h["LinePublicNumber"]], f[h["TransportType"]].title()])
                key = f"{lpn}|{f[h['JourneyNumber']]}|{f[h['FortifyOrderNumber']]}"
                order = int(f[h["UserStopOrderNumber"]])
                calls.setdefault(key, {})[order] = [order, f[h["TimingPointCode"]],
                                                    f[h["TargetArrivalTime"]], f[h["TargetDepartureTime"]]]
    journeys = {k: [v[o] for o in sorted(v)] for k, v in calls.items()}
    used = {c[1] for j in journeys.values() for c in j}
    out = Path(out_dir) / f"{date}.json.gz"
    with gzip.open(out.with_suffix(".tmp"), "wt") as f:
        json.dump({"date": date, "lines": lines, "names": {k: v for k, v in names.items() if k in used},
                   "journeys": journeys}, f)
    out.with_suffix(".tmp").rename(out)
    print(date, len(journeys), "journeys", len(lines), "lines", sum(1 for k in used if k in names), "of", len(used),
          "stops named")


if __name__ == "__main__":
    main(*sys.argv[1:])
