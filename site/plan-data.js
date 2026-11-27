// Everything "Plan a journey" reads, in one place: small files under data/planner/ and one request for recorded
// rides. The addresses are the contract in docs/sites-data.md; change where the data lives here and nowhere else.
//
//   data/planner/meta.json      what was recorded: {coverage: {source: {days, start, end}}, dates: {source: {weekdays: [date], ...}}}
//   data/planner/<R>/<C>.json   a tenth-of-a-degree tile (R = floor(lat * 10), C = floor(lon * 10)):
//                               {stops: [[id, name, town, lat, lon, [route key], group]], routes: {key: route}}
//                               with every bus, tram and metro route that has a stop in the tile
//   data/planner/trains.json    {routes: {key: route}} for every train series
//   data/planner/places.json    [[label, kind, lat, lon, weight]] for every stop and station, for the search box
//   api/planner-legs?days=D&leg=route,from,to,lo,hi&leg=...
//                               recorded rides between two platforms on one line, timetabled to leave between lo
//                               and hi (seconds since midnight): {legs: [{days: [{date, legs: [[sd, sa, ad, aa, cancelled]]}]}]}
//
// A route is {key, mode, operator, short_name, name, source, stop_ids, stops: [[name, town, lat, lon, group] or null],
// patterns, pattern_last: [date], cum: [[seconds from the pattern's first stop]], hours: [{weekdays: [journeys an hour], ...}]}.
const MAX_URL = 6000;

// One retry: a phone's connection drops requests now and then.
const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
const twice = url => get(url).catch(() => get(url));

const once = new Map();
function json(url) {
  if (!once.has(url)) {
    const asked = twice(url);
    asked.catch(() => once.delete(url));
    once.set(url, asked);
  }
  return once.get(url);
}

export const meta = () => json('data/planner/meta.json');
export const trains = () => json('data/planner/trains.json');
export const places = () => json('data/planner/places.json');
// A tile with no stops has no file (404); any other failure is a failure.
export const tile = (r, c) => json(`data/planner/${r}/${c}.json`).catch(error => { if (/: 404$/.test(error.message)) return {stops: [], routes: {}}; throw error; });

// Recorded rides for each {route, from, to, lo, hi}: a map from "route,from,to" to a map from date to vehicles.
// Rides already fetched for a window that covers the one asked for are not fetched again.
const fetched = new Map();
export async function legs(days, specs) {
  const want = new Map();
  for (const s of specs) {
    // A night window (the day before, after midnight) is asked for and kept apart from the day's own.
    const ride = `${s.route},${s.from},${s.to}`, key = s.night ? `${ride},night` : ride, had = want.get(key);
    want.set(key, had ? {...had, lo: Math.min(had.lo, s.lo), hi: Math.max(had.hi, s.hi)} : {key, ride, lo: Math.floor(s.lo), hi: Math.ceil(s.hi)});
  }
  const missing = [...want.values()].filter(w => { const f = fetched.get(`${days}|${w.key}`); return !(f && f.lo <= w.lo && f.hi >= w.hi); });
  const urls = [];
  for (let i = 0; i < missing.length;) {
    let url = `api/planner-legs?days=${days}`, n = 0;
    for (; i + n < missing.length && (n === 0 || url.length < MAX_URL); n++) url += `&leg=${encodeURIComponent(`${missing[i + n].ride},${missing[i + n].lo},${missing[i + n].hi}`)}`;
    urls.push([url, missing.slice(i, i + n)]);
    i += n;
  }
  const out = new Map([...want.keys()].map(key => [key, fetched.get(`${days}|${key}`)?.byDate || new Map()]));
  await Promise.all(urls.map(async ([url, asked]) => {
    const body = await twice(url);
    body.legs.forEach((leg, k) => {
      const byDate = new Map(leg.days.map(day => [day.date, day.legs.map(([sd, sa, ad, aa, cancelled]) =>
        ({sd, sa, ad, aa, cancelled: !!cancelled, tracked: !cancelled && ad != null && aa != null && aa > ad}))]));
      out.set(asked[k].key, byDate);
      fetched.set(`${days}|${asked[k].key}`, {lo: asked[k].lo, hi: asked[k].hi, byDate});
      if (fetched.size > 400) fetched.delete(fetched.keys().next().value);
    });
  }));
  return out;
}
