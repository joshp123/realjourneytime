"""Reduce one day of the KV78 archive to the last known state of each bus, tram and metro stop call.

Keeps the eight operators whose vehicles report recorded times. Trains come from Rijden de Treinen and ferries
are left out, so TransportType "Trein" and "Boot" are dropped.

Input: a KV78_<date>.csv.xz file from trein.fwrite.org (KV8turbo passtimes).
Output: <out>/<date>.tsv.gz with one row per (operating day, journey, stop order).
"""
import csv
import gzip
import lzma
import sys
from pathlib import Path

COLUMNS = ("DataOwnerCode OperationDate LinePlanningNumber JourneyNumber FortifyOrderNumber "
           "UserStopOrderNumber UserStopCode LocalServiceLevelCode JourneyPatternCode LineDirection "
           "LastUpdateTimeStamp DestinationCode IsTimingStop ExpectedArrivalTime ExpectedDepartureTime "
           "TripStopStatus").split()
KEEP = ("OperationDate LinePlanningNumber JourneyNumber FortifyOrderNumber UserStopOrderNumber "
        "JourneyPatternCode LineDirection TripStopStatus TargetArrivalTime TargetDepartureTime "
        "RecordedArrivalTime RecordedDepartureTime LinePublicNumber TransportType QuayCode "
        "DestinationName LineDestColor LastUpdateTimeStamp DataOwnerCode").split()
OPERATORS = (b"CXX|", b"ARR|", b"QBUZZ|", b"EBS|", b"GVB|", b"KEOLIS|", b"RET|", b"HTM|")
MODES = {"Bus", "Tram", "Metro"}


def main(source, out_dir):
    source = Path(source)
    date = source.name.split("_")[1].split(".")[0]
    index = None
    calls = {}
    with lzma.open(source, "rb") as raw:
        for line in raw:
            if line.startswith(b"\\LDataOwnerCode|OperationDate|"):
                if index is not None:
                    continue
                header = line[2:].decode().rstrip("\n").split("|")
                index = {name: header.index(name) for name in KEEP}
                continue
            if index is None or not line.startswith(OPERATORS):
                continue
            fields = line.decode("utf-8", "replace").rstrip("\n").split("|")
            if len(fields) <= max(index.values()):
                continue
            row = [fields[index[name]] for name in KEEP]
            row = ["" if value == "\\0" else value for value in row]
            if row[13] not in MODES:
                continue
            key = (row[-1], *row[:5])
            previous = calls.get(key)
            # Keep recorded times once seen: later messages sometimes omit them.
            if previous:
                for i in (10, 11):
                    if not row[i]:
                        row[i] = previous[i]
            calls[key] = row
    # One file per operator, so later steps can build one operator at a time.
    by_operator = {}
    for key, row in calls.items():
        by_operator.setdefault(key[0], []).append(row)
    for operator, rows in by_operator.items():
        out = Path(out_dir) / operator / f"{date}.tsv.gz"
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        with gzip.open(tmp, "wt", newline="") as f:
            writer = csv.writer(f, delimiter="\t")
            writer.writerow(KEEP)
            writer.writerows(rows)
        tmp.rename(out)
    print(date, len(calls), "calls", {k: len(v) for k, v in by_operator.items()}, flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
