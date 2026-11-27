// Stop pairs for the bike comparison (site/data/bike-pairs.json) and ride times by departure hour for the
// "how far can I get" view (site/data/reach.json).
// Run: node pipeline/rank.mjs
import {readFileSync, writeFileSync} from 'node:fs';
import {journeyRecords, summary, percentile, ride} from '../site/stats.js';

const data = process.env.RJT_DATA ? new URL(`file://${process.env.RJT_DATA.replace(/\/?$/, '/')}`) : new URL('../site/data/', import.meta.url);
const {routes} = JSON.parse(readFileSync(new URL('index.json', data)));
const DAYTIME = [7 * 3600, 19 * 3600];
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
const round = v => Math.round(v * 10) / 10;
// Routes load on demand with a small cache: the national route files do not fit in memory at once.
const cache = new Map();
const load = key => {
  if (cache.has(key)) { const r = cache.get(key); cache.delete(key); cache.set(key, r); return r; }
  const r = JSON.parse(readFileSync(new URL(`routes/${key}.json`, data)));
  cache.set(key, r);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return r;
};
const all = {get: load};
// Which routes call at each stop, to find other lines between the same two stops quickly.
const byStop = new Map();
for (const r of routes) for (const s of r.stop_ids) {
  if (!byStop.has(s)) byStop.set(s, []);
  byStop.get(s).push(r);
}
const alternativeKeys = (_, route, from, to) => {
  const rail = route.mode === 'train', there = new Set((byStop.get(to) || []).map(r => r.key));
  return (byStop.get(from) || []).filter(r => r.key !== route.key && there.has(r.key) && (r.mode === 'train') === rail).map(r => r.key);
};
const pairs = [], reach = [];
for (const meta of routes) {
  const route = all.get(meta.key);
  const seen = new Set(), hourly = [];
  for (const pattern of route.patterns) {
    const stops = pattern.map(s => route.stops[route.stop_ids[s]]);
    for (let i = 0; i < pattern.length; i++) for (let j = i + 1, path = 0, last = i; j < pattern.length; j++) {
      // Stops missing from the stop register have no position: leave them out of the path.
      if (stops[j].lat == null) continue;
      if (stops[last].lat != null) path += metres(stops[last], stops[j]);
      last = j;
      if (stops[i].lat == null || stops[i].name === stops[j].name) continue;
      const from = route.stop_ids[pattern[i]], to = route.stop_ids[pattern[j]];
      if (seen.has(`${from}|${to}`) || ride(pattern, pattern[i], pattern[j])[0] !== i) continue;
      seen.add(`${from}|${to}`);
      const alternatives = alternativeKeys(routes, route, from, to).map(k => all.get(k));
      const {records} = journeyRecords(route, from, to, d => d.type === 'weekdays', alternatives);
      // Weekday ride time a commuter can rely on (90th percentile), by hour of the timetabled departure.
      const byHour = Array.from({length: 24}, () => []);
      for (const r of records) byHour[((Math.floor(r.sd / 3600) % 24) + 24) % 24].push(r.real);
      const p90 = byHour.map(v => v.length >= 3 ? Math.round(percentile(v, 0.9)) : -1);
      if (p90.some(v => v >= 0)) hourly.push([route.stop_ids.indexOf(from), route.stop_ids.indexOf(to), ...p90]);
      // Skip pairs a loop route serves the long way round for the bike comparison: nobody rides those.
      const metresByBike = route.bike_metres?.[route.stop_ids.indexOf(from)]?.[route.stop_ids.indexOf(to)];
      if (path > 1.6 * metres(stops[i], stops[j]) || metresByBike == null) continue;
      const s = summary(records.filter(r => r.arrival >= DAYTIME[0] && r.arrival < DAYTIME[1]));
      if (!s || s.n < 100) continue;
      // A timetable slower than 7 km/h over the cycling distance means the line goes a long way round.
      if (metresByBike / 1000 / (s.timetable / 60) < 7) continue;
      pairs.push({route: route.key, label: meta.short_name, mode: route.mode, from, to,
                  from_name: route.stops[from].name, to_name: route.stops[to].name,
                  km: metresByBike / 1000, p90: s.p90, median: s.median, mean: s.mean, timetable: s.timetable, n: s.n,
                  cancelled: s.cancelled});
    }
  }
  reach.push({key: route.key, mode: route.mode, label: meta.short_name,
              stops: route.stop_ids.map(id => [route.stops[id].lat ?? null, route.stops[id].lon ?? null]), pairs: hourly});
  console.log(meta.key, pairs.length, hourly.length);
}
// One row per route and pair of stop names (a stop has a quay on each side of the road): keep the quicker.
const best = new Map();
for (const p of pairs) {
  const key = `${p.route}|${p.from_name}|${p.to_name}`;
  if (!best.has(key) || p.p90 < best.get(key).p90) best.set(key, p);
}
const fields = ['route', 'label', 'mode', 'from', 'to', 'from_name', 'to_name', 'km', 'p90', 'median', 'mean', 'timetable', 'n', 'cancelled'];
const rows = [...best.values()].map(p => fields.map(f => typeof p[f] !== 'number' || f === 'n' ? p[f]
  : f === 'km' || f === 'cancelled' ? Math.round(p[f] * 1000) / 1000 : round(p[f])));
writeFileSync(new URL('bike-pairs.json', data), JSON.stringify({fields, rows}));
writeFileSync(new URL('reach.json', data), JSON.stringify({routes: reach}));
console.log(rows.length, 'bike pairs;', reach.reduce((n, r) => n + r.pairs.length, 0), 'reach pairs');
