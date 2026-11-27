#!/bin/bash
# Rebuild the national route data into site-next with cycling distances from OSRM, then swap it in.
# History is copied from the live data unless HISTORY=1.
set -euo pipefail
cd "$(dirname "$0")"
SITE="$(cd .. && pwd)/site"
# Generated data lives in data/ (each rebuild writes about 15 GB); site/data is a link to data/site-data.
STORE="$(cd "$(dirname "$0")/.." && pwd)/data"
NEXT="$STORE/site-next"
step() { echo "=== $1 $(date +%T)"; }
step build; RJT_DATA="$NEXT" uv run python build.py | { grep -vE '^(transit|trains) ' || true; }
step osrm; ./osrm.sh
step bike; RJT_DATA="$NEXT" uv run python bike.py 10 | tail -3
# The cycle network the dev server and the hosted site route on (bike-network.npz); rebuilt when the map or its code changed.
step bike-network; uv run python -c 'from network import Network; Network.cached("bike")'
if [ "${HISTORY:-0}" = 1 ]; then
  step history; RJT_DATA="$NEXT" uv run python history.py | { grep -vE ' (history|none)$' || true; }
else
  step history-copy; cp -R "$STORE/site-data/history" "$NEXT/history"
fi
if [ "${STAGE_ONLY:-0}" = 1 ]; then
  step ready
  exit 0
fi
step swap
rm -rf "$STORE/site-previous"
mv "$STORE/site-data" "$STORE/site-previous"
mv "$NEXT" "$STORE/site-data"
ln -sfn ../data/site-data "$SITE/data"
step restart; ./restart.sh
step done
