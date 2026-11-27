"""Bus, tram and metro journeys for the whole country from the reduced KV78 days, one operator at a time."""
import csv
import gzip
import json
from collections import defaultdict

from common import DATA, pack, unpack
from kv78_dates import days

MODE = {"Metro": "metro", "Tram": "tram", "Bus": "bus"}
OPERATORS = {"CXX": "Connexxion", "ARR": "Arriva", "QBUZZ": "Qbuzz", "EBS": "EBS", "GVB": "GVB",
             "KEOLIS": "Keolis", "RET": "RET", "HTM": "HTM"}


def seconds(clock):
    # 00:00:00 is the feed's placeholder for "no time here" (GVB's metro uses it at every stop).
    if not clock or clock == "00:00:00":
        return None
    h, m, s = clock.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def drop_layovers(times):
    """Near the end of a journey, a delay that jumps by more than 5 minutes between two stops is a layover being
    logged as travel (the bus waits, then is logged at its next pass), not a real delay: treat the times from that
    stop on as unknown. Only the last two stops are checked; elsewhere a jump is a real hold-up."""
    n = (len(times) - 1) // 4

    def delay(k):
        sa, sd, aa, ad = times[1 + 4 * k:5 + 4 * k]
        for planned, actual in ((sd, ad), (sa, aa), (sa, ad), (sd, aa)):
            if planned is not None and actual not in (None, -1):
                return actual - planned
        return None

    for k in (n - 2, n - 1):
        if k < 1:
            continue
        before = next((d for d in (delay(j) for j in range(k - 1, max(-1, k - 4), -1)) if d is not None), None)
        here = delay(k)
        if before is not None and here is not None and here - before > 300:
            for j in range(k, n):
                times[3 + 4 * j] = times[4 + 4 * j] = None
            return


def drop_spikes(times):
    """Treat a recorded time as unknown when it is over 15 minutes away from the typical delay at nearby stops.
    Some feeds log a stop that a loop passes twice at the second pass, with the stops either side on time.
    Arrivals and departures are tested separately against the median of the recorded delays within two stops
    on either side; it needs recorded times on both sides, because a real breakdown makes every later stop late."""
    n = (len(times) - 1) // 4
    delay = {}  # (stop, 0 for arrival or 1 for departure) -> seconds late
    for k in range(n):
        sa, sd, aa, ad = times[1 + 4 * k:5 + 4 * k]
        for side, planned, actual in ((0, sa, aa), (1, sd, ad)):
            if planned is not None and actual not in (None, -1):
                delay[(k, side)] = actual - planned
    bad = []
    for (k, side), d in delay.items():
        before = [v for (j, _), v in delay.items() if k - 2 <= j < k]
        after = [v for (j, _), v in delay.items() if k < j <= k + 2]
        around = sorted(before + after + [v for (j, s2), v in delay.items() if j == k and s2 != side])
        if before and after and len(around) >= 3 and abs(d - around[len(around) // 2]) > 900:
            bad.append((k, side))
    for k, side in bad:
        times[3 + 4 * k + side] = None


def routes(operator, quays):
    """Yield one route per line of this operator."""
    info = {}
    by_line = defaultdict(lambda: {"patterns": {}, "days": defaultdict(list), "destinations": set()})
    wanted = {d.isoformat() for d in days()}
    for path in sorted((DATA / "kv78-nl" / operator).glob("*.tsv.gz")):
        date = path.name[:10]
        if date not in wanted:
            continue
        journeys = defaultdict(dict)  # (line, journey) -> {order: row}
        with gzip.open(path, "rt") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                if row["OperationDate"] != date or row["TransportType"] not in MODE:
                    continue
                # The archive has the odd line where two messages ran together ("20Type"): skip it.
                if not row["UserStopOrderNumber"].isdigit():
                    continue
                line = row["LinePlanningNumber"]
                journeys[(line, row["JourneyNumber"], row["FortifyOrderNumber"])][int(row["UserStopOrderNumber"])] = row
                info.setdefault(line, row)
        for (line, *_), calls in journeys.items():
            ordered = [calls[i] for i in sorted(calls)]
            if len(ordered) < 2:
                continue
            stops = tuple(r["QuayCode"] for r in ordered)
            route = by_line[line]
            pattern = route["patterns"].setdefault(stops, len(route["patterns"]))
            route["destinations"].add(ordered[-1]["DestinationName"])
            # A skipped stop on a journey that ran is a diversion, not a cancellation: leave it unknown.
            ran = any(r["RecordedArrivalTime"] or r["RecordedDepartureTime"] for r in ordered)
            times = [pattern]
            for r in ordered:
                sa, sd = seconds(r["TargetArrivalTime"]), seconds(r["TargetDepartureTime"])
                if r["TripStopStatus"] == "CANCEL":
                    aa = ad = None if ran else -1
                else:
                    aa, ad = seconds(r["RecordedArrivalTime"]), seconds(r["RecordedDepartureTime"])
                times += [sa, sd, aa, ad]
            drop_layovers(times)
            drop_spikes(times)
            route["days"][date].append(pack(times))

    for line, route in by_line.items():
        row = info[line]
        stop_ids = sorted({q for p in route["patterns"] for q in p})
        index = {q: i for i, q in enumerate(stop_ids)}
        yield {
            "key": f"{operator}-{line}",
            "mode": MODE[row["TransportType"]],
            "operator": OPERATORS[operator],
            "short_name": row["LinePublicNumber"],
            "name": f"{row['TransportType']} {row['LinePublicNumber']}",
            "detail": " / ".join(sorted(route["destinations"])),
            "colour": "#" + row["LineDestColor"] if row["LineDestColor"] else None,
            "stops": {q: quays.get(q, {"name": q}) for q in stop_ids},
            "stop_ids": stop_ids,
            "patterns": [[index[q] for q in p] for p in route["patterns"]],
            "days": {d: [unpack(j) for j in js] for d, js in route["days"].items()},
        }


def all_routes():
    quays = json.loads((DATA / "ref" / "quays.json").read_text())
    for operator in OPERATORS:
        yield from routes(operator, quays)
