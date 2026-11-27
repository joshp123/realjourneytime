// What the line page shows, worked out from a packed route (packed.mjs): one day of the line, vehicle by vehicle
// and stop by stop, and how long each stretch between stops takes. journeys.mjs answers with these on this
// machine; hosting/pack_lines.mjs writes the same answers out for the hosted site.

const SHARE = 0.1;      // a direction is a stop pattern that carried at least a tenth of the line's journeys
const ENOUGH = 20;      // journeys an hour of the day needs before it can be the worst hour
const LONGEST = 7200;   // a stretch that took longer than this is a fault in the record

const median = values => values.sort((a, b) => a - b)[values.length >> 1];
const middle = values => values.length ? median(values) : null;

// Every journey of one date: [pattern, then for each stop of the pattern in turn its planned time and how many
// seconds after it the vehicle was recorded]. The planned time is the departure, or the arrival at the last
// stop, in seconds since midnight at the first stop and since the stop before at the others, which keeps a
// year of a busy line small. null: not known. false: cancelled there. `journeyTimes` gives the times back.
export function lineDay(route, date) {
  const d = route.days.findIndex(day => day.date === date);
  if (d < 0) return null;
  const {blocks, data, time} = route, journeys = [];
  for (let b = 0; b < blocks.length; b += 4) {
    if (blocks[b] !== d) continue;
    const p = blocks[b + 1], stops = route.patterns[p].length, width = 4 * stops;
    for (let k = 0, at = blocks[b + 2]; k < blocks[b + 3]; k++, at += width) {
      const row = [p];
      let before = 0;
      for (let i = 0; i < stops; i++) {
        const x = at + 4 * i, sa = time(data[x]), sd = time(data[x + 1]), aa = time(data[x + 2]), ad = time(data[x + 3]);
        const planned = sd ?? sa, recorded = i === stops - 1 ? aa ?? ad : ad ?? aa;
        row.push(planned == null ? null : planned - before, recorded == null ? null : recorded === -1 ? false : recorded - (planned ?? before));
        before = planned ?? before;
      }
      journeys.push(row);
    }
  }
  return {date, type: route.days[d].type, journeys};
}

// The line's directions, and for each stretch between two stops in turn: the timetabled time, the usual
// recorded time, and the hour of the day when it is slowest, on weekdays. Times are in seconds.
export function lineSummary(route) {
  const {blocks, data, time} = route, total = route.weights.reduce((sum, w) => sum + w, 0);
  // Lines whose stops vary a lot, as on trains, may have no pattern that busy: then the two busiest stand for it.
  const busiest = route.weights.map((w, p) => [w, p]).filter(([, p]) => route.patterns[p].length > 1).sort((a, b) => b[0] - a[0]);
  const few = busiest.filter(([w]) => w >= SHARE * total).length < 2;
  const wanted = route.weights.map((w, p) => route.patterns[p].length > 1 && (w >= SHARE * total || few && busiest.slice(0, 2).some(([, q]) => q === p)));
  const runs = route.patterns.map((p, i) => wanted[i] ? p.slice(1).map(() => ({planned: [], hours: Array.from({length: 24}, () => [])})) : null);
  for (let b = 0; b < blocks.length; b += 4) {
    const p = blocks[b + 1];
    if (!runs[p] || route.days[blocks[b]].type !== 'weekdays') continue;
    const stops = route.patterns[p].length, width = 4 * stops;
    for (let k = 0, at = blocks[b + 2]; k < blocks[b + 3]; k++, at += width) {
      for (let i = 0; i + 1 < stops; i++) {
        const x = at + 4 * i, y = x + 4;
        const sd = time(data[x + 1]) ?? time(data[x]), sa = time(data[y]) ?? time(data[y + 1]);
        const ad = time(data[x + 3]) ?? time(data[x + 2]), aa = time(data[y + 2]) ?? time(data[y + 3]);
        if (sd != null && sa != null && sa >= sd) runs[p][i].planned.push(sa - sd);
        if (sd != null && ad != null && aa != null && ad >= 0 && aa >= ad && aa - ad <= LONGEST) {
          runs[p][i].hours[((Math.floor(sd / 3600) % 24) + 24) % 24].push(aa - ad);
        }
      }
    }
  }
  const directions = [];
  runs.forEach((list, p) => {
    if (!list) return;
    directions.push({pattern: p, journeys: route.weights[p], stretches: list.map(run => {
      const all = run.hours.flat();
      let worst = null, hour = null;
      run.hours.forEach((values, h) => {
        if (values.length < ENOUGH) return;
        const m = median(values);
        if (worst == null || m > worst) { worst = m; hour = h; }
      });
      return [middle(run.planned), middle(all), worst, hour, all.length];
    })});
  });
  directions.sort((a, b) => b.journeys - a.journeys);
  return {key: route.key, fields: ['timetable', 'usual', 'worst', 'worst_hour', 'journeys'], directions,
          dates: route.days.map(d => d.date), types: route.days.map(d => d.type[0])};
}
