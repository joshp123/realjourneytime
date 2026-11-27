// The site's data in the small pieces the pages ask for. A year of a busy line is tens of megabytes of JSON, so
// each route is packed once, when its JSON changes:
//   packed/<key>.bin          every journey's times as 32-bit integers, grouped by day and pattern (this
//                             machine's journeys service reads these; see docs/sites-data.md for the hosted site)
//   packed/<key>.json         the rest of the route (stops, patterns, shapes, bike distances): the /api/route answer
//   packed/network.json       every route's planning summary, kept so unchanged routes are not read again
//   planner/...               what "Plan a journey" reads in the browser (site/plan-data.js lists the files)
// Run: node pipeline/packed.mjs   (restart.sh runs it through the journeys service)
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {positions, rideOf} from '../site/stats.js';

export const DATA = process.env.RJT_DATA ? new URL(`file://${process.env.RJT_DATA.replace(/\/?$/, '/')}`)
  : new URL('../site/data/', import.meta.url);
const NONE = -(2 ** 31);  // a missing time; -1 (cancelled) is kept as it is
const MAGIC = 0x31544a52;  // "RJT1"
const TYPES = ['weekdays', 'saturday', 'sunday'];
const SAME_STOP = 400;    // platforms with one name this close together are one stop
const file = name => new URL(`packed/${name}`, DATA);

function writeWhole(url, body) {
  const tmp = new URL(url.href + '.tmp');
  writeFileSync(tmp, body);
  renameSync(tmp, url);
}

const median = values => values.sort((a, b) => a - b)[values.length >> 1];
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const metres = (a, b) => Math.hypot((a[2] - b[2]) * 111320, (a[3] - b[3]) * 111320 * Math.cos(a[2] * Math.PI / 180));

// Pack one route. Returns its planning summary.
function pack(route, source) {
  const width = route.patterns.map(p => 4 * p.length);
  const blocks = [], chunks = [];
  let offset = 0;
  route.days.forEach((day, d) => {
    const byPattern = new Map();
    for (const j of day.journeys) {
      if (!byPattern.has(j[0])) byPattern.set(j[0], []);
      byPattern.get(j[0]).push(j);
    }
    for (const [p, list] of [...byPattern].sort((a, b) => a[0] - b[0])) {
      const block = new Int32Array(list.length * width[p]);
      list.forEach((j, k) => { for (let i = 0; i < width[p]; i++) block[k * width[p] + i] = j[i + 1] ?? NONE; });
      blocks.push(d, p, offset, list.length);
      chunks.push(Buffer.from(block.buffer));
      offset += block.length;
    }
  });
  const head = Buffer.from(JSON.stringify({dates: route.days.map(d => d.date), types: route.days.map(d => d.type), blocks}));
  const padded = Buffer.alloc(Math.ceil(head.length / 4) * 4, 0x20);
  head.copy(padded);
  const lead = Buffer.alloc(8);
  lead.writeUInt32LE(MAGIC, 0); lead.writeUInt32LE(padded.length, 4);
  writeWhole(file(`${route.key}.bin`), Buffer.concat([lead, padded, ...chunks]));

  const weights = route.patterns.map(() => 0);
  for (const d of route.days) for (const j of d.journeys) weights[j[0]]++;
  const {days, ...rest} = route;
  writeWhole(file(`${route.key}.json`), JSON.stringify({...rest, weights, first: days[0].date, last: days.at(-1).date, day_count: days.length}));

  // For the planner's first guess: the typical timetabled time from each pattern's first stop to each later
  // one, and how many journeys start in each hour of each kind of day, counted over the days between the
  // pattern's first and last appearance (stops and timetables change during the year).
  const offsets = route.patterns.map(p => p.map(() => []));
  const hours = route.patterns.map(() => Object.fromEntries(TYPES.map(t => [t, new Array(24).fill(0)])));
  const first = route.patterns.map(() => ''), last = route.patterns.map(() => '');
  for (const day of days) for (const j of day.journeys) {
    const p = j[0], start = j[2] ?? j[1];
    if (start == null) continue;
    hours[p][day.type][((Math.floor(start / 3600) % 24) + 24) % 24]++;
    first[p] ||= day.date; last[p] = day.date;
    for (let i = 0; i < route.patterns[p].length; i++) {
      const at = j[1 + 4 * i] ?? j[2 + 4 * i];
      if (at != null) offsets[p][i].push(at - start);
    }
  }
  const perDay = (h, p) => Object.fromEntries(TYPES.map(t => {
    const n = days.filter(d => d.type === t && d.date >= first[p] && d.date <= last[p]).length;
    return [t, n ? h[t].map(count => Math.round(10 * count / n) / 10) : null];
  }).filter(([, v]) => v));
  return {key: route.key, mode: route.mode, operator: route.operator, short_name: route.short_name, name: route.name,
          source, stop_ids: route.stop_ids, patterns: route.patterns, weights, pattern_last: last,
          cum: offsets.map(p => { let floor = 0; return p.map(v => floor = Math.max(floor, v.length ? median(v) : floor)); }),
          hours: hours.map(perDay), dates: days.map(d => d.date)};
}

// What "Plan a journey" reads. `stops` is id -> [name, town, lat, lon].
function writePlanner(coverage, stops, routes) {
  const out = new URL('planner/', DATA), next = new URL('planner-next/', DATA);
  rmSync(next, {recursive: true, force: true});
  mkdirSync(next, {recursive: true});
  const calls = new Map();   // platform -> the routes that call there
  for (const r of routes) for (const id of new Set(r.patterns.flat().map(s => r.stop_ids[s]))) {
    if (!stops[id]) continue;
    if (!calls.has(id)) calls.set(id, []);
    calls.get(id).push(r);
  }
  // Stops as passengers know them: platforms with the same name in the same town. The same name can be used
  // twice in one town, so platforms further apart than SAME_STOP are different stops. A station is its own stop.
  const byName = new Map(), group = new Map(), places = [];
  for (const id of calls.keys()) {
    const key = id.startsWith('S:') ? id : `${fold(stops[id][0])}|${fold(stops[id][1])}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(id);
  }
  const order = {train: 0, metro: 1, tram: 2, bus: 3};
  for (const ids of byName.values()) {
    const left = new Set(ids);
    while (left.size) {
      const members = [left.values().next().value];
      left.delete(members[0]);
      for (const a of members) for (const b of left) if (metres(stops[a], stops[b]) <= SAME_STOP) { members.push(b); left.delete(b); }
      const [name, town] = stops[members[0]], station = members[0].startsWith('S:');
      const modes = new Set(), journeys = new Set();
      let weight = 0;
      for (const id of members) for (const r of calls.get(id)) {
        modes.add(r.mode);
        r.patterns.forEach((p, i) => { if (p.some(s => r.stop_ids[s] === id) && !journeys.has(`${r.key}|${i}`)) { journeys.add(`${r.key}|${i}`); weight += r.weights[i]; } });
      }
      const mean = k => +(members.reduce((sum, id) => sum + stops[id][k], 0) / members.length).toFixed(5);
      for (const id of members) group.set(id, places.length);
      places.push([station || !town || fold(name).includes(fold(town)) ? name : `${name}, ${town}`,
                   station ? 'Railway station' : `${[...modes].sort((a, b) => order[a] - order[b]).join(', ').replace(/^./, c => c.toUpperCase())} stop`,
                   mean(2), mean(3), Math.round(10 * Math.log10(1 + weight)) / 10]);
    }
  }
  const forPlanner = r => {
    const {weights, dates, ...rest} = r;
    return {...rest, stops: r.stop_ids.map(id => stops[id] ? [...stops[id], group.get(id) ?? -1] : null)};
  };
  const tiles = new Map();
  const tileOf = id => { const k = `${Math.floor(stops[id][2] * 10)}/${Math.floor(stops[id][3] * 10)}`; if (!tiles.has(k)) tiles.set(k, {stops: [], routes: {}}); return tiles.get(k); };
  for (const [id, list] of calls) tileOf(id).stops.push([id, ...stops[id], list.map(r => r.key), group.get(id)]);
  const trains = {};
  for (const r of routes) {
    if (r.mode === 'train') { trains[r.key] = forPlanner(r); continue; }
    const planned = forPlanner(r);
    for (const id of r.stop_ids) if (calls.has(id)) tileOf(id).routes[r.key] = planned;
  }
  for (const [k, tile] of tiles) {
    mkdirSync(new URL(`${k.split('/')[0]}/`, next), {recursive: true});
    writeFileSync(new URL(`${k}.json`, next), JSON.stringify(tile));
  }
  writeFileSync(new URL('trains.json', next), JSON.stringify({routes: trains}));
  writeFileSync(new URL('places.json', next), JSON.stringify(places));
  // Every recorded date of each source, by kind of day.
  const dates = {};
  for (const r of routes) for (const d of r.dates) ((dates[r.source] ||= {})[dayType(d)] ||= new Set()).add(d);
  for (const source of Object.values(dates)) for (const t of Object.keys(source)) source[t] = [...source[t]].sort();
  writeFileSync(new URL('meta.json', next), JSON.stringify({coverage, dates}));
  rmSync(out, {recursive: true, force: true});
  renameSync(next, out);
  return tiles.size;
}

const dayType = date => { const d = new Date(date + 'T12:00:00Z').getUTCDay(); return d === 6 ? 'saturday' : d === 0 ? 'sunday' : 'weekdays'; };

// Pack every route that has changed, then write the planner's files. Summaries of unchanged routes are kept.
export function packAll(log = () => {}) {
  mkdirSync(file(''), {recursive: true});
  const index = JSON.parse(readFileSync(new URL('index.json', DATA)));
  const old = existsSync(file('network.json')) ? JSON.parse(readFileSync(file('network.json'))) : {routes: [], stops: {}};
  const kept = new Map(old.routes.map(r => [r.key, r]));
  const stops = old.stops, routes = [];
  let packed = 0;
  for (const meta of index.routes) {
    const json = new URL(`routes/${meta.key}.json`, DATA), bin = file(`${meta.key}.bin`);
    if (kept.has(meta.key) && existsSync(bin) && statSync(bin).mtimeMs > statSync(json).mtimeMs) { routes.push(kept.get(meta.key)); continue; }
    const route = JSON.parse(readFileSync(json));
    for (const [id, s] of Object.entries(route.stops)) if (s.lat != null) stops[id] = [s.name, s.town || '', s.lat, s.lon];
    routes.push(pack(route, meta.source));
    if (++packed % 100 === 0) log(`${packed} routes packed`);
  }
  const used = new Set(routes.flatMap(r => r.stop_ids));
  for (const id of Object.keys(stops)) if (!used.has(id)) delete stops[id];
  if (packed || routes.length !== old.routes.length || !existsSync(new URL('planner/meta.json', DATA))) {
    writeWhole(file('network.json'), JSON.stringify({stops, routes}));
    log(`planner: ${writePlanner(index.coverage, stops, routes)} tiles`);
  }
  log(`${packed} of ${routes.length} routes packed`);
  return routes;
}

export const routeJSON = key => readFileSync(file(`${key}.json`));

// A packed route's journeys. `vehicles` gives what stats.js needs: every vehicle timetabled between two stops,
// by date; `window` keeps only those timetabled to leave within [from, to] seconds.
export function open(entry) {
  const fd = openSync(file(`${entry.key}.bin`), 'r');
  try {
    const size = statSync(file(`${entry.key}.bin`)).size, buffer = Buffer.allocUnsafe(size);
    for (let got = 0; got < size;) got += readSync(fd, buffer, got, size - got, got);
    if (buffer.readUInt32LE(0) !== MAGIC) throw new Error(`${entry.key}: not a packed route`);
    const headLength = buffer.readUInt32LE(4);
    const head = JSON.parse(buffer.subarray(8, 8 + headLength).toString());
    const data = new Int32Array(buffer.buffer, buffer.byteOffset + 8 + headLength, (size - 8 - headLength) / 4);
    const days = head.dates.map((date, i) => ({date, type: head.types[i]}));
    const time = v => v === NONE ? null : v;
    return {
      ...entry, bytes: size, days,
      vehicles(from, to, keepDay, window) {
        const where = positions(entry, from, to), keep = days.map(keepDay), byDate = new Map();
        for (let b = 0; b < head.blocks.length; b += 4) {
          const d = head.blocks[b], p = head.blocks[b + 1], pos = where[p];
          if (!keep[d]) continue;
          if (!byDate.has(days[d].date)) byDate.set(days[d].date, []);
          if (!pos) continue;
          const list = byDate.get(days[d].date), width = 4 * entry.patterns[p].length;
          for (let k = 0, at = head.blocks[b + 2]; k < head.blocks[b + 3]; k++, at += width) {
            const x = at + 4 * pos[0], y = at + 4 * pos[1];
            const v = rideOf(time(data[x]), time(data[x + 1]), time(data[x + 2]), time(data[x + 3]),
                             time(data[y]), time(data[y + 1]), time(data[y + 2]), time(data[y + 3]));
            if (v && (!window || v.sd >= window[0] && v.sd <= window[1])) list.push(v);
          }
        }
        return byDate;
      },
    };
  } finally { closeSync(fd); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) packAll(console.log);
