// A trip between two places, from every recorded ride on every line that makes it. The rules are those of
// stats.js: a journey runs from its timetabled departure until you arrive, on the vehicle you planned if it ran,
// or the first to get there of those leaving after you reach the stop, on any line.
import {BOARD_MARGIN, MAX_WAIT, lines, percentile, rideIndex, taken} from './stats.js';
import {lineLabel} from './data.js';

const ALIKE = 1.1;        // lines whose timetabled time is within a tenth of the fastest are one kind of service
const NAMED = 0.01;       // a line is named when it carries at least 1 journey in 100
const FEW = 0.5;          // under half the timetabled journeys tracked: dots, but no lines

// Every timetabled journey, by line label, with how it turned out. `legs` and `found` come from data.js.
export function tripJourneys(legs, found) {
  const byDate = new Map();
  legs.forEach((leg, i) => {
    const line = lineLabel(leg.route);
    for (const [date, list] of found[i]) {
      if (!byDate.has(date)) byDate.set(date, []);
      const day = byDate.get(date);
      for (const [sd, sa, ad, aa, cancelled] of list) {
        day.push({sd, sa, ad, aa, cancelled: !!cancelled, tracked: !cancelled && ad != null && aa != null && aa > ad, line, key: leg.route.key});
      }
    }
  });
  const journeys = [];
  for (const [date, list] of byDate) {
    const index = rideIndex(list);
    for (const v of list) {
      const got = v.tracked || v.cancelled ? taken(index, v.sd - BOARD_MARGIN, v) : null;
      const stranded = (v.tracked || v.cancelled) && (!got || got.ad - v.sd > MAX_WAIT);
      journeys.push({date, line: v.line, key: v.key, sd: v.sd, sa: v.sa, cancelled: v.cancelled, tracked: v.tracked, stranded,
                     timetable: (v.sa - v.sd) / 60, got: got && !stranded ? got : null,
                     arrival: got && !stranded ? got.aa : null, real: got && !stranded ? (got.aa - v.sd) / 60 : null});
    }
  }
  return journeys;
}

// The lines worth naming, and which of them are the same kind of service. Lines that take about the same time
// by timetable are drawn together; where kinds differ (Intercity, Sprinter, Metro E), the fastest opens, and a
// faster and a slower service are never averaged into a timetable that no vehicle runs to.
export function lineKinds(journeys) {
  const byLine = new Map();
  for (const j of journeys) {
    if (!byLine.has(j.line)) byLine.set(j.line, {line: j.line, key: new Map(), n: 0, times: []});
    const entry = byLine.get(j.line);
    entry.n++; entry.times.push(j.timetable);
    entry.key.set(j.key, (entry.key.get(j.key) || 0) + 1);
  }
  const named = [...byLine.values()].filter(l => l.n >= NAMED * journeys.length)
    .map(l => ({line: l.line, n: l.n, timetable: percentile(l.times, 0.5), key: [...l.key].sort((a, b) => b[1] - a[1])[0][0]}))
    .sort((a, b) => a.timetable - b.timetable);
  const fastest = named.filter(l => l.timetable <= named[0].timetable * ALIKE + 1);
  const alike = fastest.length === named.length;
  named.sort((a, b) => a.line.localeCompare(b.line, 'en', {numeric: true}));
  return {named, alike, opens: alike ? null : fastest.map(l => l.line)};
}

// What the chart draws for the chosen lines (null: every line).
export function tripChart(journeys, chosen) {
  const planned = chosen ? journeys.filter(j => chosen.includes(j.line)) : journeys;
  const records = planned.filter(j => j.real != null);
  const real = records.map(r => r.real);
  const days = new Set(planned.map(j => j.date));
  return {
    records, rows: lines(records),
    scheduled: planned.length, cancelled: planned.filter(j => j.cancelled).length,
    days: days.size, first: [...days].sort()[0], last: [...days].sort().at(-1),
    few: records.length < FEW * planned.length,
    sure: real.length ? percentile(real, 0.9) : null,
    average: real.length ? real.reduce((sum, v) => sum + v, 0) / real.length : null,
    timetable: records.length ? records.reduce((sum, r) => sum + r.timetable, 0) / records.length : null,
  };
}
