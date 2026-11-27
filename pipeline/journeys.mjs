// This machine's stand-in for the hosted site's Worker: the answers that need recorded journeys, worked out here
// so the page never downloads whole lines. Routes are read from their packed files (packed.mjs) and use the same
// statistics as the ranking: site/stats.js. "Plan a journey" itself runs in the browser (site/planner.js) and
// only asks this service for recorded rides.
//
// GET /api/route?key=K                         the route without its journeys: stops, patterns, shapes, bike distances
// GET /api/journeys?route=K&from=A&to=B&days=weekdays&start=YYYY-MM-DD&end=YYYY-MM-DD
// GET /api/planner-legs?days=weekdays&leg=K,A,B,lo,hi&leg=...
//     recorded rides from platform A to platform B on line K, timetabled to leave between lo and hi (seconds)
// GET /api/line?key=K                          the line's directions and how long each stretch between stops takes
// GET /api/line-day?key=K&date=YYYY-MM-DD      every journey of one day, stop by stop
// Run: node pipeline/journeys.mjs [port]   (serve.py passes these paths through to it)
import {createServer} from 'node:http';
import {journeyRecords} from '../site/stats.js';
import {open, packAll, routeJSON} from './packed.mjs';
import {lineDay, lineSummary} from './lines.mjs';

const port = Number(process.argv[2] || 8766);
const CACHE_BYTES = 1e9;  // packed routes kept in memory, most recently used
let byKey, byStop;
const cache = new Map();
let held = 0;

function start() {
  const routes = packAll(console.log);
  cache.clear(); held = 0;
  byKey = new Map(routes.map(r => [r.key, r]));
  byStop = new Map();
  for (const r of routes) for (const s of r.stop_ids) {
    if (!byStop.has(s)) byStop.set(s, []);
    byStop.get(s).push(r);
  }
}

function route(key) {
  let r = cache.get(key);
  if (r) cache.delete(key);
  else {
    if (!byKey.has(key)) throw new Error(`no route ${key}`);
    r = open(byKey.get(key));
    held += r.bytes;
  }
  cache.set(key, r);
  for (const [old, o] of cache) {
    if (held <= CACHE_BYTES || old === key) break;
    cache.delete(old); held -= o.bytes;
  }
  return r;
}

function alternatives(r, from, to) {
  const rail = r.mode === 'train', there = new Set((byStop.get(to) || []).map(x => x.key));
  return (byStop.get(from) || []).filter(x => x.key !== r.key && there.has(x.key) && (x.mode === 'train') === rail).map(x => x.key);
}

function answer(url) {
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname === '/api/route') return routeJSON(q.key);
  if (url.pathname === '/api/journeys') {
    const r = route(q.route), alts = alternatives(r, q.from, q.to);
    const keep = d => d.type === (q.days || 'weekdays') && (!q.start || d.date >= q.start) && (!q.end || d.date <= q.end);
    const x = journeyRecords(r, q.from, q.to, keep, alts.map(route));
    return {scheduled: x.scheduled, cancelled: x.cancelled, stranded: x.stranded, alternatives: alts,
            fields: ['date', 'sd', 'sa', 'arrival', 'real', 'timetable', 'cancelled', 'own'],
            records: x.records.map(z => [z.date, z.sd, z.sa, z.arrival, Math.round(z.real * 10) / 10,
                                         Math.round(z.timetable * 10) / 10, z.cancelled ? 1 : 0, z.own ? 1 : 0])};
  }
  if (url.pathname === '/api/line') return lineSummary(route(q.key));
  if (url.pathname === '/api/line-day') return lineDay(route(q.key), q.date);
  if (url.pathname === '/api/planner-legs') {
    const days = q.days || 'weekdays';
    return {fields: ['sd', 'sa', 'ad', 'aa', 'cancelled'], legs: url.searchParams.getAll('leg').map(spec => {
      const [key, from, to, lo, hi] = spec.split(',');
      const found = route(key).vehicles(from, to, d => d.type === days, [Number(lo), Number(hi)]);
      return {days: [...found].filter(([, list]) => list.length).map(([date, list]) =>
        ({date, legs: list.map(v => [v.sd, v.sa, v.cancelled ? null : v.ad, v.cancelled ? null : v.aa, v.cancelled ? 1 : 0])}))};
    })};
  }
  return null;
}

start();
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/reload') start();
    const body = url.pathname === '/api/reload' ? {ok: true} : answer(url);
    res.writeHead(body ? 200 : 404, {'Content-Type': 'application/json'});
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {error: 'not found'}));
  } catch (error) {
    res.writeHead(400, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: String(error.message || error)}));
  }
}).listen(port, '127.0.0.1', () => console.log(`journeys on 127.0.0.1:${port}, ${byKey.size} routes`));
