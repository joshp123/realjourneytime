"""The line each route follows on the map.

Trains and every bus, tram and metro operator except RET: the shapes in the national GTFS timetable
(gtfs.ovapi.nl). Each pattern gets the shape of the same line or train series that passes closest to all its
stops, cut from its first stop to its last.
RET: GTFS has only straight lines between stops, so each pair of consecutive stops is routed along
OpenStreetMap's tram tracks, metro tracks or bus roads.
Where neither works, the map keeps straight lines between stops.
"""
import csv
import io
import math
import zipfile
from collections import defaultdict

import numpy as np

from common import BBOX, DATA
from network import Network

LAT0 = (BBOX[0] + BBOX[2]) / 2
KX, KY = 111320 * math.cos(math.radians(LAT0)), 111320


def gtfs_rows(name):
    with zipfile.ZipFile(DATA / "gtfs" / "gtfs-nl.zip") as z, z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


class Shapes:
    def __init__(self):
        self.lines = defaultdict(set)   # (operator, line planning number) -> shape ids
        self.trains = defaultdict(set)  # train number -> shape ids
        self.public = defaultdict(set)  # (operator, public line number) -> shape ids, when line codes differ
        public = {r["route_id"]: r["route_short_name"] for r in gtfs_rows("routes.txt")}
        for t in gtfs_rows("trips.txt"):
            parts = t["realtime_trip_id"].split(":")
            if parts[0] == "IFF" and t["trip_short_name"].isdigit():
                self.trains[int(t["trip_short_name"]) % 100000].add(t["shape_id"])
            elif len(parts) == 3 and parts[0] != "RET":
                self.lines[(parts[0], parts[1])].add(t["shape_id"])
                self.public[(parts[0], public.get(t["route_id"]))].add(t["shape_id"])
        wanted = set().union(*self.lines.values(), *self.trains.values())
        points = defaultdict(list)
        for p in gtfs_rows("shapes.txt"):
            if p["shape_id"] in wanted:
                points[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))
        self.points = {k: np.array([(lat, lon) for _, lat, lon in sorted(v)]) for k, v in points.items()}
        self.networks = {}
        print(f"shapes: {len(self.points)} loaded")

    def routed(self, route, stops):
        """The pattern routed stop to stop along the vehicle's own network."""
        if route["mode"] not in self.networks:
            self.networks[route["mode"]] = Network(route["mode"])
        network = self.networks[route["mode"]]
        out = []
        for a, b in zip(stops, stops[1:]):
            pa, pb = (a["lat"], a["lon"]), (b["lat"], b["lon"])
            straight = math.dist(network.project(*pa), network.project(*pb))
            found = network.path(pa, pb)
            leg = found[0] if found and found[1] < 3 * straight + 500 else [list(pa), list(pb)]
            out += leg if not out else leg[1:]
        return np.array(out)

    def candidates(self, route):
        if route["mode"] != "train":
            operator, line = route["key"].split("-", 1)
            return self.lines.get((operator, line), set()) | self.public.get((operator, route["short_name"]), set())
        series = int(route["key"].rsplit("-", 1)[1])
        return set().union(*(self.trains.get(n, set()) for n in range(series, series + 100)))

    def attach(self, route):
        """Add "shapes" (lists of [lat, lon]) and "pattern_shape" (index per pattern, or None) to the route."""
        candidates = [self.points[s] for s in self.candidates(route) if s in self.points]
        shapes, index, chosen = [], {}, []
        for pattern in route["patterns"]:
            stops = [route["stops"][route["stop_ids"][i]] for i in pattern]
            if not all("lat" in s for s in stops):
                cut = None
            elif route["key"].startswith("RET-"):
                cut = self.routed(route, stops)
            else:
                cut = best_cut(stops, candidates)
            if cut is None:
                chosen.append(None)
                continue
            key = cut.tobytes()
            if key not in index:
                index[key] = len(shapes)
                shapes.append([[round(lat, 5), round(lon, 5)] for lat, lon in simplify(cut, 4)])
            chosen.append(index[key])
        route["shapes"], route["pattern_shape"] = shapes, chosen


def xy(latlon):
    return np.column_stack([latlon[:, 1] * KX, latlon[:, 0] * KY])


def nearest_segments(points, line):
    """Distance from each point to the polyline, and the index of the nearest segment."""
    a, b = line[:-1], line[1:]
    ab = b - a
    length2 = np.maximum((ab ** 2).sum(1), 1e-9)
    t = np.clip(((points[:, None, :] - a[None]) * ab[None]).sum(2) / length2, 0, 1)
    d = np.linalg.norm(points[:, None, :] - (a[None] + t[..., None] * ab[None]), axis=2)
    return d, d.argmin(1)


def best_cut(stops, candidates, limit=150):
    pts = xy(np.array([(s["lat"], s["lon"]) for s in stops]))
    best = None
    for shape in candidates:
        if len(shape) < 2:
            continue
        d, _ = nearest_segments(pts, xy(shape))
        # Walk the stops along the shape in order, so loops and out-and-back routes cut the right way.
        pos, worst, ok = 0, 0, True
        positions = []
        for row in d:
            ahead = row[pos:]
            j = int(ahead.argmin()) + pos
            if row[j] > limit:
                ok = False
                break
            positions.append(j)
            worst, pos = max(worst, row[j]), j
        if ok and (best is None or worst < best[0]):
            best = (worst, shape[positions[0]:positions[-1] + 2])
    return None if best is None else best[1]


def simplify(latlon, tolerance):
    """Douglas-Peucker in metres."""
    pts = xy(latlon)
    keep = np.zeros(len(pts), bool)
    keep[[0, -1]] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = pts[j] - pts[i]
        n = np.linalg.norm(seg)
        rel = pts[i + 1:j] - pts[i]
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n if n else np.linalg.norm(rel, axis=1)
        k = int(d.argmax())
        if d[k] > tolerance:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return latlon[keep]
