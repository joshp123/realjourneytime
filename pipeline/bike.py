"""Add cycling distances between the stops of every route already built, then rerun the ranking. Runs after build.py.

Distances come from OSRM on a bicycle profile tuned for the Netherlands (bike-osrm.lua), counting ferries that run
all year. osrm.sh builds the graph; this script starts its own OSRM server and stops it when done.
Run: uv run python bike.py [workers]
"""
import json
import multiprocessing as mp
import subprocess
import sys
import time
from urllib.request import urlopen

from common import DATA, SITE_DATA

LIMIT = 80000  # 80 km: under two hours at 45 km/h, the fastest speed the page offers (a speed pedelec)
SNAP_LIMIT = 500  # a stop further than this from any path is off the map (in Belgium or Germany): no bike time
GRAPH = DATA / "osrm" / "nl.osrm"
PORT = 5062
OSRM = f"http://127.0.0.1:{PORT}"


def matrix(points):
    """Metres by bike between every pair of (lat, lon) points; None where there is no route within the limits."""
    coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    with urlopen(f"{OSRM}/table/v1/bike/{coords}?annotations=distance", timeout=600) as r:
        body = json.load(r)
    # OSRM measures from where each point meets the network; the ride to and from it counts too.
    snap = [w["distance"] for w in body["sources"]]
    return [[None if d is None or snap[i] > SNAP_LIMIT or snap[j] > SNAP_LIMIT or d + snap[i] + snap[j] > LIMIT
             else 0 if i == j else round(d + snap[i] + snap[j]) for j, d in enumerate(row)]
            for i, row in enumerate(body["distances"])]


def add_distances(key):
    path = SITE_DATA / "routes" / f"{key}.json"
    route = json.loads(path.read_text())
    stops = route["stop_ids"]
    located = [i for i, s in enumerate(stops) if "lat" in route["stops"][s]]
    found = matrix([(route["stops"][stops[i]]["lat"], route["stops"][stops[i]]["lon"]) for i in located]) \
        if len(located) > 1 else [[0]] * len(located)
    metres = [[0 if i == j else None for j in range(len(stops))] for i in range(len(stops))]
    for a, i in enumerate(located):
        for b, j in enumerate(located):
            metres[i][j] = found[a][b]
    route["bike_metres"] = metres
    path.with_suffix(".tmp").write_text(json.dumps(route, separators=(",", ":"), ensure_ascii=False))
    path.with_suffix(".tmp").rename(path)
    return key


def serve():
    """Start OSRM on the graph and wait until it answers. The graph is read from disk as needed (--mmap), so the
    server takes little memory of its own."""
    # osrm-routed rejects a graph path with spaces in it, so it runs in the graph's folder.
    server = subprocess.Popen(["osrm-routed", "--algorithm", "ch", "--mmap", "-i", "127.0.0.1", "-p", str(PORT),
                               "--max-table-size", "1000", GRAPH.name], cwd=GRAPH.parent,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(300):
        try:
            urlopen(f"{OSRM}/nearest/v1/bike/5.11,52.09", timeout=5).close()
            return server
        except OSError:
            if server.poll() is not None:
                raise RuntimeError("osrm-routed stopped: is the graph built? Run osrm.sh")
            time.sleep(1)
    server.terminate()
    raise RuntimeError("osrm-routed did not answer within 5 minutes")


def main(workers):
    started = time.time()
    index = json.loads((SITE_DATA / "index.json").read_text())
    keys = [r["key"] for r in index["routes"]]
    server = serve()
    try:
        with mp.get_context("fork").Pool(workers) as pool:
            for n, _ in enumerate(pool.imap_unordered(add_distances, keys), 1):
                if n % 200 == 0:
                    print(f"{n}/{len(keys)} routes, {time.time() - started:.0f} s", flush=True)
    finally:
        server.terminate()
        server.wait()
    index["bike"] = True
    (SITE_DATA / "index.json").write_text(json.dumps(index, ensure_ascii=False))
    print(f"bike distances written in {time.time() - started:.0f} s", flush=True)
    subprocess.run(["nix", "shell", "nixpkgs#nodejs", "-c", "node", "--max-old-space-size=12000", "rank.mjs"], check=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
