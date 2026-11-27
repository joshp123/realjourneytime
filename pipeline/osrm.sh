#!/bin/bash
# Build the OSRM bicycle graph that bike.py measures stop-to-stop distances on, when the map, the profile or the
# ferry rule is newer than the graph. About 10 minutes and 5 GB of memory; the graph is 3.3 GB.
# OSRM comes from Homebrew (brew install osrm-backend); the nix package is broken on Apple silicon.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
STORE="$(cd "$(dirname "$0")/.." && pwd)/data"
OSRM="${OSRM_DIR:-$STORE/osrm}"
PBF="${OSRM_PBF:-$STORE/osm/netherlands.osm.pbf}"
GRAPH="$OSRM/nl.osrm.hsgr"
if [ -f "$GRAPH" ] && [ "$GRAPH" -nt "$PBF" ] && [ "$GRAPH" -nt bike-osrm.lua ] && [ "$GRAPH" -nt ferries.py ]; then
  echo "OSRM graph is up to date"
  exit 0
fi
mkdir -p "$OSRM"
uv run python ferries.py "$PBF" "$OSRM/summer-ferries.txt"
ln -sfn "$PBF" "$OSRM/nl.osm.pbf"
cd "$OSRM"
osrm-extract -p "$HERE/bike-osrm.lua" -t 8 nl.osm.pbf > extract.log 2>&1 || { tail -20 extract.log; exit 1; }
osrm-contract -t 8 nl.osrm > contract.log 2>&1 || { tail -20 contract.log; exit 1; }
echo "OSRM graph built in $OSRM"
