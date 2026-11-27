// Journey-time statistics shared by the page and the bike ranking (node).

export const BIKE_KMH = 15;
export const BOARD_MARGIN = 60;      // you reach the stop a minute before the timetabled departure
export const MAX_WAIT = 7200;        // nothing leaves within two hours (strike, closure): left out
export const WINDOW = 3600;          // lines use a one-hour window centred on each arrival time
export const STEP = 300;
export const DAY_START = 3 * 3600;   // the chart runs from 03:00 to 03:00

export function bikeMinutes(route, from, to, kmh = BIKE_KMH) {
  const i = route.stop_ids.indexOf(from), j = route.stop_ids.indexOf(to);
  const metres = route.bike_metres?.[i]?.[j];
  return metres == null ? null : metres / (kmh * 1000 / 60);
}

// Positions of the ride from `a` to `b` in a list of stops, or null. Loop routes can call at a stop twice:
// take the shortest ride, as a passenger would.
export function ride(stops, a, b) {
  let best = null;
  stops.forEach((s, i) => {
    const j = s === a ? stops.indexOf(b, i + 1) : -1;
    if (j > 0 && (!best || j - i < best[1] - best[0])) best = [i, j];
  });
  return best;
}

// Positions of `from` and `to` in each pattern, or null where the pattern does not run from one to the other.
export function positions(route, from, to) {
  const a = route.stop_ids.indexOf(from), b = route.stop_ids.indexOf(to);
  return route.patterns.map(stops => ride(stops, a, b));
}

// One vehicle's ride between two stops, from its times at each (planned arrival and departure, then recorded
// arrival and departure; -1 is cancelled), or null if the timetable does not show the ride.
export function rideOf(sa0, sd0, aa0, ad0, sa1, sd1, aa1, ad1) {
  const sd = sd0 ?? sa0, sa = sa1 ?? sd1;
  if (sd == null || sa == null) return null;
  const cancelled = aa0 === -1 || ad0 === -1 || aa1 === -1 || ad1 === -1;
  const ad = ad0 ?? aa0, aa = aa1 ?? ad1;
  return {sd, sa, ad, aa, cancelled, tracked: !cancelled && ad != null && aa != null && aa > ad};
}

// Every vehicle timetabled from `from` to `to`, by date. Packed routes (pipeline/packed.mjs) read their own files.
export function vehicles(route, from, to, keepDay) {
  if (route.vehicles) return route.vehicles(from, to, keepDay);
  const where = positions(route, from, to);
  const byDate = new Map();
  for (const day of route.days) {
    if (!keepDay(day)) continue;
    const list = [];
    for (const j of day.journeys) {
      const pos = where[j[0]];
      if (!pos) continue;
      const x = 1 + 4 * pos[0], y = 1 + 4 * pos[1];
      const v = rideOf(j[x], j[x + 1], j[x + 2], j[x + 3], j[y], j[y + 1], j[y + 2], j[y + 3]);
      if (v) list.push(v);
    }
    byDate.set(day.date, list);
  }
  return byDate;
}

// The vehicles that ran and were tracked, in the order they left, with the one that gets there first among
// each and all later ones.
export function rideIndex(list) {
  const rides = list.filter(v => v.tracked).sort((p, q) => p.ad - q.ad);
  const bestFrom = new Array(rides.length);  // index of the earliest arrival among rides[i..]
  for (let i = rides.length - 1; i >= 0; i--) {
    bestFrom[i] = i + 1 < rides.length && rides[bestFrom[i + 1]].aa < rides[i].aa ? bestFrom[i + 1] : i;
  }
  return {rides, bestFrom};
}

// The vehicle you end up on when you are at the stop from `ready`: the one you planned if it ran (even if it
// left a little early: tracked stop times are only good to about a minute), or the first to get there of those
// that leave after you reach the stop, which covers cancellations and overtaking. Null if nothing more ran.
export function taken({rides, bestFrom}, ready, planned) {
  let lo = 0, hi = rides.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rides[mid].ad < ready) lo = mid + 1; else hi = mid; }
  const first = lo < rides.length ? rides[bestFrom[lo]] : null;
  return planned?.tracked && (!first || planned.aa <= first.aa) ? planned : first;
}

// One record per timetabled journey on `route` whose outcome is known (it ran and was tracked, or it was
// cancelled). `real` runs from the timetabled departure until you actually arrive, on the vehicle `taken`
// gives, counting this route and any of `alternatives`.
export function journeyRecords(route, from, to, keepDay = () => true, alternatives = []) {
  const planned = vehicles(route, from, to, keepDay);
  const others = alternatives.map(r => vehicles(r, from, to, keepDay));
  const records = [];
  let scheduled = 0, untracked = 0, stranded = 0;
  for (const [date, list] of planned) {
    scheduled += list.length;
    const index = rideIndex([list, ...others.map(o => o.get(date) || [])].flat());
    for (const v of list) {
      if (!v.tracked && !v.cancelled) { untracked++; continue; }
      const got = taken(index, v.sd - BOARD_MARGIN, v);
      if (!got || got.ad - v.sd > MAX_WAIT) { stranded++; continue; }
      records.push({date, sd: v.sd, sa: v.sa, ad: v.ad, aa: v.aa, cancelled: v.cancelled, own: got === v,
                    arrival: got.aa, real: (got.aa - v.sd) / 60, timetable: (v.sa - v.sd) / 60});
    }
  }
  return {records, scheduled, untracked, stranded, cancelled: records.filter(r => r.cancelled).length};
}

// Other routes of the same kind that call at both stops (stop lists come from the index).
export function alternativeKeys(index, route, from, to) {
  const rail = route.mode === 'train';
  return index.filter(r => r.key !== route.key && (r.mode === 'train') === rail
                           && r.stop_ids.includes(from) && r.stop_ids.includes(to)).map(r => r.key);
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const mean = values => values.reduce((s, v) => s + v, 0) / values.length;

// Rolling lines across the day. Gaps where a window holds fewer than `minimum` journeys.
export function lines(records, minimum = 5) {
  const sorted = [...records].sort((a, b) => a.arrival - b.arrival);
  const out = [];
  let lo = 0, hi = 0;
  for (let t = DAY_START; t <= DAY_START + 86400; t += STEP) {
    while (lo < sorted.length && sorted[lo].arrival < t - WINDOW / 2) lo++;
    while (hi < sorted.length && sorted[hi].arrival < t + WINDOW / 2) hi++;
    const window = sorted.slice(lo, hi);
    if (window.length < minimum) { out.push({at: t, n: window.length}); continue; }
    const real = window.map(r => r.real);
    out.push({at: t, n: window.length, p90: percentile(real, 0.9), mean: mean(real),
              timetable: mean(window.map(r => r.timetable))});
  }
  return out;
}

export function summary(records) {
  if (!records.length) return null;
  const real = records.map(r => r.real);
  return {n: records.length, p90: percentile(real, 0.9), median: percentile(real, 0.5), mean: mean(real),
          timetable: mean(records.map(r => r.timetable)), cancelled: records.filter(r => r.cancelled).length / records.length};
}
