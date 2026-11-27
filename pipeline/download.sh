#!/bin/bash
# Download every input except the bus, tram and metro archive (kv78_fetch.sh) into data/. About 3 GB.
# Finished files are skipped, so it can be run again. data/ can be a link to a bigger disk.
set -euo pipefail
DATA="$(cd "$(dirname "$0")/.." && pwd)/data"
get() {  # get <folder> <url>
  mkdir -p "$DATA/$1"
  local file="$DATA/$1/$(basename "$2")"
  [ -f "$file" ] && return
  curl -fL --retry 5 -C - -o "$file.part" "$2" && mv "$file.part" "$file"
}
RDT=https://opendata.rijdendetreinen.nl/public
# Trains: one file a month for the year the site covers, and one a year for the History view.
for month in 2025-09 2025-10 2025-11 2025-12 2026-01 2026-02 2026-03 2026-04 2026-05 2026-06 2026-07 2026-08 2026-09; do
  get trains "$RDT/services/services-$month.csv.gz"
done
for year in 2019 2020 2021 2022 2023 2024; do get trains "$RDT/services/services-$year.csv.gz"; done
get ref "$RDT/stations/stations-2023-09-nl.csv"
# Stops: the latest national stop register.
chb=$(curl -fsL https://data.ndovloket.nl/haltes/ | grep -o 'href="ExportCHB_[0-9-]*\.xml\.gz"' | tail -1 | cut -d'"' -f2)
get ref "https://data.ndovloket.nl/haltes/$chb"
# Population in 100 m squares.
get ref https://service.pdok.nl/cbs/vierkantstatistieken100m/atom/downloads/cbs_vk100_2024.gpkg
# Route shapes for the maps.
get gtfs https://gtfs.ovapi.nl/nl/gtfs-nl.zip
# Streets and cycle paths.
mkdir -p "$DATA/osm"
[ -f "$DATA/osm/netherlands.osm.pbf" ] || curl -fL --retry 5 -o "$DATA/osm/netherlands.osm.pbf" https://download.geofabrik.de/europe/netherlands-latest.osm.pbf
[ -f "$DATA/osm/zuid-holland.osm.pbf" ] || curl -fL --retry 5 -o "$DATA/osm/zuid-holland.osm.pbf" https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf
echo "done; now run pipeline/kv78_fetch.sh for buses, trams and metros"
