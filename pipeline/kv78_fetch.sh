#!/bin/bash
# Download the sample days of the KV78 archive, 8 at a time. Finished files are skipped.
set -u
DATA="$(cd "$(dirname "$0")/.." && pwd)/data"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DATA/kv78"
fetch() {
  f="$DATA/kv78/$(basename "$1")"
  if [ ! -f "$f" ]; then
    url="https://trein.fwrite.org/$1"
    for attempt in $(seq 1000); do
      curl -fsS --http1.1 -A 'realjourneytime-nl research' -C - -o "$f.part" "$url" && break
      [ "$attempt" = 1000 ] && { echo "FAIL download $1"; return; }
      sleep 5
    done
    mv "$f.part" "$f"
  fi
}
export -f fetch; export DATA
python3 "$HERE/kv78_dates.py" | xargs -P 8 -I{} bash -c 'fetch {}'
echo ALL DONE
