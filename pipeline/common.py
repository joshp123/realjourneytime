"""Shared paths and helpers."""
import math
import os
from array import array
from pathlib import Path

# Downloads and builds go in data/ at the top of the repo: tens of gigabytes, so it can be a link to a bigger disk.
DATA = Path(__file__).resolve().parent.parent / "data"
# The site's data folder. Builds write to another folder (RJT_DATA) and swap it in when complete.
SITE_DATA = Path(os.environ.get("RJT_DATA") or Path(__file__).resolve().parent.parent / "site" / "data")

# The Netherlands, Cadzand to Bad Nieuweschans, Eijsden to Schiermonnikoog.
BBOX = (50.70, 3.30, 53.60, 7.25)  # south, west, north, east
NATIONAL_PBF = "netherlands.osm.pbf"
# RET's own tracks and roads are routed on the smaller regional extract.
REGIONAL_PBF = "zuid-holland.osm.pbf"


def in_bbox(lat, lon):
    s, w, n, e = BBOX
    return s <= lat <= n and w <= lon <= e


def rd_to_wgs84(x, y):
    """Dutch RD New to WGS84 (Schreutelkamp and Strang van Hees, about 1 m accuracy)."""
    dx, dy = (x - 155000) * 1e-5, (y - 463000) * 1e-5
    lat = (52.15517440 + (3235.65389 * dy - 32.58297 * dx**2 - 0.24750 * dy**2 - 0.84978 * dx**2 * dy
           - 0.06550 * dy**3 - 0.01709 * dx**2 * dy**2 - 0.00738 * dx + 0.00530 * dx**4
           - 0.00039 * dx**2 * dy**3 + 0.00033 * dx**4 * dy - 0.00012 * dx * dy) / 3600)
    lon = (5.38720621 + (5260.52916 * dx + 105.94684 * dx * dy + 2.45656 * dx * dy**2 - 0.81885 * dx**3
           + 0.05594 * dx * dy**3 - 0.05607 * dx**3 * dy + 0.01199 * dy - 0.00256 * dx**3 * dy**2
           + 0.00128 * dx * dy**4 + 0.00022 * dy**2 - 0.00022 * dx**2 + 0.00026 * dx**5) / 3600)
    return lat, lon


def metres(a, b):
    """Approximate distance in metres between two (lat, lon) points."""
    dlat = (a[0] - b[0]) * 111320
    dlon = (a[1] - b[1]) * 111320 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


# Journey times are held as compact arrays while a whole operator or the whole railway is in memory.
# -1 means cancelled; None (unknown) is stored as -2.
def pack(times):
    return array("i", [-2 if t is None else t for t in times])


def unpack(packed):
    return [None if t == -2 else t for t in packed]
