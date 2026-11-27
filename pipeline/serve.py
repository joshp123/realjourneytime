"""Serve the site, plus two answers that need the cycle network: a bike route, and how far you can get.

GET /api/bike-route?a=lat,lon&b=lat,lon
GET /api/reach?lat=..&lon=..&hour=8&minutes=30&kmh=15
GET /api/route, /api/journeys, /api/planner-legs: passed to the journeys service (pipeline/journeys.mjs on port 8766)
Run: uv run python pipeline/serve.py [port]
The cycle network comes from its cache (osm/bike-network.npz, made by rebuild.sh). Without it the server still
answers public transport reach, and says the bike parts are not ready.
"""
import base64
import gzip
import json
import math
import sqlite3
import struct
import sys
import threading
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

import numpy as np
from scipy.spatial import cKDTree

from common import BBOX, DATA, SITE_DATA, rd_to_wgs84
from network import Network
from shapes import simplify

WALK = 80          # metres a minute (4.8 km/h)
BOARD_WITHIN = 1000
S, W, N, E = BBOX
KX = 111320 * math.cos(math.radians((S + N) / 2))
DLAT, DLON = 100 / 111320, 100 / KX
ROWS, COLS = int((N - S) / DLAT) + 1, int((E - W) / DLON) + 1


def pixel(lat, lon):
    return ((N - np.asarray(lat)) / DLAT).astype(int), ((np.asarray(lon) - W) / DLON).astype(int)


def inside(r, c):
    return (r >= 0) & (r < ROWS) & (c >= 0) & (c < COLS)


class Reach:
    def __init__(self, network):
        self.network = network
        # People per 100 m pixel, from CBS's 100 m squares (squares with fewer than 5 people are not published).
        self.people = np.zeros((ROWS, COLS), np.float32)
        db = sqlite3.connect(DATA / "ref" / "cbs_vk100_2024.gpkg")
        rows = db.execute("select crs28992res100m, aantal_inwoners from vierkant_100m where aantal_inwoners > 0").fetchall()
        lat, lon = np.array([rd_to_wgs84(int(c[1:5]) * 100 + 50, int(c[6:10]) * 100 + 50) for c, _ in rows]).T
        r, c = pixel(lat, lon)
        ok = inside(r, c)
        np.add.at(self.people, (r[ok], c[ok]), np.array([p for _, p in rows], np.float32)[ok])
        # Land: pixels within 100 m of a populated square or, once loaded, any street or path.
        land = self.people > 0
        if network:
            r, c = pixel(network.latlon[:, 0], network.latlon[:, 1])
            ok = inside(r, c)
            land[r[ok], c[ok]] = True
        self.land = dilate(land)
        routes = json.loads((SITE_DATA / "reach.json").read_text())["routes"]
        self.pairs, xy, owner = [], [], []
        for route in routes:
            by_from = {}
            for p in route["pairs"]:
                by_from.setdefault(p[0], []).append(p)
            stops = [(lon * KX, lat * 111320) if lat is not None else None for lat, lon in route["stops"]]
            for i, p in by_from.items():
                if stops[i]:
                    xy.append(stops[i])
                    owner.append((stops, p))
        self.boarding, self.owner = cKDTree(np.array(xy)), owner
        print(f"reach: {ROWS}x{COLS} pixels, {self.people.sum():,.0f} people, {len(owner):,} boarding stops", flush=True)

    def transit(self, point, hour, minutes):
        """Walk to any stop within 1 km, ride (90th percentile weekday time), then walk on. No transfers."""
        start = (point[1] * KX, point[0] * 111320)
        circles = [(start, minutes * WALK)]
        for k in self.boarding.query_ball_point(start, BOARD_WITHIN):
            stops, pairs = self.owner[k]
            walk = math.dist(start, self.boarding.data[k])
            h = min(23, int(hour + walk / WALK / 60))
            for p in pairs:
                ride = p[2 + h]
                left = minutes - walk / WALK - ride
                if ride >= 0 and left > 0 and stops[p[1]]:
                    circles.append((stops[p[1]], left * WALK))
        reached = np.zeros((ROWS, COLS), bool)
        for (x, y), radius in circles:
            lat, lon = y / 111320, x / KX
            r0, c0 = pixel(lat + radius / 111320, lon - radius / KX)
            r1, c1 = pixel(lat - radius / 111320, lon + radius / KX)
            r0, c0, r1, c1 = max(r0, 0), max(c0, 0), min(r1 + 1, ROWS), min(c1 + 1, COLS)
            if r0 >= r1 or c0 >= c1:
                continue
            cy = (N - (np.arange(r0, r1) + 0.5) * DLAT) * 111320
            cx = (W + (np.arange(c0, c1) + 0.5) * DLON) * KX
            reached[r0:r1, c0:c1] |= ((cx[None, :] - x) ** 2 + (cy[:, None] - y) ** 2) <= radius ** 2
        return reached & self.land

    def bike(self, point, minutes, kmh):
        nodes, _ = self.network.reach(point, minutes * kmh * 1000 / 60)
        r, c = pixel(self.network.latlon[nodes, 0], self.network.latlon[nodes, 1])
        ok = inside(r, c)
        reached = np.zeros((ROWS, COLS), bool)
        reached[r[ok], c[ok]] = True
        return dilate(reached) & self.land

    def answer(self, point, hour, minutes, kmh):
        out = {"transit": layer(self.transit(point, hour, minutes), self.people, (179, 79, 44))}
        out["bike"] = layer(self.bike(point, minutes, kmh), self.people, (47, 138, 60)) if self.network else {"pending": True}
        return out


def dilate(mask):
    out = mask.copy()
    out[1:] |= mask[:-1]; out[:-1] |= mask[1:]
    out[:, 1:] |= mask[:, :-1]; out[:, :-1] |= mask[:, 1:]
    return out


def layer(mask, people, colour):
    """People reached, and the reached area as a PNG cropped to its own bounds."""
    rows, cols = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
    if not len(rows):
        return {"people": 0, "png": None, "bounds": None}
    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    bounds = [[N - r1 * DLAT, W + c0 * DLON], [N - r0 * DLAT, W + c1 * DLON]]
    return {"people": int(round(float(people[mask].sum()), -3)), "png": png(mask[r0:r1, c0:c1], colour), "bounds": bounds}


def png(mask, colour):
    rgba = np.zeros(mask.shape + (4,), np.uint8)
    rgba[mask] = (*colour, 255)
    raw = b"".join(b"\x00" + row.tobytes() for row in rgba)
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    body = chunk(b"IHDR", struct.pack(">IIBBBBB", mask.shape[1], mask.shape[0], 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + body).decode()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self.static(url.path)
        if url.path in ("/api/route", "/api/journeys", "/api/planner-legs"):
            try:
                with urlopen(f"http://127.0.0.1:8766{self.path}", timeout=120) as r:
                    return self.send_json_bytes(r.read())
            except OSError as error:
                return self.send_error(502, f"journeys service: {error}")
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/bike-route":
                if not NETWORK:
                    return self.send_json({"pending": True, "metres": None, "path": []})
                a, b = (tuple(map(float, q[k].split(","))) for k in ("a", "b"))
                found = NETWORK.path(a, b)
                body = {"metres": None, "path": []} if not found else \
                    {"metres": round(found[1]), "path": simplify(np.array(found[0]), 3).round(5).tolist()}
            elif url.path == "/api/reach":
                body = REACH.answer((float(q["lat"]), float(q["lon"])), int(q.get("hour", 8)),
                                    int(q.get("minutes", 30)), float(q.get("kmh", 15)))
            else:
                return self.send_error(404)
        except (KeyError, ValueError) as error:
            return self.send_error(400, str(error))
        self.send_json(body)

    def static(self, path):
        """Data files go out gzipped: national route files are large and the browser is on Tailscale."""
        file = SITE_DATA.parent / path.lstrip("/")
        if path.startswith("/data/") and file.suffix == ".json" and file.is_file() and \
                "gzip" in self.headers.get("Accept-Encoding", ""):
            # Compress once and keep the copy beside the file; recompressing 80 MB per page view made requests fail.
            packed = file.with_suffix(".json.gz")
            if not packed.exists() or packed.stat().st_mtime < file.stat().st_mtime:
                tmp = packed.with_suffix(f".{threading.get_ident()}.tmp")
                tmp.write_bytes(gzip.compress(file.read_bytes(), 5))
                tmp.replace(packed)
            body = packed.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        return super().do_GET()

    def send_json(self, body):
        self.send_json_bytes(json.dumps(body).encode())

    def send_json_bytes(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if len(data) > 2000 and "gzip" in self.headers.get("Accept-Encoding", ""):
            data = gzip.compress(data, 5)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    NETWORK = Network.cached("bike") if (DATA / "osm" / "bike-network.npz").exists() else None
    REACH = Reach(NETWORK)
    print(f"serving on 0.0.0.0:{port}", flush=True)
    # A page asks for ten files at once; the default queue of 5 waiting connections turned some away (502 at the proxy).
    ThreadingHTTPServer.request_queue_size = 128
    ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=str(SITE_DATA.parent))).serve_forever()
