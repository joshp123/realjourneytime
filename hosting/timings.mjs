import {alternativeKeys, journeyRecords, ride} from './stats.js';

async function column(calls, path, range) {
  if (!range) return null;
  const [offset, length] = range;
  const body = await calls.read(path, {range: {offset, length}});
  if (!body) throw new Error('Missing route calls');
  return decodeCalls(calls, body);
}

async function decodeCalls(calls, compressed) {
  return new Int32Array(await calls.unzip(compressed));
}

// Columns are ordered by pattern and stop occurrence. Their four time arrays have one entry
// per trip in that pattern, across all service dates.
function positions(layout, stop) {
  let offset = 0;
  return layout.patterns.map((pattern, p) => pattern.map(id => {
    if (id !== stop) return -1;
    const start = offset;
    offset += layout.counts[p] * 4;
    return start;
  }));
}

const keep = (date, type, q) => (!q.days || type === q.days) &&
  (!q.start || date >= q.start) && (!q.end || date <= q.end);

async function readWithLayout(layout, from, to, q, readColumn) {
  const a = layout.stop_ids.indexOf(from), b = layout.stop_ids.indexOf(to);
  const rides = layout.patterns.map(pattern => ride(pattern, a, b));
  if (!rides.some(Boolean)) return [];
  const [origin, destination] = await Promise.all([
    readColumn(a),
    a === b ? null : readColumn(b),
  ]);
  const fromOffsets = positions(layout, a), toOffsets = positions(layout, b);
  const used = new Uint32Array(layout.counts.length);
  const result = [];
  for (const [date, type, patterns] of layout.days) {
    const selected = keep(date, type, q);
    const journeys = [];
    for (const p of patterns) {
      const j = used[p]++;
      const pair = rides[p];
      if (!selected || !pair) continue;
      const [i, k] = pair;
      const n = layout.counts[p];
      const x = fromOffsets[p][i] + j, y = toOffsets[p][k] + j;
      const end = destination ?? origin;
      const trip = [0, origin[x], origin[x + n], origin[x + 2 * n], origin[x + 3 * n],
        end[y], end[y + n], end[y + 2 * n], end[y + 3 * n]];
      const departure = trip[2] === -2 ? trip[1] : trip[2];
      if (q.lo !== undefined && (departure === -2 || departure < q.lo || departure > q.hi)) continue;
      for (let t = 1; t < trip.length; t++) if (trip[t] === -2) trip[t] = null;
      journeys.push(trip);
    }
    if (selected) result.push({date, type, journeys});
  }
  return result;
}

export async function chart(loadJson, calls, q) {
  const schedule = key => loadJson(`calls/${key}.json.gz`);
  const [index, primary] = await Promise.all([loadJson('public/index.json.gz'), schedule(q.route)]);
  const meta = index.routes.find(r => r.key === q.route);
  if (!meta || !meta.stop_ids.includes(q.from) || !meta.stop_ids.includes(q.to)) return null;
  const alternatives = alternativeKeys(index.routes, meta, q.from, q.to);
  const routes = [];
  // Pipeline route layouts and columns while the request's reader limits open bodies.
  const keys = [meta.key, ...alternatives];
  for (let i = 0; i < keys.length; i += 6) {
    const batch = await Promise.all(keys.slice(i, i + 6).map(async key => {
      const layout = key === meta.key ? primary : await schedule(key);
      if (!layout) throw new Error('Missing route schedule');
      const readColumn = plannerColumns(calls, `calls/${key}.bin`, layout, new Set([q.from, q.to]));
      const days = await readWithLayout(layout, q.from, q.to, {...q, days: q.days || 'weekdays'}, readColumn);
      return {stop_ids: ['from', 'to'], patterns: [[0, 1]], days};
    }));
    routes.push(...batch);
  }
  const x = journeyRecords(routes[0], 'from', 'to', () => true, routes.slice(1));
  return {scheduled: x.scheduled, cancelled: x.cancelled, stranded: x.stranded, alternatives,
    fields: ['date', 'sd', 'sa', 'arrival', 'real', 'timetable', 'cancelled', 'own'],
    records: x.records.map(z => [z.date, z.sd, z.sa, z.arrival, Math.round(z.real * 10) / 10,
      Math.round(z.timetable * 10) / 10, +z.cancelled, +z.own])};
}

const fields = ['sd', 'sa', 'ad', 'aa', 'cancelled'];

function formatLeg(days) {
  return days.map(({date, type, journeys}) => ({date, type, legs: journeys.flatMap(j => {
    const sd = j[2] ?? j[1], sa = j[5] ?? j[6];
    if (sd == null || sa == null) return [];
    const cancelled = (j[4] ?? j[3]) === -1 || (j[7] ?? j[8]) === -1;
    return [[sd, sa, cancelled ? null : j[4] ?? j[3], cancelled ? null : j[7] ?? j[8], +cancelled]];
  })})).filter(day => day.legs.length);
}

export async function plannerLegs(loadJson, calls, queries) {
  const grouped = new Map();
  queries.forEach((q, i) => {
    if (!grouped.has(q.route)) grouped.set(q.route, []);
    grouped.get(q.route).push([q, i]);
  });
  const legs = new Array(queries.length);
  const groups = [...grouped];
  for (let i = 0; i < groups.length; i += 6) {
    await Promise.all(groups.slice(i, i + 6).map(async ([route, list]) => {
      const layout = await loadJson(`calls/${route}.json.gz`);
      if (!layout) {
        for (const [, at] of list) legs[at] = {days: []};
        return;
      }
      const path = `calls/${route}.bin`;
      const stops = new Set(list.flatMap(([q]) => [q.from, q.to]));
      const readColumn = plannerColumns(calls, path, layout, stops);
      await Promise.all(list.map(async ([q, at]) => {
        const days = await readWithLayout(layout, q.from, q.to, q, readColumn);
        legs[at] = {days: formatLeg(days)};
      }));
    }));
  }
  return {fields, legs};
}

// Adjacent compressed blocks can share an R2 read. Bound the extra bytes so a
// query can never pull in a whole busy line just to read two stops far apart.
function plannerColumns(calls, path, layout, requested) {
  const columns = new Map(), ranges = [];
  for (let stop = 0; stop < layout.stop_ids.length; stop++) {
    if (!requested.has(layout.stop_ids[stop])) continue;
    const [offset, length] = layout.ranges[stop], end = offset + length;
    let range = ranges.at(-1);
    if (!range || offset - range.end > 24 * 1024 || end - range.start > 256 * 1024) {
      range = {start: offset, end, stops: []};
      ranges.push(range);
    }
    range.end = end;
    range.stops.push(stop);
    columns.set(stop, range);
  }
  const bodies = new Map(), decoded = new Map();
  return stop => {
    if (decoded.has(stop)) return decoded.get(stop);
    const range = columns.get(stop);
    if (range.stops.length === 1) {
      decoded.set(stop, column(calls, path, layout.ranges[stop]));
      return decoded.get(stop);
    }
    if (!bodies.has(range)) {
      bodies.set(range, calls.read(path, {range: {offset: range.start, length: range.end - range.start}}).then(body => {
        if (!body) throw new Error('Missing route calls');
        return body;
      }));
    }
    const [offset, length] = layout.ranges[stop];
    decoded.set(stop, bodies.get(range).then(body =>
      decodeCalls(calls, new Uint8Array(body, offset - range.start, length))));
    return decoded.get(stop);
  };
}
