# Real Journey Time Netherlands

How long Dutch trains, metros, trams and buses really take, from a year of recorded journeys, and when the bike
is quicker. Live at [realjourneytime.jjpcodes.com](https://realjourneytime.jjpcodes.com/).

A Dutch version of Tom Forth's [Real Journey Time](https://tomforth.co.uk/realjourneytime/), which covers buses in
England. The idea and the "9 days in 10" measure are his.

## What it shows

- **Journey times:** every recorded journey between two places, on every line that makes the trip: what the
  timetable says, what happens on average, how long you must leave to be sure (enough for 9 journeys in 10), and
  how long the bike takes. Each dot is one journey; point at it to read it, or download them all.
- **A line, stop by stop:** every vehicle that ran on a chosen day, drawn from its recorded time at each stop,
  and how long each stretch between stops takes, usually and in its slowest hour.
- **How far can I get?** how many people you can reach in 30, 45 or 60 minutes from a point, by public transport
  and by bike.
- **Where the bike wins:** the share of trips the bike is quicker on, by train, metro, tram and bus, at 15 to
  45 km/h, and its biggest win on each line.

## How the numbers are worked out

You pick two places, never a line. A place is a stop as a passenger knows it: every platform with one name, and
a station together with the stops at it (`pipeline/packed.mjs`). The page finds every line that runs from one to
the other without a change and reads all their recorded rides (`site/data.js`).

The time for a journey runs from its timetabled departure to when you actually arrive. If your vehicle was
cancelled, or another vehicle on any line between the same two places got there first, that one counts, wait
included. Times with no service for 2 hours or more (a strike or a closure) are left out. "To be sure" is the
90th percentile of these times, over a one-hour window centred on each arrival. The calculation is in
`site/stats.js` and `site/trip.js`.

Lines that take about the same time by timetable are drawn together (Tram 2, 12 and 24). Where they differ by
more than a tenth (Intercity, Sprinter, Metro E) the chart opens on the fastest and never averages them. When
fewer than half the timetabled journeys were tracked, the chart shows dots without lines and says so.

The bike uses the shortest legal route on OpenStreetMap at the speed you choose, with no time for lights or
parking. Distances between stops come from [OSRM](https://project-osrm.org/) with a bicycle profile tuned for Dutch
paving and cycle paths (`pipeline/bike-osrm.lua`), counting ferries that run all year (`pipeline/ferries.py`).

## Data

None of the data is in this repository: the raw archive alone is about 260 GB. `pipeline/download.sh` fetches
everything except the bus, tram and metro archive, and `pipeline/kv78_fetch.sh` fetches that.

| Data | Source | Licence |
| --- | --- | --- |
| Every Dutch passenger train, with delays and cancellations | [Rijden de Treinen train archive](https://www.rijdendetreinen.nl/en/open-data/train-archive) | CC BY 4.0 |
| Buses, trams and metros of Arriva, Connexxion, EBS, GVB, HTM, Keolis, Qbuzz and RET (daily KV78 files, about 1 GB a day) | Adriaan van Natijne's [archive of Dutch travel information](https://trein.fwrite.org/) | CC BY 4.0 |
| Stops | National stop register (CHB) from [NDOV Loket](https://data.ndovloket.nl/haltes/) | See source |
| Route shapes for the maps | National GTFS from [openOV](https://gtfs.ovapi.nl/) | See source |
| Streets and cycle paths | [OpenStreetMap](https://www.openstreetmap.org/copyright), via [Geofabrik](https://download.geofabrik.de/europe/netherlands.html) | ODbL |
| Population in 100 m squares, 2024 | [CBS](https://www.cbs.nl/nl-nl/dossier/nederland-regionaal/geografische-data/kaart-van-100-meter-bij-100-meter-met-statistieken) via PDOK | CC BY 4.0 |

The archive server gives about 200 KB/s per connection, so a year of bus, tram and metro data takes days to
download. `pipeline/kv78_days.txt` lists the days used.

## Build and run

Everything is written to `data/` at the top of the repository: about 300 GB with the raw archive, so `data` can
be a link to a bigger disk. You need [uv](https://docs.astral.sh/uv/), Node.js and, for the bike distances,
OSRM (`osrm-extract`, `osrm-contract`, `osrm-routed`).

```sh
pipeline/download.sh                  # trains, stops, shapes, maps and population (about 3 GB)
pipeline/fetch_year.sh                # the bus, tram and metro archive, reduced day by day as it arrives
uv run python pipeline/stops.py       # the stop register
pipeline/rebuild.sh                   # routes, bike distances and rankings, into site/data
uv run python pipeline/serve.py 8765  # the site at http://localhost:8765/
```

`pipeline/restart.sh` restarts the local server and the journeys service it uses (`pipeline/journeys.mjs`).

`uv run python hosting/bike_table.py site/data` writes the bike tables the local server reads.
`uv run --with playwright python tests/pages.py http://localhost:8765` uses every page as a visitor would, on a
phone and a laptop, and fails on anything broken.

## Hosting

The live site runs on ChatGPT Sites: a Cloudflare Worker (`hosting/worker.mjs`) serves the page and answers its
questions from data packed into R2 (`hosting/pack.py`). `docs/sites-data.md` describes the data layout.

## Licence

The code is under the MIT licence. The data keeps its own licences, above.
