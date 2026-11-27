"""Tile the directed cycle graph and CBS population grid for the hosted site."""
import gzip
import json
import math
import sqlite3
import struct

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from common import BBOX, rd_to_wgs84

S, W, N, E = BBOX
KX = 111320 * math.cos(math.radians((S + N) / 2))
DLAT, DLON = 100 / 111320, 100 / KX
ROWS, COLS = int((N - S) / DLAT) + 1, int((E - W) / DLON) + 1
PIXELS = 128
GRAPH_SCALE = 5
GRAPH_SOUTH, GRAPH_WEST = 50, 3
GRAPH_STRIDE = 64
NODE_BITS = 20


def write(out, name, body, compress=True):
    path = out / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(body, 4, mtime=0) if compress else body)


def pixel(lat, lon):
    return ((N - lat) / DLAT).astype(int), ((lon - W) / DLON).astype(int)


def pack_grid(data, out, latlon):
    population = np.zeros((ROWS, COLS), dtype="<u2")
    db = sqlite3.connect((data / "ref" / "cbs_vk100_2024.gpkg").as_uri() + "?mode=ro", uri=True)
    with db:
        squares = db.execute(
            "select crs28992res100m, aantal_inwoners from vierkant_100m where aantal_inwoners > 0"
        ).fetchall()
    db.close()
    lat, lon = np.array([rd_to_wgs84(int(c[1:5]) * 100 + 50, int(c[6:10]) * 100 + 50) for c, _ in squares]).T
    r, c = pixel(lat, lon)
    ok = (r >= 0) & (r < ROWS) & (c >= 0) & (c < COLS)
    np.add.at(population, (r[ok], c[ok]), np.array([p for _, p in squares], dtype="<u2")[ok])
    r, c = pixel(latlon[:, 0], latlon[:, 1])
    ok = (r >= 0) & (r < ROWS) & (c >= 0) & (c < COLS)
    roads = population > 0
    roads[r[ok], c[ok]] = True
    land = roads.copy()
    land[1:] |= roads[:-1]
    land[:-1] |= roads[1:]
    land[:, 1:] |= roads[:, :-1]
    land[:, :-1] |= roads[:, 1:]
    tiles = []
    for row in range(0, ROWS, PIXELS):
        for col in range(0, COLS, PIXELS):
            region = land[row:row + PIXELS, col:col + PIXELS]
            if region.any():
                # Top bit denotes land, low 15 bits hold population.
                people = population[row:row + PIXELS, col:col + PIXELS]
                if people.max() >= 32768:
                    raise ValueError("Population cell exceeds packed range")
                body = np.zeros((PIXELS, PIXELS), dtype="<u2")
                body[:people.shape[0], :people.shape[1]] = people | (region.astype("<u2") << 15)
                key = f"{row // PIXELS}/{col // PIXELS}"
                write(out, f"grid/{key}.bin.gz", body.tobytes())
                tiles.append(key)
    return tiles


def pack_graph(out, latlon, weights, edges, offsets):
    n = len(latlon)
    graph = csr_matrix((weights, edges, offsets), shape=(n, n))
    _, labels = connected_components(graph, directed=True, connection="strong")
    main = np.bincount(labels)[labels] >= 1000
    lat = np.floor((latlon[:, 0] - GRAPH_SOUTH) * GRAPH_SCALE).astype(np.int32)
    lon = np.floor((latlon[:, 1] - GRAPH_WEST) * GRAPH_SCALE).astype(np.int32)
    if min(lat.min(), lon.min()) < 0 or lat.max() >= GRAPH_STRIDE or lon.max() >= GRAPH_STRIDE:
        raise ValueError("Cycle graph extends outside its tile id range")
    tile = lat * GRAPH_STRIDE + lon
    order = tile.argsort(kind="stable")
    sizes = np.bincount(tile)
    starts = np.r_[0, np.cumsum(sizes)]
    if sizes.max() >= 1 << NODE_BITS:
        raise ValueError("Cycle tile exceeds its node id range")
    ids = np.empty(n, dtype=np.uint32)
    ids[order] = (tile[order].astype(np.uint32) << NODE_BITS) + np.arange(n) - starts[tile[order]]
    tiles = []
    for t in np.flatnonzero(sizes):
        nodes = order[starts[t]:starts[t + 1]]
        degree = offsets[nodes + 1] - offsets[nodes]
        first = np.r_[0, np.cumsum(degree)].astype("<u4")
        loc = np.repeat(offsets[nodes] - first[:-1].astype(int), degree) + np.arange(first[-1])
        coordinates = np.round(latlon[nodes].T * 1e6).astype("<i4")
        # Bit 31 of the latitude marks nodes eligible for snapping.
        coordinates[0] = coordinates[0].astype("<u4") | (main[nodes].astype("<u4") << 31)
        length = np.ceil(weights[loc] * 100).astype("<u4")
        write(out, f"public/bike/{t}.bin.gz", b"".join((
            struct.pack("<II", len(nodes), len(loc)), coordinates.tobytes(), first.tobytes(),
            ids[edges[loc]].astype("<u4").tobytes(), length.tobytes(),
        )))
        tiles.append(int(t))
    return tiles


def pack_map(data, out):
    with np.load(data / "osm" / "bike-network.npz") as archive:
        latlon = archive["latlon"]
        grid = pack_grid(data, out, latlon)
        bike = pack_graph(out, latlon, archive["data"], archive["indices"], archive["indptr"])
    write(out, "public/bike/index.json.gz", json.dumps({"tiles": bike}).encode())
    write(out, "grid/index.json.gz", json.dumps({"tiles": grid}).encode())
    print(f"Packed {len(bike)} graph tiles and {len(grid)} population tiles", flush=True)
