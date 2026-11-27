# Real Journey Time on ChatGPT Sites

The browser and the development server keep their existing URLs. Sites serves the
pages from its Worker bundle and the generated data from a private R2 bucket.
The MacBook runs the offline data build. The deployed Site has no dependency on it.

| URL | Data contract |
| --- | --- |
| `GET /data/index.json` | Existing national route index. |
| `GET /api/route?key=K` | Existing route metadata, stop coordinates, shapes, bike distances and date coverage. |
| `GET /api/journeys?route=K&from=A&to=B&days=weekdays&start=YYYY-MM-DD&end=YYYY-MM-DD` | Existing chart records and counters. The Worker selects columns for the two stops and uses the shared Real Journey Time calculation across the selected line and alternatives. |
| `GET /api/planner-legs?days=weekdays&leg=K,A,B,lo,hi&leg=...` | Day-aligned sampled legs for planning. The browser picks and replays itineraries with up to one change. |
| `GET /data/planner/...` | Planning summaries from the route build. See below for the files and their schema. |
| `GET /api/reach?lat=L&lon=O&hour=8&minutes=30&kmh=15` | The Worker looks up precomputed weekday ride times within 1 km of the origin, searches local cycle graph tiles, and counts the people reached in the accompanying 100 m cells. Returns two layers, each with a count, bounding box and PNG. |
| `GET /api/bike-route?a=L,O&b=L,O` | A shortest path through the directed cycle graph. Returns metres and the path as latitude and longitude pairs. |
| `GET /data/bike-comparison/<kmh>/<mode>.json` | Counts and visible rows computed offline for each speed and mode. |
| `GET /data/bike-pairs.json`, `GET /data/history/<key>.json` | The full bike comparison data and historical timetables, served compressed. |

## Updating the data

Start with a completed route, bike and reach build. Run `node pipeline/packed.mjs`
if the build has yet to generate `planner/`. For a non-default source directory,
set `RJT_DATA` for that command and pass the same directory as `--source` below.

```sh
uv run python -B hosting/pack.py data/sites-NEXT
python3 -B hosting/upload.py https://realjourneytime.jjpcodes.chatgpt.site \
  data/sites-NEXT NEXT-ID \
  --max-bytes APPROVED_BYTES
```

Choose a new lowercase release ID and set the byte limit after checking the
packed size and the account's storage allowance. The uploader prompts for the
existing Sites access token and the value of the Site secret
`DATA_PUBLISH_TOKEN`. It accepts both on private stdin for automation.
A failed upload leaves the last release active. Retry the same packed data
under the same ID. The uploader changes the active release only after every
object has been stored. Previous releases remain in R2 for rollback and count
against storage. `--add-derived` uploads the planner and comparison files to
an existing release without changing the active release.

The pack stores route metadata separately from timing data. Timing data has
one gzip block for each stop in a route. A small JSON file maps those blocks
to byte ranges and supplies service-day and pattern order. The Worker
reads the two ranges for each relevant line, then uses the same statistics
as the development site. The planner reuses columns within a request.

The cycle graph comes from the existing OpenStreetMap network, tiled at
0.2 degrees with directed edges across tile boundaries. The Worker searches
the tiles the route or reach query touches. It keeps one-microdegree node
positions and centimetre edge weights. Transit reach groups the existing
hourly 90th-percentile ride estimates by boarding area. The packed land and
population grid preserves the existing count and walk model.

## What "Plan a journey" needs

The planner runs in the browser: `site/planner.js` (the search and the replay, plain JavaScript with no Node or
Worker APIs) reads everything through `site/plan-data.js`, which is the only file that knows these addresses.
`pipeline/journeys.mjs` serves the one API below on the MacBook; `pipeline/packed.mjs` writes the static files.
Measured on today's data (48 bus days, 395 train days), a question makes 3 to 11 requests and reads 100 to 750 KB
gzipped, the first one of a visit about 300 KB more for `trains.json`.

The pack copies the planner files to R2 and serves them at `/data/planner/**`.
`node pipeline/packed.mjs` generated 556 files in 20 seconds for the sample build.
Sites returns an empty stops and routes list for a tile with no file.

| File | Contents | Largest today |
| --- | --- | --- |
| `planner/R/C.json` | `{stops: [[id, name, town, lat, lon, [routeKey], group]], routes: {key: route}}`. Same tile numbering as above (`floor(lat*10)`, `floor(lon*10)`). Two additions to the proposal: `group`, a number shared by platforms that are one stop to a passenger (same name and town, within 400 m; a station is its own); and `routes`, the planning summary of every bus, tram and metro route with a stop in the tile, so one file answers "what leaves from near here". | 736 KB, 130 KB gzipped |
| `planner/trains.json` | `{routes: {key: route}}` for every train series. Trains run across many tiles, so they come as one file. | 2.2 MB, 306 KB gzipped |
| `planner/places.json` | `[[label, kind, lat, lon, weight]]`, one row per stop or station, for the From and To boxes. Fetched when a box is first used. | 1.3 MB, 352 KB gzipped |
| `planner/meta.json` | `{coverage, dates: {source: {weekdays: [date], saturday: [date], sunday: [date]}}}`: the recorded dates of trains and of the other modes, to tell a day a line did not run from a day that was not recorded. | 6 KB |

A `route` here is `{key, mode, operator, short_name, name, source, stop_ids, stops: [[name, town, lat, lon, group] or null],
patterns, pattern_last: [date], cum: [[seconds from the pattern's first stop]], hours: [{weekdays: [journeys an hour, 24 numbers], ...}]}`.
`cum` and `hours` are the timetable's typical ride times and frequencies, used to pick which plans to replay.

**`GET /api/planner-legs?days=weekdays&leg=K,A,B,lo,hi&leg=...`** accepts up to 128 legs per request.

- **A window.** `lo` and `hi` are seconds since midnight; only legs whose `sd` is from `lo` to `hi` inclusive come
  back. The planner asks for about 3 to 5 hours around the trip, not the whole day.
- **Several legs in one request.** One `leg` parameter per line and directed pair of platforms, as
  `routeKey,fromStopId,toStopId,lo,hi` (URL-encoded; none of these contain a comma). A question needs 10 to 100 of
  them (every line between two stops, for up to 8 candidate plans of one or two rides). `plan-data.js` keeps each URL under 6,000
  characters (`MAX_URL`), about 100 legs, and sends several requests side by side when it needs more.

The body is `{fields: ["sd","sa","ad","aa","cancelled"], legs: [{days: [{date, legs: [[sd, sa, ad, aa, cancelled]]}]}]}`,
with `legs` in the order asked. For each row, `sd = scheduled departure ?? scheduled arrival` at A,
`sa = scheduled arrival ?? scheduled departure` at B, `ad` and `aa` likewise from the recorded times, both null
when cancelled. A day with no rows may be left out.

**The page also uses** `/api/route?key=K` (for the line on the map: `stops`, `stop_ids`, `patterns`, `weights`,
`shapes`, `pattern_shape`) and `/api/bike-route`, both as they are. It asks api.pdok.nl (the government's address
search) directly from the browser for addresses.

**Where the bike wins** asks for `/data/bike-comparison/<kmh>/<mode>.json` first and, where that is missing (the
MacBook), works the same table out from `/data/bike-pairs.json`. The two were compared at 20 km/h for trams: identical.

**`site/stats.js` changed** but keeps what `hosting/timings.mjs` imports (`alternativeKeys`, `journeyRecords`,
`ride`) with the same meaning; the chart's answers for two routes were compared before and after and are identical.

**Not measured:** the size of `planner-legs` answers with a full year of buses, trams and metros. Today's 24
weekdays give 100 to 600 KB of JSON for a city trip; 250 weekdays would be about ten times that before gzip.
If that is too slow on a phone, the fix is on my side (fewer candidate plans, or a shorter window), not in the format.

## Performance and visit diagnostics

The Network panel's `Server-Timing` header shows Worker elapsed time, elapsed R2 read time with the count and compressed bytes, and decompression time with its output bytes. R2 and decompression can overlap. For streamed files, the header measures up to the response headers and gives the bytes offered by R2. Browser download time is in Resource Timing. Cloudflare's clock advances at I/O boundaries, so the Worker timings can miss synchronous calculation and decompression. The corresponding Worker invocation log reports the actual total CPU time.

In the browser's Performance panel, `rjt.<view>.answer` measures through the first painted answer. `rjt.<view>.complete` includes the chart, table or map overlays the view loads. The basemap tiles can finish separately. `rjt.<view>.error` measures through the error state.

Open `/?debug=1` to record a visit in that browser. Press **Diagnostics on · Stop** or open `/?debug=0` to turn it off. Visit records contain control IDs, input lengths, selection positions, map actions without coordinates, errors and timings. They omit typed text, addresses and IP addresses.

In Sites, use **Get site worker logs** with the project ID from `.openai/hosting.json`, `errors_only: false` and `limit: 100`. Set `since_minutes` to include when the visit happened. List distinct `visit` values from `rjt.visit` records, then read the batches in `sequence` order. Each event is `[milliseconds since navigation, action, control or view, number or null]`. In How far, a `reach-origin` event with source `map` marks a pin move that followed a map click. `rjt.request` records the response timings. Sites controls retention and returns recent logs rather than a complete archive.
