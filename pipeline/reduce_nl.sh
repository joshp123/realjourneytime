#!/bin/bash
# Reduce every downloaded day to national bus, tram and metro stop calls, two days at a time (3 GB each).
# Days not downloaded yet are skipped, so this can run again and again while kv78_fetch.sh works.
DATA="$(cd "$(dirname "$0")/.." && pwd)/data"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DATA/kv78-nl"
reduce_day() {
  [ -f "$DATA/kv78-nl/RET/$1.tsv.gz" ] || [ ! -f "$DATA/kv78/KV78_$1.csv.xz" ] && return
  python3 -I "$HERE/kv78_filter.py" "$DATA/kv78/KV78_$1.csv.xz" "$DATA/kv78-nl" || echo "FAIL reduce $1"
}
export -f reduce_day; export DATA HERE
python3 -c "import sys; sys.path.insert(0, '$HERE'); from kv78_dates import days; print('\n'.join(d.isoformat() for d in days()))" |
  xargs -P "${PARALLEL:-2}" -I{} bash -c 'reduce_day {}'
echo "REDUCE DONE"
