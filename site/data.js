// Everything the pages read. A place is a stop as a visitor knows it: every platform with one name, and a
// station together with the stops at it. Lines are found from the places, never asked for.
//
//   data/planner/places.json   [[label, kind, lat, lon, weight]]; a place's number is its row
//   data/planner/lines.json    [[key, name, operator, mode, town, first place, last place, journeys]]
//   data/planner/<R>/<C>.json  a tenth-of-a-degree tile: {stops: [[id, name, town, lat, lon, [route], place]],
//                              routes: {key: route}} for buses, trams and metros
//   data/planner/trains.json   {routes: {key: route}} for trains
//   api/planner-legs           every recorded ride between two platforms on one line
import {ride} from './stats.js';

export async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

const once = (cache, key, load) => { if (!cache.has(key)) cache.set(key, load().catch(error => { cache.delete(key); throw error; })); return cache.get(key); };
const files = new Map();
// Keep the grouped place IDs separate from the planner files in older browsers' caches.
const plannerFile = name => json(`data/planner/${name}.json?v=2`);
const file = name => once(files, name, () => plannerFile(name));
const tile = (r, c) => once(files, `${r}/${c}`, () => plannerFile(`${r}/${c}`).catch(error => {
  if (/: 404$/.test(error.message)) return {stops: [], routes: {}};
  throw error;
}));

export const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

export const places = () => once(files, 'places+', async () => (await file('places')).map(([label, kind, lat, lon, weight], id) =>
  ({id, label, kind: kind === 'Railway station' ? 'Train' : kind.replace(/ stop$/, ''), lat, lon, weight, folded: fold(label)})));
export const lineList = () => file('lines');
export const meta = () => file('meta');

// The place a link names. Two places can share a name; the busier one wins.
export async function placeNamed(label) {
  const want = fold(label || '');
  return (await places()).filter(p => p.folded === want).sort((a, b) => b.weight - a.weight)[0] || null;
}

// Places matching what was typed: names that start with it, then names with a word that does, busiest first.
export async function search(text, limit = 8) {
  const want = fold(text);
  if (!want) return [];
  const rank = p => p.folded.startsWith(want) ? 0 : p.folded.includes(' ' + want) ? 1 : -1;
  return (await places()).map(p => [rank(p), p]).filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0] || b[1].weight - a[1].weight).slice(0, limit).map(([, p]) => p);
}

// Lines matching what was typed ("tram 8", "bus 26"), busiest first.
export async function searchLines(text, limit = 3) {
  const want = fold(text);
  if (!/\d/.test(want) && !/^(tram|metro|bus)/.test(want)) return [];
  const all = await places();
  return (await lineList()).filter(l => fold(l[1]) === want || fold(`${l[2]} ${l[1]}`) === want || fold(`${l[1]} ${l[4]}`).startsWith(want) && want.length > fold(l[1]).length)
    .sort((a, b) => b[7] - a[7]).slice(0, limit).map(l => ({key: l[0], name: l[1], town: l[4], from: all[l[5]], to: all[l[6]]}));
}

// The place a platform belongs to, from the tile it is in.
export async function placeOfStop(id, lat, lon) {
  const stop = (await tile(Math.floor(lat * 10), Math.floor(lon * 10))).stops.find(s => s[0] === id);
  return stop ? (await places())[stop[6]] : null;
}

// Every line that calls at a place: its timetable summary, with the place of each stop.
export async function linesAt(place) {
  const wanted = new Set();
  for (const lat of [-0.009, 0.009]) for (const lon of [-0.015, 0.015]) wanted.add(`${Math.floor((place.lat + lat) * 10)}/${Math.floor((place.lon + lon) * 10)}`);
  const sources = [...wanted].map(k => tile(...k.split('/')));
  if (place.kind.startsWith('Train')) sources.push(file('trains'));
  const routes = new Map();
  for (const source of await Promise.all(sources)) {
    for (const [key, route] of Object.entries(source.routes)) if (route.stops.some(s => s && s[4] === place.id)) routes.set(key, route);
  }
  return routes;
}

// What a visitor calls a line. Train series have numbers nobody knows, so trains go by kind: Intercity, Sprinter.
export const lineLabel = route => route.mode !== 'train' ? route.name : route.name.startsWith(route.operator + ' ') ? route.name.slice(route.operator.length + 1) : route.name;

const perDay = (route, p) => (route.hours[p].weekdays || []).reduce((sum, n) => sum + n, 0);

// The places a vehicle runs to from here without a change, busiest first: {place, journeys a weekday, lines}.
export function reachable(place, routes) {
  const found = new Map();
  for (const route of routes.values()) {
    route.patterns.forEach((pattern, p) => {
      const start = pattern.findIndex(s => route.stops[s]?.[4] === place.id);
      const n = perDay(route, p);
      if (start < 0 || !n) return;
      const seen = new Set();
      for (const s of pattern.slice(start + 1)) {
        const id = route.stops[s]?.[4];
        if (id == null || id < 0 || id === place.id || seen.has(id)) continue;
        seen.add(id);
        const entry = found.get(id) || {place: id, journeys: 0, lines: new Map()};
        entry.journeys += n;
        entry.lines.set(lineLabel(route), (entry.lines.get(lineLabel(route)) || 0) + n);
        found.set(id, entry);
      }
    });
  }
  return [...found.values()].filter(e => e.journeys >= 1).sort((a, b) => b.journeys - a.journeys);
}

// "Tram 2, 12, 24" from line names, busiest first, numbers in order.
export function lineNames(lines) {
  const names = [...lines].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const byKind = new Map();
  for (const name of names) {
    const [kind, ...rest] = name.split(' ');
    if (!byKind.has(kind)) byKind.set(kind, []);
    if (rest.length) byKind.get(kind).push(rest.join(' '));
  }
  const inOrder = list => list.sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).join(', ');
  return [...byKind].map(([kind, numbers]) => numbers.length ? `${kind} ${inOrder(numbers)}` : kind).join(', ');
}

// Each line and pair of platforms that carries you from one place to the other.
export function legsBetween(from, to, routes) {
  const legs = [];
  for (const route of routes.values()) {
    const pairs = new Set();
    for (const pattern of route.patterns) {
      pattern.forEach((s, i) => {
        if (route.stops[s]?.[4] !== from.id) return;
        const t = pattern.slice(i + 1).find(x => route.stops[x]?.[4] === to.id);
        if (t != null && ride(pattern, s, t)) pairs.add(`${s},${t}`);
      });
    }
    for (const pair of pairs) {
      const [s, t] = pair.split(',').map(Number);
      legs.push({route, from: route.stop_ids[s], to: route.stop_ids[t], a: route.stops[s], b: route.stops[t]});
    }
  }
  return legs;
}

// Every recorded ride on each leg, by date: Map(date -> [[planned departure, planned arrival, recorded
// departure, recorded arrival, cancelled]]), in the order of `legs`.
const MAX_URL = 6000;
export async function rides(legs, days) {
  const requests = [];
  let url = '', count = 0;
  for (const leg of legs) {
    const part = `&leg=${encodeURIComponent(`${leg.route.key},${leg.from},${leg.to},0,200000`)}`;
    if (!url || url.length + part.length > MAX_URL || count === 100) { url = `api/planner-legs?days=${days}`; requests.push({url, n: 0}); count = 0; }
    url += part; count++;
    requests.at(-1).url = url; requests.at(-1).n = count;
  }
  const answers = await Promise.all(requests.map(r => json(r.url)));
  return answers.flatMap(a => a.legs.map(leg => new Map(leg.days.map(d => [d.date, d.legs]))));
}
