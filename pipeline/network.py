"""Routable OpenStreetMap networks for the region: cycling, and the tracks and roads RET's vehicles use."""
import math
from pathlib import Path

import numpy as np
import osmium
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

from common import BBOX, DATA, NATIONAL_PBF, REGIONAL_PBF
from ferries import runs_all_year, takes_bikes

SNAP_LIMIT = 500  # metres from the nearest path; further is the sea, or over the border
DETOUR = 5  # a route search gives up beyond this many times the straight line (or 5 km more on short trips)

RIDEABLE = {"cycleway", "path", "residential", "living_street", "service", "unclassified", "tertiary",
            "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "track", "road"}
BY_PERMISSION = {"footway", "pedestrian", "bridleway", "trunk", "trunk_link", "steps"}
DRIVABLE = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
            "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
            "service", "road", "busway", "bus_guideway"}
NO = {"no", "private", "use_sidepath", "dismount"}


def bike(tags):
    if tags.get("route") == "ferry":
        return takes_bikes(tags) and runs_all_year(dict(tags))
    highway, bicycle = tags.get("highway"), tags.get("bicycle")
    # Sand paths in the dunes and on the heath are walked, not ridden (OSRM's profile rides them at 3 km/h).
    if tags.get("surface") == "sand" and bicycle not in {"yes", "designated"}:
        return False
    if highway in RIDEABLE:
        return bicycle not in NO and tags.get("access") not in {"no", "private"} or bicycle in {"yes", "designated"}
    return highway in BY_PERMISSION and bicycle in {"yes", "designated"}


def bus(tags):
    if tags.get("highway") not in DRIVABLE:
        return False
    psv = {tags.get("bus"), tags.get("psv")}
    return tags.get("access") not in {"no", "private"} or bool(psv & {"yes", "designated"})


MODES = {
    "bike": (bike, "bicycle"),
    "bus": (bus, "bus"),
    "tram": (lambda t: t.get("railway") == "tram", None),
    "metro": (lambda t: t.get("railway") in {"subway", "light_rail"}, None),
}


class Network:
    def __init__(self, mode="bike"):
        allowed, oneway_key = MODES[mode]
        s, w, n, e = BBOX
        self.lat0 = (s + n) / 2
        ids, latlon, edges, ferry_ends = {}, [], [], []
        pbf = NATIONAL_PBF if mode == "bike" else REGIONAL_PBF
        processor = osmium.FileProcessor(str(DATA / "osm" / pbf)) \
            .with_locations().with_filter(osmium.filter.KeyFilter("highway", "railway", "route"))
        for way in processor:
            if not isinstance(way, osmium.osm.Way) or not allowed(way.tags):
                continue
            nodes = [(nd.ref, nd.lat, nd.lon) for nd in way.nodes if nd.location.valid()]
            inside = [s <= lat <= n and w <= lon <= e for _, lat, lon in nodes]
            ferry = way.tags.get("route") == "ferry"
            # A ferry has to stay on the map: the ones to England and Germany lead nowhere a stop is.
            if len(nodes) < 2 or not any(inside) or ferry and not all(inside):
                continue
            forward = backward = True
            if oneway_key:
                oneway = way.tags.get("oneway")
                exempt = way.tags.get(f"oneway:{oneway_key}") == "no" or \
                    (oneway_key == "bicycle" and way.tags.get("cycleway", "").startswith("opposite")) or \
                    (oneway_key == "bus" and way.tags.get("oneway:psv") == "no")
                if not exempt:
                    backward = oneway not in {"yes", "1", "true"}
                    forward = oneway != "-1"
            for (a, alat, alon), (b, blat, blon) in zip(nodes, nodes[1:]):
                for ref, lat, lon in ((a, alat, alon), (b, blat, blon)):
                    if ref not in ids:
                        ids[ref] = len(latlon)
                        latlon.append((lat, lon))
                ia, ib = ids[a], ids[b]
                length = math.dist(self.project(alat, alon), self.project(blat, blon))
                if forward:
                    edges.append((ia, ib, length))
                if backward:
                    edges.append((ib, ia, length))
            if ferry:
                ferry_ends += [ids[nodes[0][0]], ids[nodes[-1][0]]]
        self.latlon = np.array(latlon)
        self.coords = np.column_stack([self.latlon[:, 1] * self.kx, self.latlon[:, 0] * 111320])
        a, b, length = map(np.array, zip(*edges))
        self.graph = csr_matrix((length, (a, b)), shape=(len(latlon), len(latlon)))
        # Many ferries end on a pier or a footbridge you walk along (Vlissingen, Den Helder, Terschelling, Rotterdam's
        # waterbuses), cut off from the network on land: join each ferry end to the nearest point within 300 m of any
        # large piece of the network other than its own.
        _, labels = connected_components(self.graph, directed=True, connection="strong")
        sizes = np.bincount(labels)
        large = np.flatnonzero(sizes[labels] >= 1000)
        tree = cKDTree(self.coords[large])
        for end in set(ferry_ends):
            gaps, near = tree.query(self.coords[end], k=64, distance_upper_bound=300)
            for gap, i in zip(gaps, near):
                if np.isfinite(gap) and labels[large[i]] != labels[end]:
                    edges += [(end, large[i], gap), (large[i], end, gap)]
                    break
        a, b, length = map(np.array, zip(*edges))
        self.graph = csr_matrix((length, (a, b)), shape=(len(latlon), len(latlon)))
        self.index_main()
        print(f"{mode} network: {len(latlon)} nodes, {len(edges)} edges", flush=True)

    @classmethod
    def cached(cls, mode="bike"):
        """The network from its .npz cache, building and saving it when the map or the code that makes it is newer."""
        path = DATA / "osm" / f"{mode}-network.npz"
        sources = [DATA / "osm" / (NATIONAL_PBF if mode == "bike" else REGIONAL_PBF), Path(__file__),
                   Path(__file__).with_name("ferries.py")]
        if not path.exists() or path.stat().st_mtime < max(p.stat().st_mtime for p in sources):
            built = cls(mode)
            g = built.graph
            np.savez(path.with_suffix(".tmp.npz"), latlon=built.latlon, data=g.data, indices=g.indices,
                     indptr=g.indptr, lat0=built.lat0)
            path.with_suffix(".tmp.npz").rename(path)
            return built
        z = np.load(path)
        self = cls.__new__(cls)
        self.lat0 = float(z["lat0"])
        self.latlon = z["latlon"]
        self.coords = np.column_stack([self.latlon[:, 1] * self.kx, self.latlon[:, 0] * 111320])
        n = len(self.latlon)
        self.graph = csr_matrix((z["data"], z["indices"], z["indptr"]), shape=(n, n))
        self.index_main()
        print(f"{mode} network: {n} nodes from cache", flush=True)
        return self

    @property
    def kx(self):
        return 111320 * math.cos(math.radians(self.lat0))

    def project(self, lat, lon):
        return (lon * self.kx, lat * 111320)

    def index_main(self):
        """Snap only to the main network, where every node can reach every other one and be reached back. A stop
        snapped to a one-way stub or a path that joins nothing would get no route at all (Schiphol, Den Haag
        Centraal and 's-Hertogenbosch did). Islands without a year-round ferry stay their own pieces."""
        _, labels = connected_components(self.graph, directed=True, connection="strong")
        sizes = np.bincount(labels)
        self.main = np.flatnonzero(sizes[labels] >= 1000)
        self.tree = cKDTree(self.coords[self.main])

    def snap(self, points):
        distance, i = self.tree.query(np.array([self.project(lat, lon) for lat, lon in points]))
        return distance, self.main[i]

    def path(self, a, b):
        """[[lat, lon], ...] along the network from point a to point b, and its length in metres; None if none,
        or if either point is over 500 m from a path (the sea, or over the border). The same rules as the hosted
        site's router (hosting/bike.mjs)."""
        snap, (na, nb) = self.snap([a, b])
        if snap.max() > SNAP_LIMIT:
            return None
        straight = math.dist(self.project(*a), self.project(*b))
        dist, pred = dijkstra(self.graph, indices=na, return_predecessors=True,
                              limit=max(DETOUR * straight, straight + 5000))
        if math.isinf(dist[nb]):
            return None
        nodes = [nb]
        while nodes[-1] != na:
            nodes.append(pred[nodes[-1]])
        return [list(a)] + self.latlon[nodes[::-1]].tolist() + [list(b)], float(dist[nb] + snap.sum())

    def reach(self, point, metres):
        """Distance in metres to every node reachable from point within the given distance."""
        snap, i = self.tree.query(self.project(*point))
        if snap > SNAP_LIMIT:
            return np.array([], dtype=int), np.array([])
        node = self.main[i]
        dist = dijkstra(self.graph, indices=node, limit=max(0.0, metres - snap)) + snap
        reached = np.isfinite(dist)
        return np.flatnonzero(reached), dist[reached]

    def distances(self, points):
        """Matrix of distances in metres between (lat, lon) points along the network; None where unreachable."""
        snap, nodes = self.snap(points)
        matrix = []
        for start in range(0, len(nodes), 16):
            chunk = dijkstra(self.graph, indices=nodes[start:start + 16], limit=60000)
            for i, row in enumerate(chunk):
                d = row[nodes] + snap[start + i] + snap
                matrix.append([None if math.isinf(v) else round(float(v)) for v in d])
        return matrix
