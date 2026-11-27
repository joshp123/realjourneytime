// Journey times: every recorded journey between two places, on every line that makes the trip.
import {chart, chartImage, describeJourney, SURE} from './chart.js';
import {json, legsBetween, lineNames, linesAt, meta, metres, placeNamed, placeOfStop, places, reachable, rides, search, searchLines} from './data.js';
import {baseMap, bikeLine, mapKey, pin, routeLine} from './map.js';
import {lineKinds, tripChart, tripJourneys} from './trip.js';
import {$, DAYS, address, clock, dateLabel, esc, go, minutes, searchBox, span, speedControl, thousands, token} from './ui.js';
import {timeView} from './view-timing.js';

const OPENS = {from: 'Amsterdam Centraal', to: 'Museumplein, Amsterdam'};
const TRY = [['Rotterdam Centraal', 'Den Haag Centraal'], ['Capelsebrug, Rotterdam', 'Schiedam Centrum'], ['Amsterdam Centraal', 'Museumplein, Amsterdam'], ['Utrecht Centraal', 'Amsterdam Centraal']];
const NEARBY = 700;       // metres: how far to look for a stop that does have a direct line
const BIKE_LIMIT = 80000; // metres: beyond this nobody is comparing with a bike
const MODES = {train: 'Train', metro: 'Metro', tram: 'Tram', bus: 'Bus'};
const short = label => label.replace(/, [^,]+$/, '');

const FRAME = `
  <div class="pick">
    <div class="field"><label for="from">From</label><input class="box" id="from" data-l="From" type="text" inputmode="search" enterkeyhint="search" spellcheck="false" autocomplete="off" autocorrect="off" placeholder="Stop or station" role="combobox" aria-expanded="false" aria-controls="from-list"><div class="list" id="from-list" role="listbox" hidden></div></div>
    <button class="swap" id="swap" type="button" aria-label="Swap From and To">⇄</button>
    <div class="field"><label for="to">To</label><input class="box" id="to" data-l="To" type="text" inputmode="search" enterkeyhint="search" spellcheck="false" autocomplete="off" autocorrect="off" placeholder="Stop or station" role="combobox" aria-expanded="false" aria-controls="to-list"><div class="list" id="to-list" role="listbox" hidden></div></div>
  </div>
  <div class="bar"><div class="seg" id="days"></div><div class="speed" id="speed"></div></div>
  <section class="card">
    <h1 id="title"></h1>
    <div class="by" id="by"></div>
    <div class="key" id="key"></div>
    <div class="chart" id="chart"></div>
  </section>
  <div class="foot"><div><p class="mean" id="mean"></p><p class="count" id="count"></p><p class="count" id="stops"></p></div>
    <div class="acts" id="acts" hidden><button class="btn" id="save" type="button">Save image</button><button class="btn" id="download" type="button">Download the data</button></div></div>
  <div class="map" id="trip-map"></div>
  <p class="try" id="try"></p>
  <details class="more"><summary>Data and methods</summary>
    <p id="sources"></p>
    <p>A journey runs from the timetabled departure to the moment you arrive. If your vehicle was cancelled, or another one got there first, the one that got you there counts, wait included. Lines that take about the same time, such as Tram 2, 12 and 24, are counted together. Faster and slower ones, such as Intercity and Sprinter, are shown apart.</p>
    <p>Each line on the chart uses the journeys arriving within half an hour either side. "${SURE}" is the time that was enough for nine of every ten.</p>
    <p>Times when nothing ran for two hours or more, as in a strike, are left out.</p>
    <p>The bike takes the shortest legal route on OpenStreetMap, with ferries that run all year, at the speed you choose. Traffic lights and parking are not counted.</p>
    <p>After Tom Forth's <a href="https://tomforth.co.uk/realjourneytime/">Real Journey Time</a> for buses in England. The idea and the nine-in-ten measure are his.</p>
  </details>`;

let map = null, drawn = null, turn = 0;
const now = {};   // what the search boxes act on: the page as it is drawn now

export async function show(root, q) {
  const mine = ++turn, done = timeView('journey');
  if (q.has('route')) return oldLink(q);
  const state = {from: q.get('from') || OPENS.from, to: q.get('to') || OPENS.to, days: DAYS[q.get('days')] ? q.get('days') : 'weekdays',
                 kmh: [15, 20, 25, 45].includes(+q.get('kmh')) ? +q.get('kmh') : 15, lines: q.get('lines')};
  const link = change => address({...(q.has('from') || change.from || change.to ? {from: state.from, to: state.to} : {}),
    days: state.days === 'weekdays' ? null : state.days, kmh: state.kmh === 15 ? null : state.kmh, lines: state.lines, ...change});
  if (!$('trip-map')) { root.innerHTML = FRAME; map = null; drawn = null; pickers(); sources(); }
  Object.assign(now, {state, link, from: null});
  const say = (text, button) => { $('chart').innerHTML = `<div class="msg"><span>${text}</span>${button ? `<button class="btn" type="button" id="again">${button}</button>` : ''}</div>`; };
  const clear = () => { for (const id of ['by', 'key', 'mean', 'count', 'stops']) $(id).innerHTML = id === 'by' || id === 'key' ? '&nbsp;' : ''; $('acts').hidden = true; $('chart').classList.add('short'); };

  $('from').value = state.from; $('to').value = state.to;
  $('days').innerHTML = Object.keys(DAYS).map(d => `<a href="${link({days: d === 'weekdays' ? null : d, lines: null})}" data-go class="${d === state.days ? 'on' : ''}">${d === 'weekdays' ? 'Weekdays' : d === 'saturday' ? 'Saturday' : 'Sunday'}</a>`).join('');
  $('speed').innerHTML = speedControl(state.kmh);
  $('speed').onclick = event => { const k = event.target.dataset?.kmh; if (k) go(link({kmh: k === '15' ? null : k}), true); };
  $('title').textContent = `${short(state.from)} to ${short(state.to)} on ${DAYS[state.days]}`;
  $('try').innerHTML = 'Try ' + TRY.filter(([a, b]) => a !== state.from || b !== state.to).slice(0, 2)
    .map(([a, b]) => `<a href="${address({from: a, to: b})}" data-go>${esc(short(a))} to ${esc(short(b))}</a>`).join(' or ') + '.';
  $('swap').onclick = () => go(link({from: state.to, to: state.from, lines: null}));
  const same = drawn && drawn.from === state.from && drawn.to === state.to && drawn.days === state.days;
  if (!same) { clear(); say('Loading'); }

  try {
    const [from, to] = await Promise.all([placeNamed(state.from), placeNamed(state.to)]);
    if (mine !== turn) return;
    now.from = from;
    if (!from || !to) { clear(); return say(`No stop or station is called ${esc(!from ? state.from : state.to)}.`); }
    const trip = same ? drawn.trip : await load(from, to, state.days);
    if (mine !== turn) return;
    drawn = {from: state.from, to: state.to, days: state.days, trip};
    if (trip.none) { nothingDirect(from, to, trip, state, say, clear); done('answer'); return done('complete'); }
    answer(from, to, trip, state, link, done);
  } catch (error) {
    if (mine !== turn) return;
    console.error(error);
    clear(); say('This trip did not load.', 'Try again');
    $('again').onclick = () => { drawn = null; show(root, q); };
    done('error');
  }
}

// Everything about a trip that does not depend on the lines chosen or the bike's speed.
async function load(from, to, days) {
  const routes = await linesAt(from);
  const direct = reachable(from, routes);
  const bike = (a, b) => json(`api/bike-route?a=${a[0]},${a[1]}&b=${b[0]},${b[1]}`).catch(() => null);
  const none = async () => ({none: true, direct, bike: await bike([from.lat, from.lon], [to.lat, to.lon])});
  if (!direct.some(e => e.place === to.id)) return none();
  const legs = legsBetween(from, to, routes), found = await rides(legs, days);
  const journeys = tripJourneys(legs, found);
  if (!journeys.length) return none();
  // The bike rides between the platforms most journeys use, not the middle of a station.
  const used = found.map(byDate => [...byDate.values()].reduce((sum, list) => sum + list.length, 0));
  const busiest = legs[used.indexOf(Math.max(...used))];
  return {legs, journeys, kinds: lineKinds(journeys), bike: await bike(busiest.a.slice(2, 4), busiest.b.slice(2, 4))};
}

function pickers() {
  const row = p => ({label: p.label, small: p.kind, value: {place: p}});
  searchBox($('from'), $('from-list'), async text => {
    if (!text) return {rows: []};
    const [found, lines] = await Promise.all([search(text), searchLines(text)]);
    return {rows: [...lines.map(l => ({label: `${short(l.from.label)} to ${short(l.to.label)}`, small: `${l.name}, ${l.town}`, value: {line: l}})), ...found.map(row)]};
  }, value => value.line ? go(address({from: value.line.from.label, to: value.line.to.label}))
    : go(now.link({from: value.place.label, to: now.state.to, lines: null})));
  // To offers only places something runs to directly from From, busiest first. A place with no direct line is
  // shown, greyed, with the nearest stops that have one.
  searchBox($('to'), $('to-list'), async text => {
    const from = now.from;
    if (!from) return {rows: (await search(text)).map(row)};
    const [all, direct] = await Promise.all([places(), linesAt(from).then(routes => reachable(from, routes))]);
    const lines = new Map(direct.map(e => [e.place, lineNames(e.lines)]));
    if (!text) return {head: `Direct from ${short(from.label)}, busiest first`, rows: direct.slice(0, 8).map(e => ({label: all[e.place].label, small: lines.get(e.place), value: {place: all[e.place]}}))};
    const rows = [];
    let without = 0;
    for (const p of await search(text, 40)) {
      if (p.id === from.id) continue;
      if (lines.has(p.id)) { rows.push({label: p.label, small: lines.get(p.id), value: {place: p}}); continue; }
      if (++without > 2) continue;
      rows.push({label: p.label, small: 'No direct line', off: true});
      for (const [d, near] of nearest(p, direct, all)) rows.push({label: near.label, small: `${away(d)} · ${lines.get(near.id)}`, value: {place: near}});
    }
    const seen = new Set();
    return {rows: rows.filter(r => r.off || !seen.has(r.label) && seen.add(r.label)).slice(0, 8)};
  }, value => go(now.link({from: now.state.from, to: value.place.label, lines: null})));
}

async function sources() {
  const {coverage: c} = await meta();
  $('sources').textContent = `Trains come from the Rijden de Treinen archive, ${dateLabel(c.trains.start)} to ${dateLabel(c.trains.end)}. Metros, trams and buses of Arriva, Connexxion, EBS, GVB, HTM, Keolis, Qbuzz and RET come from Adriaan van Natijne's archive, ${dateLabel(c.transit.start)} to ${dateLabel(c.transit.end)}.`;
}

const away = d => `${Math.max(50, Math.round(d / 50) * 50)} m away`;
const nearest = (place, direct, all) => direct.map(e => [metres(place, all[e.place]), all[e.place]]).filter(([d]) => d <= NEARBY).sort((a, b) => a[0] - b[0]).slice(0, 2);

async function nothingDirect(from, to, trip, state, say, clear) {
  clear();
  const all = await places(), near = nearest(to, trip.direct, all);
  const bike = trip.bike?.metres && trip.bike.metres <= BIKE_LIMIT ? trip.bike.metres / (state.kmh * 1000 / 60) : null;
  if (bike != null) $('key').innerHTML = `<span class="at"></span>${figure('k-bike', 'by bike', bike)}`;
  say(`Nothing runs direct from ${esc(short(from.label))} to ${esc(short(to.label))}.` + (near.length ? `<small>Nearest ${near.length > 1 ? 'stops' : 'stop'} with a direct line: ${
    near.map(([d, p]) => `<a href="${address({from: from.label, to: p.label})}" data-go>${esc(short(p.label))}</a>, ${away(d)}`).join(', and ')}.</small>` : ''));
  tripMap(from, to, null, null, trip.bike);
}

const figure = (cls, name, v) => { const [n, unit] = span(v); return `<div class="${cls}"><b>${n}</b><span class="u">${unit}</span> ${name}</div>`; };

function answer(from, to, trip, state, link, done) {
  const {kinds} = trip, labels = kinds.named.map(l => l.line);
  const asked = state.lines?.split(',').filter(l => labels.includes(l));
  const chosen = asked?.length ? asked : kinds.opens;
  const model = tripChart(trip.journeys, chosen);
  const bike = trip.bike?.metres && trip.bike.metres <= BIKE_LIMIT ? trip.bike.metres / (state.kmh * 1000 / 60) : null;
  const lines = chosen ? kinds.named.filter(l => chosen.includes(l.line)) : kinds.named;
  const main = [...lines].sort((a, b) => b.n - a.n)[0];

  $('by').innerHTML = labels.length < 2 ? esc(labels[0] || '')
    : (kinds.alike ? `<a href="${link({lines: null})}" data-go class="${chosen ? '' : 'on'}">All lines</a>` : '') +
      labels.map(l => `<a href="${link({lines: l})}" data-go class="${chosen?.includes(l) ? 'on' : ''}">${esc(l)}</a>`).join('');
  $('chart').classList.remove('short');

  const numbers = row => {
    const v = row ? {sure: row.p90, average: row.mean, timetable: row.timetable} : model;
    return (model.few ? [] : [[Math.ceil(v.sure - 1e-9), SURE.toLowerCase(), 'k-sure'], [v.average, 'average', 'k-avg'], [v.timetable, 'timetable', 'k-tt']])
      .concat(bike != null ? [[bike, 'by bike', 'k-bike']] : []);
  };
  const key = row => { $('key').innerHTML = `<span class="at">${row ? 'Arriving at ' + clock(row.at) : model.few ? '' : 'Across the day'}</span>` + numbers(row).map(([v, name, cls]) => figure(cls, name, v)).join(''); };
  chart($('chart'), model, {bikeMinutes: bike, lines: model.few ? false : undefined, onAt: key, describe: r => describeJourney(r)});
  done('answer');

  const days = `${thousands(model.days)} ${DAYS[state.days]}, ${dateLabel(model.first)} to ${dateLabel(model.last)}`;
  $('mean').textContent = model.few ? '' : `"${SURE}" is enough time for nine journeys in ten: you are late about once a week.`;
  $('count').innerHTML = (model.few ? `<b class="warn">Only ${thousands(model.records.length)} of ${thousands(model.scheduled)} timetabled journeys were tracked.</b> ` : '') +
    `Each dot is one journey. ${model.few ? '' : thousands(model.records.length) + ' journeys and '}${thousands(model.cancelled)} cancellations on ${days}.`;
  $('stops').innerHTML = 'Stop by stop: ' + lines.map(l => `<a href="${address({line: l.key})}" data-go>${esc(l.line)}</a>`).join(', ') + '.';
  $('acts').hidden = false;
  const name = `real-journey-time-${short(from.label)}-to-${short(to.label)}`.replace(/[^\w]+/g, '-').toLowerCase();
  $('save').onclick = async () => save(await chartImage($('chart'), $('title').textContent,
    numbers(null).map(([v, n, cls]) => [minutes(v), n, token({'k-sure': '--sure', 'k-avg': '--average', 'k-tt': '--timetable', 'k-bike': '--bike'}[cls])]),
    `${thousands(model.records.length)} journeys on ${days}. realjourneytime.jjpcodes.com`), `${name}.png`);
  $('download').onclick = () => save(new Blob([csv(trip.journeys, chosen)], {type: 'text/csv'}), `${name}-${state.days}.csv`);
  tripMap(from, to, trip, main, trip.bike).then(() => done('complete'));
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Every timetabled journey of the chosen lines, one row each, as the chart counts it.
function csv(journeys, chosen) {
  const t = s => s == null ? '' : clock(s) + ':' + String(((s % 60) + 60) % 60).padStart(2, '0');
  const rows = [['date', 'line', 'due_to_leave', 'due_to_arrive', 'cancelled', 'rode', 'left', 'arrived', 'minutes', 'timetable_minutes']];
  for (const j of journeys) {
    if (chosen && !chosen.includes(j.line)) continue;
    rows.push([j.date, j.line, t(j.sd), t(j.sa), j.cancelled ? 1 : 0, j.got?.line ?? '', t(j.got?.ad), t(j.arrival), j.real == null ? '' : j.real.toFixed(1), j.timetable.toFixed(1)]);
  }
  return rows.map(r => r.join(',')).join('\n') + '\n';
}

// The map draws the trip and nothing else: the busiest chosen line between the two places, and the bike's route.
let layers = [], mapped = null;
async function tripMap(from, to, trip, main, bike) {
  if (!map) { map = baseMap('trip-map'); mapped = null; }
  const what = `${from.id}|${to.id}|${main?.key}`;
  if (mapped === what) return;
  for (const layer of layers) layer.remove();
  layers = [];
  let a = [from.lat, from.lon], b = [to.lat, to.lon], bounds = L.latLngBounds([a, b]);
  if (main) {
    const leg = trip.legs.filter(l => l.route.key === main.key)[0];
    a = [leg.a[2], leg.a[3]]; b = [leg.b[2], leg.b[3]];
    const route = await json(`api/route?key=${encodeURIComponent(main.key)}`).catch(() => null);
    const line = routeLine(between(route?.shapes || [], a, b)).addTo(map);
    layers.push(line, mapKey(map, MODES[leg.route.mode]));
    bounds = line.getBounds();
  }
  if (bike?.path?.length && bike.metres <= BIKE_LIMIT) layers.push(bikeLine(bike.path).addTo(map));
  layers.push(L.marker(a, {icon: pin('A'), interactive: false}).addTo(map), L.marker(b, {icon: pin('B', 'b'), interactive: false}).addTo(map));
  map.fitBounds(bounds.pad(0.25));
  mapped = what;
}

// The part of a line's shape that runs from near one point to near another, in that order.
function between(shapes, a, b) {
  const d = (p, q) => Math.hypot(p[0] - q[0], (p[1] - q[1]) * Math.cos(p[0] * Math.PI / 180));
  let best = null;
  for (const shape of shapes) {
    const near = point => shape.reduce((k, p, i) => d(p, point) < d(shape[k], point) ? i : k, 0);
    const i = near(a), j = near(b);
    if (i < j && (!best || d(shape[i], a) + d(shape[j], b) < best[0])) best = [d(shape[i], a) + d(shape[j], b), shape.slice(i, j + 1)];
  }
  return best && best[0] < 0.01 ? [a, ...best[1], b] : [a, b];
}

// A link to the old site named a line and two platforms. Show the trip between their places.
async function oldLink(q) {
  const route = await json(`api/route?key=${encodeURIComponent(q.get('route'))}`).catch(() => null);
  const names = await Promise.all(['from', 'to'].map(async k => {
    const stop = route?.stops?.[q.get(k)];
    return stop && (await placeOfStop(q.get(k), stop.lat, stop.lon))?.label;
  }));
  go(address(names[0] && names[1] ? {from: names[0], to: names[1], days: q.get('days') === 'weekdays' ? null : q.get('days')} : {}), true);
}
