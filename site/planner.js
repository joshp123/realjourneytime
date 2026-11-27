// "Plan a journey": door to door between two points with at most one change, answered from recorded journeys.
// Plain JavaScript with no server behind it: it runs in the browser (or a Worker) and gets everything it reads
// through `data` (plan-data.js), in small files.
//
// Two steps. First a guess from the timetable: which lines, boarding stops and changes could make the trip,
// ranked by typical ride time and frequency. Then the best few are replayed on every recorded day with the same
// rule as the journey chart (stats.js `taken`): you are at the stop a minute before the timetabled departure,
// your vehicle counts if it ran, and otherwise you ride the first one to get there.
//
// A "stop" here is what a passenger means by one: every platform with the same name in the same place (a
// `group`, worked out when the data is packed). From a bus station you take whichever bus to your destination
// leaves first, whatever platform it leaves from.
import {BOARD_MARGIN, MAX_WAIT, percentile, ride, rideIndex, taken} from './stats.js';

export const WALK = 80 / 60;       // metres a second (4.8 km/h), as in "How far can I get?"
export const DETOUR = 1.3;         // a walk is about 30% longer than the straight line
const NEAR = 1000, FAR = 3000;     // board within 1 km; where there is no stop that close, the nearest within 3 km
const STATION_NEAR = 2000;         // people walk further to a railway station
const CHANGE = 300, STATION_CHANGE = 400;  // furthest walk between lines when changing (metres, straight line)
const BEFORE = 75 * 60;            // how long before the departure the timetable suggests earlier ones are tried
const LONG_BEFORE = 3 * 3600;      // and how long when nothing in that time is reliable
const MIN_DAYS = 5;                // fewer recorded days than this is not an answer
const MIN_RUNNING = 2 / 3;         // nor is a plan that could not be ridden on a third of the days (a diversion, a rare variant)
const RELIABLE = 0.9;              // "nine days in ten"
const TRY = 8, SHOW = 3;           // plans replayed on the recorded days, and plans shown
const STALE_DAYS = 80;             // long enough to keep lines that stop for the summer
const TILE = 10;                   // stops come in tiles of a tenth of a degree
// A second change is allowed only with a train in the middle (stop to station, train, station to stop).
const MAX_CHANGES = 2;

const KY = 111320;
const kx = lat => 111320 * Math.cos(lat * Math.PI / 180);
const metres = (a, b) => Math.hypot((a.lat - b.lat) * KY, (a.lon - b.lon) * kx((a.lat + b.lat) / 2));
const walkSeconds = m => m * DETOUR / WALK;
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mostCommon = list => { const n = new Map(); for (const v of list) n.set(v, (n.get(v) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0][0]; };
export const stopLabel = s => s.station || !s.town || fold(s.name).includes(fold(s.town)) ? s.name : `${s.name}, ${s.town}`;

// Points in a grid, to find the ones near another point without measuring to all of them.
function gridOf(items) {
  const cells = new Map(), cell = 0.005;
  const key = (lat, lon) => `${Math.floor(lat / cell)},${Math.floor(lon / (cell * 1.6))}`;
  for (const item of items) {
    const k = key(item.at.lat, item.at.lon);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(item);
  }
  // Items within `radius` metres of `point`: [item, metres].
  return (point, radius) => {
    const out = [], rows = Math.ceil(radius / (cell * KY)), cols = Math.ceil(radius / (cell * 1.6 * kx(point.lat)));
    const r0 = Math.floor(point.lat / cell), c0 = Math.floor(point.lon / (cell * 1.6));
    for (let r = r0 - rows; r <= r0 + rows; r++) for (let c = c0 - cols; c <= c0 + cols; c++) {
      for (const item of cells.get(`${r},${c}`) || []) {
        const m = metres(point, item.at);
        if (m <= radius) out.push([item, m]);
      }
    }
    return out;
  };
}

// ---------- what one question reads ----------

// A route as the planner uses it: where each stop is, and which patterns call there.
function prepare(route) {
  if (route.at) return route;
  route.at = route.stop_ids.map((id, i) => route.stops[i] && {id, name: route.stops[i][0], town: route.stops[i][1], lat: route.stops[i][2],
                                                             lon: route.stops[i][3], group: route.stops[i][4], station: id.startsWith('S:')});
  route.local = new Map(route.stop_ids.map((id, i) => [id, i]));
  route.calls = route.stop_ids.map(() => []);
  route.patterns.forEach((pattern, p) => pattern.forEach((local, i) => route.calls[local].push([p, i])));
  return route;
}

// The stops within FAR of each point, every route that calls at them, and all the trains.
async function load(data, points) {
  const wanted = new Set();
  for (const p of points) {
    const dLat = FAR / KY, dLon = FAR / kx(p.lat);
    for (let r = Math.floor((p.lat - dLat) * TILE); r <= Math.floor((p.lat + dLat) * TILE); r++) {
      for (let c = Math.floor((p.lon - dLon) * TILE); c <= Math.floor((p.lon + dLon) * TILE); c++) wanted.add(`${r}/${c}`);
    }
  }
  const [tiles, trains, meta] = await Promise.all([Promise.all([...wanted].map(k => data.tile(...k.split('/')))), data.trains(), data.meta()]);
  const world = {platforms: [], routes: new Map(), meta};
  for (const tile of tiles) {
    for (const [id, name, town, lat, lon, routes, group] of tile.stops) world.platforms.push({id, name, town, lat, lon, routes, group, station: id.startsWith('S:')});
    for (const [key, route] of Object.entries(tile.routes || {})) world.routes.set(key, route);
  }
  for (const [key, route] of Object.entries(trains.routes)) world.routes.set(key, route);
  // Railway stations, each with the trains that call there: where the middle ride of a two-change trip starts and ends.
  if (!trains.stations) {
    const stations = new Map();
    for (const route of Object.values(trains.routes)) {
      prepare(route).at.forEach(stop => {
        if (!stop) return;
        if (!stations.has(stop.id)) stations.set(stop.id, {...stop, routes: []});
        stations.get(stop.id).routes.push(route.key);
      });
    }
    trains.stations = gridOf([...stations.values()].map(s => ({at: s})));
  }
  world.stations = trains.stations;
  // A pattern that last ran more than STALE_DAYS before its source's data ends no longer runs.
  world.cutoff = Object.fromEntries(Object.entries(meta.coverage).map(([source, c]) =>
    [source, new Date(new Date(c.end + 'T12:00:00Z') - STALE_DAYS * 86400000).toISOString().slice(0, 10)]));
  return world;
}

// Platforms within `radius` metres of a point, nearest first: [platform, metres].
const near = (world, point, radius) => world.platforms.map(s => [s, metres(point, s)]).filter(x => x[1] <= radius).sort((a, b) => a[1] - b[1]);

// Where a trip can start or end: platforms within a walk of the point.
function platformsNear(world, point) {
  const found = near(world, point, STATION_NEAR).filter(([s, m]) => m <= NEAR || s.station);
  return found.length ? found : near(world, point, FAR).slice(0, 3);
}

// A name for a point on the map: the nearest stop.
export async function nameOf(data, point) {
  const found = near(await load(data, [point]), point, FAR)[0];
  return found ? `${found[1] < 60 ? '' : 'Near '}${stopLabel(found[0])}` : null;
}

// ---------- the guess: plans from the timetable ----------

// Journeys an hour on a pattern leaving its stop at position `i` around time `t`.
function frequency(route, p, i, t, days) {
  const hours = route.hours[p][days];
  if (!hours) return 0;
  const h = ((Math.floor((t - route.cum[p][i]) / 3600) % 24) + 24) % 24;
  return Math.max(hours[h], hours[(h + 23) % 24] / 2);
}

const newPool = (from, to) => ({from: from.group, to: to.group, pairs: new Map(), walk: 0, f: 0, seconds: 0, routes: new Set(), counted: new Set()});
function pairOf(pool, from, to) {
  const key = `${from.id}|${to.id}`;
  if (!pool.pairs.has(key)) pool.pairs.set(key, {from, to, live: false, routes: new Set()});
  return pool.pairs.get(key);
}
const livePairs = pool => [...pool.pairs.values()].filter(pair => pair.live);

// Rides from (or, backwards, to) the platforms in `ends` [platform, metres]: one entry per pair of stops, with
// every line that makes the ride, how often one leaves around `t` and the typical ride time.
function rides(world, ends, t, days, backwards) {
  const pools = new Map();
  for (const [end, m] of ends) {
    const walk = walkSeconds(m);
    for (const key of end.routes) {
      const route = world.routes.get(key);
      if (!route) continue;
      prepare(route);
      for (const [p, i] of route.calls[route.local.get(end.id)] || []) {
        const pattern = route.patterns[p], cum = route.cum[p];
        // A pattern that no longer runs is no reason to offer a ride, but it is history for one still offered
        // (a bus station moves its platforms; a line is renumbered).
        const stale = route.pattern_last[p] < world.cutoff[route.source];
        for (let j = backwards ? i - 1 : i + 1; j >= 0 && j < pattern.length; j += backwards ? -1 : 1) {
          const other = route.at[pattern[j]];
          if (!other || other.group === end.group) continue;
          const [from, to, a, b] = backwards ? [other, end, j, i] : [end, other, i, j];
          // A loop can pass a stop twice: only the shortest ride counts, as on the chart.
          const shortest = ride(pattern, pattern[a], pattern[b]);
          if (shortest[0] !== a || shortest[1] !== b) continue;
          const name = `${from.group}|${to.group}`;
          if (!pools.has(name)) pools.set(name, newPool(from, to));
          const pool = pools.get(name), pair = pairOf(pool, from, to);
          pair.routes.add(key);
          const f = stale ? 0 : frequency(route, p, a, backwards ? t : t + walk, days);
          if (f < 0.2) continue;
          pair.live = true;
          pool.walk = Math.max(pool.walk, walk);   // to the furthest platform in use: never too little time
          pool.routes.add(key);
          if (pool.counted.has(`${key}|${p}`)) continue;
          pool.counted.add(`${key}|${p}`);
          pool.f += f; pool.seconds += f * (cum[b] - cum[a]);
        }
      }
    }
  }
  for (const [name, pool] of pools) {
    if (!pool.f) { pools.delete(name); continue; }
    pool.ride = pool.seconds / pool.f;
    pool.wait = Math.min(1200, 1800 / pool.f);   // half the gap between departures, at most 20 minutes
    pool.lines = [...pool.routes].sort().join(',');
  }
  return pools;
}

// Changing between platforms `m` metres apart: allowed up to CHANGE, or STATION_CHANGE at a railway station.
// It takes the walk plus a minute, and at least three minutes at a station.
const changeable = (x, y, m) => m <= CHANGE || m <= STATION_CHANGE && (x.station || y.station);
const changeSeconds = (x, y, m) => Math.max(x.station || y.station ? 180 : 0, walkSeconds(m) + 60);

function candidates(world, origin, destination, t, days) {
  const starts = platformsNear(world, origin), finishes = platformsNear(world, destination);
  if (!starts.length || !finishes.length) return {starts, finishes, plans: []};
  const first = rides(world, starts, t, days, false), last = rides(world, finishes, t + 900, days, true);
  const ending = new Set(finishes.map(([s]) => s.group));
  const best = new Map();
  const offer = (key, plan) => { if (!best.has(key) || plan.seconds < best.get(key).seconds) best.set(key, plan); };
  // The quickest way to each stop on one vehicle, and from each stop to the destination on one vehicle.
  const reach = new Map(), onward = new Map();
  for (const pool of first.values()) {
    const seconds = pool.walk + pool.wait + pool.ride;
    if (ending.has(pool.to)) {
      const lastWalk = Math.max(...livePairs(pool).map(pair => walkSeconds(metres(pair.to, destination))));
      offer(pool.lines, {seconds: seconds + lastWalk, legs: [pool], firstWalk: pool.walk, lastWalk, changes: []});
    }
    if (!reach.has(pool.to) || seconds < reach.get(pool.to).seconds) reach.set(pool.to, {seconds, pool});
  }
  for (const pool of last.values()) {
    const seconds = pool.wait + pool.ride + pool.walk;
    if (!onward.has(pool.from) || seconds < onward.get(pool.from).seconds) onward.set(pool.from, {seconds, pool});
  }
  // One change: a last ride that leaves from within a short walk of where a first ride arrives.
  const leaving = gridOf([...onward.values()].flatMap(b => livePairs(b.pool).map(pair => ({at: pair.from, b}))));
  for (const a of reach.values()) {
    const changes = new Map();
    for (const {to: x} of livePairs(a.pool)) {
      for (const [{at: y, b}, m] of leaving(x, STATION_CHANGE)) {
        if (changeable(x, y, m) && !(changes.get(b)?.m <= m)) changes.set(b, {m, x, y});
      }
    }
    for (const [b, {m, x, y}] of changes) {
      if ([...a.pool.routes].some(r => b.pool.routes.has(r))) continue;
      // Not worth a vehicle: a first ride no quicker than walking to the second, or a second no quicker than walking on.
      if (walkSeconds(metres(origin, y)) <= a.seconds + 120 || walkSeconds(metres(x, destination)) <= b.seconds + 120) continue;
      const change = changeSeconds(x, y, m);
      offer(`${a.pool.lines}>${b.pool.lines}`, {seconds: a.seconds + change + b.seconds, legs: [a.pool, b.pool],
                                               firstWalk: a.pool.walk, lastWalk: b.pool.walk, changes: [change]});
    }
  }
  // Two changes, with a train in the middle: the trips across the country that one change cannot make. Only
  // when it looks at least five minutes quicker than fewer changes.
  const bound = MAX_CHANGES < 2 ? -Infinity : Math.min(Infinity, ...[...best.values()].map(p => p.seconds)) - 300;
  const lastFrom = new Map();   // station -> last rides that leave from within a change of it
  for (const b of onward.values()) for (const {from: w} of livePairs(b.pool)) {
    for (const [{at: z}, m] of world.stations(w, STATION_CHANGE)) {
      if (!lastFrom.has(z.id)) lastFrom.set(z.id, new Map());
      if (!(lastFrom.get(z.id).get(b)?.m <= m)) lastFrom.get(z.id).set(b, {m, w});
    }
  }
  const middle = new Map();     // station a train could be caught at -> the first ride that gets there soonest
  for (const a of reach.values()) {
    if (a.seconds >= bound) continue;
    for (const {to: x} of livePairs(a.pool)) {
      for (const [{at: y}, m] of world.stations(x, STATION_CHANGE)) {
        const change = changeSeconds(x, y, m), at = a.seconds + change;
        if (!middle.has(y.id) || at < middle.get(y.id).at) middle.set(y.id, {a, y, change, at});
      }
    }
  }
  for (const {a, y, change, at} of middle.values()) {
    const found = new Map();    // station reached -> the ride there, over every train that makes it
    for (const key of y.routes) {
      const route = prepare(world.routes.get(key));
      for (const [p, i] of route.calls[route.local.get(y.id)]) {
        const pattern = route.patterns[p], cum = route.cum[p];
        const stale = route.pattern_last[p] < world.cutoff[route.source];
        const f = stale ? 0 : frequency(route, p, i, t + at, days);
        for (let j = i + 1; j < pattern.length; j++) {
          const z = route.at[pattern[j]];
          if (!z || !lastFrom.has(z.id) || ride(pattern, pattern[i], pattern[j])[1] !== j) continue;
          if (!found.has(z.id)) found.set(z.id, newPool(y, z));
          const pool = found.get(z.id), pair = pairOf(pool, y, z);
          pair.routes.add(key);
          if (f < 0.2 || a.pool.routes.has(key)) continue;
          pair.live = true; pool.routes.add(key);
          pool.f += f; pool.seconds += f * (cum[j] - cum[i]);
        }
      }
    }
    for (const [z, pool] of found) {
      if (!pool.f) continue;
      pool.lines = [...pool.routes].sort().join(',');
      const arrive = at + Math.min(1200, 1800 / pool.f) + pool.seconds / pool.f;
      for (const [b, {m, w}] of lastFrom.get(z)) {
        const second = changeSeconds(pool.pairs.values().next().value.to, w, m), seconds = arrive + second + b.seconds;
        if (seconds >= bound || [...pool.routes].some(r => b.pool.routes.has(r))) continue;
        offer(`${a.pool.lines}>${pool.lines}>${b.pool.lines}`, {seconds, legs: [a.pool, pool, b.pool], firstWalk: a.pool.walk,
                                                                lastWalk: b.pool.walk, changes: [change, second]});
      }
    }
  }
  const plans = [...best.values()].sort((p, q) => p.seconds - q.seconds);
  const limit = plans.length ? plans[0].seconds * 1.6 + 600 : 0;
  return {starts, finishes, plans: plans.filter(p => p.seconds <= limit).slice(0, TRY)};
}

// ---------- the answer: plans replayed on the recorded days ----------

// The departures a plan is replayed on: from a while before the timetable says you must leave, until two hours
// after you meant to be there. Being later than that counts as late, without saying how late.
const windowOf = (plan, by, time, before) => by === 'arrive' ? [time - plan.seconds - before, time + MAX_WAIT] : [time, time + 1.5 * plan.seconds + MAX_WAIT];

// The recorded rides a plan needs: one per line and pair of platforms, timetabled to leave within the window.
// A train just after midnight is recorded on the day before, at 24:24 rather than 00:24, so a window that starts
// before NIGHT also asks for the day before's rides after midnight.
const NIGHT = 3 * 3600;
function wanted(plan, by, time, before) {
  const [lo, hi] = windowOf(plan, by, time, before);
  const windows = [{lo, hi}];
  if (lo < NIGHT) windows.push({lo: lo + 86400, hi: Math.min(hi, NIGHT) + 86400, night: true});
  return plan.legs.flatMap(pool => [...pool.pairs.values()].flatMap(pair => [...pair.routes].flatMap(route =>
    windows.map(w => ({route, from: pair.from.id, to: pair.to.id, ...w})))));
}

const nextDay = date => new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const earlier = t => t == null ? t : t - 86400;

// One leg's recorded vehicles on each day, in timetabled order, with the indexes `taken` reads: what was
// recorded, and the same day as the timetable has it (every vehicle runs, on time).
function legOf(world, pool, recorded) {
  const lines = [], byDate = new Map();
  for (const pair of pool.pairs.values()) for (const key of pair.routes) {
    const line = lines.push({meta: world.routes.get(key), from: pair.from.id, to: pair.to.id}) - 1;
    const add = (date, mine) => byDate.set(date, byDate.has(date) ? byDate.get(date).concat(mine) : mine);
    for (const [date, list] of recorded.get(`${key},${pair.from.id},${pair.to.id}`) || []) add(date, list.map(v => ({...v, line})));
    // The day before's rides after midnight belong to this day, at 00:24 rather than 24:24.
    for (const [date, list] of recorded.get(`${key},${pair.from.id},${pair.to.id},night`) || []) {
      add(nextDay(date), list.map(v => ({...v, sd: earlier(v.sd), sa: earlier(v.sa), ad: earlier(v.ad), aa: earlier(v.aa), line})));
    }
  }
  const data = new Map();
  for (const [date, list] of byDate) {
    list.sort((p, q) => p.sd - q.sd);
    const timetable = rideIndex(list.map(v => ({sd: v.sd, sa: v.sa, ad: v.sd, aa: v.sa, tracked: v.sa > v.sd})));
    data.set(date, {list, recorded: rideIndex(list), timetable});
  }
  return {lines, data, sources: new Set(lines.map(l => l.meta.source))};
}

// What happened on one day to someone who planned leg 1's vehicle `v`. At every stop the rule is the chart's:
// you are ready a minute before the vehicle you plan, it counts if it ran, and otherwise you ride the first to
// get there. Alongside runs the same day as the timetable promises it, to tell when a connection was missed.
// Departures after `until` were not read: needing one means arriving too late to say when.
function outcome(legs, date, v, changes, lastWalk, until) {
  let ready = v.sd - BOARD_MARGIN, promisedReady = ready, got, promised;
  const result = {state: 'ok', departure: v.sd, cancelled: v.cancelled, line: [], timetable: null};
  for (const [i, leg] of legs.entries()) {
    const list = leg.data.get(date)?.list || [], day = leg.data.get(date);
    const after = sd => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].sd < sd) lo = mid + 1; else hi = mid; } return list[lo]; };
    const expected = i ? after(ready + BOARD_MARGIN) : v;
    if (expected && !expected.tracked && !expected.cancelled) return {state: 'unknown'};
    promised = (i === 0 || promised) && day ? taken(day.timetable, promisedReady + BOARD_MARGIN, null) : null;
    got = day ? taken(day.recorded, ready, expected) : null;
    if (!got || got.ad - ready - BOARD_MARGIN > MAX_WAIT) {
      if (ready + BOARD_MARGIN + MAX_WAIT <= until) return {state: 'stranded'};
      return {...result, arrive: Infinity, made: legs.length > 1 ? false : undefined, timetable: promiseOf(legs, date, v, changes, lastWalk)};
    }
    result.line[i] = got.line;
    if (i && promised) {
      // What a missed connection costs by the timetable: the wait for the one after.
      const following = after(promised.sd + 1);
      result.made = result.made !== false && got.sd <= promised.sd;
      result.gap = Math.max(result.gap || 0, following ? following.sd - promised.sd : 0) || null;
    }
    ready = got.aa + changes[i];
    if (promised) promisedReady = promised.aa + changes[i];
  }
  return {...result, arrive: got.aa + lastWalk, timetable: promised ? promised.aa + lastWalk : null};
}

// When the timetable says you arrive if you plan leg 1's vehicle `v`, or null where it has no connection.
function promiseOf(legs, date, v, changes, lastWalk) {
  let ready = v.sd - BOARD_MARGIN, promised;
  for (const [i, leg] of legs.entries()) {
    const day = leg.data.get(date);
    promised = day && taken(day.timetable, ready + BOARD_MARGIN, null);
    if (!promised) return null;
    ready = promised.aa + changes[i];
  }
  return promised.aa + lastWalk;
}

// Replay one plan. `by` is 'arrive' (be there by `time`) or 'leave' (set off at `time`); seconds since midnight.
function replay(world, plan, recorded, by, time, days) {
  const {firstWalk, lastWalk, changes} = plan, until = windowOf(plan, by, time, 0)[1];
  const legs = plan.legs.map(pool => legOf(world, pool, recorded));
  // Days every leg's source recorded. A day with no departure on leg 1 to try is a day the line did not run.
  const recordedDates = [...new Set(legs.flatMap(l => [...l.sources]))].map(s => world.meta.dates[s][days] || []).reduce((a, b) => a.filter(d => b.includes(d)));
  // Only days between the first and last on which every leg ran count, so a line that opened or closed during
  // the year is judged on its own months.
  const ran = recordedDates.filter(d => legs.every(l => l.data.get(d)?.list.length));
  const dates = recordedDates.filter(d => d >= ran[0] && d <= ran.at(-1));
  const leaveFor = sd => sd - BOARD_MARGIN - firstWalk;
  // Someone who sets off at `leave` plans the first vehicle timetabled after they reach the stop.
  const setOff = (date, leave) => {
    const board = leave + firstWalk + BOARD_MARGIN;
    const v = legs[0].data.get(date)?.list.find(v => v.sd >= board && v.sd <= board + MAX_WAIT);
    return v ? outcome(legs, date, v, changes, lastWalk, until) : {state: 'none'};
  };
  const summary = leave => {
    const all = dates.map(date => setOff(date, leave)), ok = all.filter(o => o.state === 'ok');
    const count = state => all.filter(o => o.state === state).length;
    // A day with no service for two hours (a closure or strike) is left out, as on the charts; but a plan that
    // could not be ridden on many days is a diversion or a rare variant, and no answer.
    if (ok.length < MIN_DAYS || all.length - count('none') - count('stranded') < MIN_RUNNING * all.length) return null;
    const arrivals = ok.map(o => o.arrive), gaps = ok.map(o => o.gap).filter(g => g != null);
    return {leave, days: ok.length, left_out: {none: count('none'), unknown: count('unknown'), stranded: count('stranded')},
            typical: percentile(arrivals, 0.5), reliable: percentile(arrivals, RELIABLE), until,
            timetable: ok.some(o => o.timetable != null) ? mostCommon(ok.map(o => o.timetable).filter(t => t != null)) : null,
            departure: mostCommon(ok.map(o => o.departure)), cancelled: ok.filter(o => o.cancelled).length,
            made: legs.length > 1 ? ok.filter(o => o.made).length : null, gap: gaps.length ? percentile(gaps, 0.5) : null,
            ridden: legs.map((l, i) => l.lines.map((_, line) => ok.filter(o => o.line[i] === line).length)),
            dots: ok.map(o => [Math.min(Math.round(o.arrive), until + 86400), o.cancelled ? 1 : o.made === false ? 2 : 0])};
  };
  let answer;
  if (by === 'leave') answer = summary(time);
  else {
    // The latest you could have set off each day and still been there in time.
    const latest = [];
    let stuckDays = 0;
    for (const date of dates) {
      const tries = (legs[0].data.get(date)?.list || []).filter(v => v.sd <= time);
      let found = null, known = false, stuck = !tries.length;
      for (let i = tries.length - 1; i >= 0 && found == null; i--) {
        const o = outcome(legs, date, tries[i], changes, lastWalk, until);
        stuck ||= o.state === 'stranded';
        // A departure too late to be there in time, on a day with too little read to say when it got there,
        // says nothing about the day.
        known ||= o.state === 'ok' && (o.arrive < Infinity || o.timetable != null && o.timetable <= time);
        if (o.state === 'ok' && o.arrive <= time) found = leaveFor(tries[i].sd);
      }
      if (found != null) latest.push(found); else if (known) latest.push(-Infinity); else if (stuck) stuckDays++;
    }
    if (latest.length < MIN_DAYS || latest.length < MIN_RUNNING * (latest.length + stuckDays)) return null;
    latest.sort((a, b) => b - a);
    const share = leave => latest.filter(l => l >= leave).length / latest.length;
    // The same train can leave a minute apart on different days (two timetables in a year). Leave in time for the
    // earliest of them, or someone leaving at this time misses it on most days and takes the one after.
    let k = Math.ceil(RELIABLE * latest.length) - 1;
    const edge = latest[k];
    while (k + 1 < latest.length && latest[k + 1] >= edge - 120) k++;
    const safe = latest[k];
    if (safe > -Infinity) {
      answer = summary(safe);
      // The usual departure after it, if the timetable says it would do, to show what cutting it fine costs.
      const next = answer && summary(leaveFor(answer.departure + 61));
      if (next && next.timetable <= time && next.departure > answer.departure) {
        const leave = leaveFor(next.departure);
        answer.later = {leave: Math.round(leave), share: share(leave), departure: next.departure, dots: summary(leave)?.dots || next.dots};
      }
    } else {
      // No departure made it nine days in ten: show the latest that did about as well as any.
      const usable = latest.filter(l => l > -Infinity);
      if (!usable.length) return null;
      // Under half the days is not a way to get there.
      if (usable.length < latest.length / 2) return null;
      answer = summary(usable[Math.max(0, Math.ceil((usable.length / latest.length - 0.05) * latest.length) - 1)]);
      if (answer) answer.unreliable = true;
    }
    if (answer) answer.share = share(answer.leave);
  }
  if (!answer) return null;
  for (const k of ['leave', 'typical', 'reliable', 'timetable']) if (answer[k] != null) answer[k] = Math.round(answer[k]);
  // Stops are named with their town ("Station, Middelburg"), unless the whole trip stays in one town.
  const ends = plan.legs.flatMap(pool => { const pair = livePairs(pool)[0]; return [pair.from, pair.to]; });
  const oneTown = new Set(ends.map(stop => stop.town).filter(Boolean)).size <= 1;
  const place = stop => ({name: oneTown ? stop.name : stopLabel(stop), town: stop.town, lat: stop.lat, lon: stop.lon});
  return {
    ...answer, seconds: Math.round(plan.seconds), changes: changes.map(Math.round),
    first_walk: Math.round(firstWalk), last_walk: Math.round(lastWalk),
    legs: legs.map((l, i) => {
      // The lines ridden on those days, most often first; the first is the one drawn on the map. Two routes
      // can share a name (a line's branches, or a line that changed operator): they are shown as one.
      const byName = new Map();
      l.lines.forEach((line, k) => {
        const m = line.meta, name = `${m.mode}|${m.name}|${m.short_name}`, n = answer.ridden[i][k], had = byName.get(name);
        byName.set(name, !had || n > had.most ? {...line, most: n, days: (had?.days || 0) + n} : {...had, days: had.days + n});
      });
      const order = [...byName.values()].filter(x => x.days).sort((a, b) => b.days - a.days);
      const pair = livePairs(plan.legs[i])[0];
      return {from: place(pair.from), to: place(pair.to), keys: [...new Set(l.lines.map(line => line.meta.key))],
              ride: order[0] && {key: order[0].meta.key, from: order[0].from, to: order[0].to},
              lines: order.map(({meta: m, days}) => ({key: m.key, mode: m.mode, operator: m.operator, short_name: m.short_name, name: m.name, days}))};
    }),
  };
}

// `origin` and `destination` are {lat, lon}; `time` is seconds since midnight; `days` is weekdays, saturday or sunday.
export async function plan(data, origin, destination, by, time, days) {
  const world = await load(data, [origin, destination]);
  const straight = metres(origin, destination);
  const walk = walkSeconds(straight) <= 1800 ? {seconds: Math.round(walkSeconds(straight)), metres: Math.round(straight * DETOUR)} : null;
  let {starts, finishes, plans} = candidates(world, origin, destination, by === 'arrive' ? time - 1800 : time, days);
  const nearest = ([s, m]) => ({name: stopLabel(s), metres: Math.round(m * DETOUR)});
  const out = {walk, straight: Math.round(straight), tried: plans.length, plans: [], days, coverage: world.meta.coverage,
               nearest: {from: starts[0] ? nearest(starts[0]) : null, to: finishes[0] ? nearest(finishes[0]) : null}};
  if (walk) plans = plans.filter(p => p.seconds <= walk.seconds + 300);
  if (!plans.length) return out;
  // Door to door, in the time you can rely on. A plan no quicker than walking is not worth showing.
  const length = p => by === 'arrive' ? time - p.leave : p.reliable - time;
  const key = p => p.unreliable ? -1e9 + p.share : p.leave;
  const answers = async before => {
    const recorded = await data.legs(days, plans.flatMap(p => wanted(p, by, time, before)));
    return plans.map(p => replay(world, p, recorded, by, time, days)).filter(p => p && !(walk && length(p) >= walk.seconds))
      .sort(by === 'arrive' ? (a, b) => key(b) - key(a) : (a, b) => a.reliable - b.reliable);
  };
  let done = await answers(BEFORE);
  // Nothing reliable among the departures just before: look further back before saying so.
  if (by === 'arrive' && !(done[0] && !done[0].unreliable)) done = await answers(LONG_BEFORE);
  // Drop a plan that only repeats the lines of a better one, or is far worse than the best.
  const within = (a, b) => a.keys.every(k => b.keys.includes(k));
  for (const p of done) {
    const repeat = out.plans.some(q => { let i = 0; for (const l of p.legs) if (i < q.legs.length && within(q.legs[i], l)) i++; return i === q.legs.length; });
    const worse = out.plans.length && (p.unreliable && !out.plans[0].unreliable || length(p) > length(out.plans[0]) * 1.25 + 600);
    if (!repeat && !worse && out.plans.length < SHOW) out.plans.push(p);
  }
  for (const p of out.plans) { delete p.ridden; for (const l of p.legs) delete l.keys; }
  return out;
}
