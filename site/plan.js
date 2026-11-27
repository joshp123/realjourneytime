// "Plan": where from, where to, when; then one sentence, its evidence, the other ways and a map.
// The sums are in planner.js and the data comes through plan-data.js; this file is the form, the words and the pictures.
import * as data from './plan-data.js';
import {plan as planTrip, nameOf} from './planner.js';
import {$, esc, clock, clockUp, duration, dateLabel, glyph, atSpeed, replaceOnType, DAYS} from './ui.js';
import {timeView} from './view-timing.js';
import {diagnose} from './diagnostics.js';

// An arrival, or "after 11:00" when it was later than the last departure that was looked at.
const arrival = (s, p) => s > p.until ? `after ${clock(p.until)}` : clockUp(s);
const seconds = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
const inTen = (share, days = 'days') => share >= 0.995 ? 'every day' : share < 0.1 ? 'hardly ever' : `${Math.floor(share * 10 + 1e-9)} ${days} in 10`;
const km = metres => `${(metres / 1000).toFixed(1)} km`;
const BIKE_LIMIT = 80000;   // metres; further than this the bike is not compared
const MANY_DAYS = 60;       // above this a strip's dots would merge, so it draws bars
const EXAMPLES = [
  {a: {lat: 51.924420, lon: 4.469000, label: 'Rotterdam Centraal'}, b: {lat: 51.917200, lon: 4.524600, label: 'Erasmus University, Rotterdam'},
   title: 'Rotterdam Centraal to Erasmus University', sub: 'Rotterdam'},
  {a: {lat: 52.37503, lon: 5.21764, label: 'Almere Centrum'}, b: {lat: 52.378901, lon: 4.900272, label: 'Amsterdam Centraal'}, sub: 'By train'},
  {a: {lat: 53.21056, lon: 6.56472, label: 'Groningen'}, b: {lat: 53.240386, lon: 6.535236, label: 'Zernikeplein, Groningen'},
   title: 'Groningen to Zernikeplein', sub: 'By train and bus'},
];

const trip = {a: null, b: null, by: 'arrive', time: '09:00', days: 'weekdays'};
let ctx, answer = null, bike = null, chosen = 0, open = false, asked = 0, map, layer, started = false, coverage = null;
let markPlan;

const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const store = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing */ } },
};

// ---------- a box you type a place in: Plan's From and To, and How far's From ----------

// Stops and stations whose name or town has a word starting with each word typed, busiest first.
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let stopNames;
async function searchStops(text, limit = 7) {
  stopNames ||= (await data.places()).map(([label, kind, lat, lon, weight]) => ({label, kind, sub: kind === 'Railway station' ? 'Station' : 'Stop', lat, lon, weight, text: fold(label)}));
  const typed = fold(text).split(' ').filter(Boolean), whole = typed.join(' '), found = [];
  if (!typed.length) return [];
  for (const place of stopNames) {
    if (!typed.every(t => place.text.startsWith(t) || place.text.includes(' ' + t))) continue;
    found.push([(place.text === whole ? 4 : place.text.startsWith(whole) ? 2 : 0) + (place.sub === 'Station' ? 3 : 0) + place.weight / 2, place]);
  }
  return found.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, place]) => place);
}

// Stops and stations come from our own data; addresses, streets and towns from PDOK, the government's address search.
async function suggestions(text) {
  const q = encodeURIComponent(text);
  const stops = searchStops(text).catch(() => []);
  const addresses = text.length < 3 ? [] : get(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?rows=5&fq=type:(adres OR weg OR postcode OR woonplaats)&q=${q}`)
    .then(r => r.response.docs.map(d => ({label: d.weergavenaam, sub: {adres: 'Address', weg: 'Street', postcode: 'Postcode', woonplaats: 'Town'}[d.type], pdok: d.id})))
    .catch(() => []);
  const [s, a] = await Promise.all([stops, addresses]);
  return [...s.slice(0, a.length ? 4 : 7), ...a];
}

async function locate(item) {
  if (item.lat != null) return {lat: item.lat, lon: item.lon, label: item.label};
  const r = await get(`https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup?fl=centroide_ll&id=${encodeURIComponent(item.pdok)}`);
  const [lon, lat] = r.response.docs[0].centroide_ll.match(/-?[\d.]+/g).map(Number);
  return {lat: +lat.toFixed(5), lon: +lon.toFixed(5), label: item.label};
}

export function rememberPlace(place) {
  const recent = store.read('rjt-places', []).filter(p => p.label !== place.label);
  store.write('rjt-places', [{lat: place.lat, lon: place.lon, label: place.label}, ...recent].slice(0, 6));
}

const picture = it => glyph(it.here ? 'here' : it.recent ? 'recent' : it.pdok ? 'place' : it.sub === 'Station' ? 'train'
  : /metro/i.test(it.kind) ? 'metro' : /tram/i.test(it.kind) ? 'tram' : 'bus');

// `id` is the input's; its list is `${id}-list` and the line for a problem `${id}-error`. `current` gives the
// text of the place already chosen, `onPlace` gets a place that was picked and `onHere` is called for My location.
// Returns {fail(text), ok()} to say a problem under the box and to take it away.
export function placeField(id, {current, onPlace, onHere}) {
  const input = $(id), list = $(`${id}-list`), error = $(`${id}-error`), fresh = replaceOnType(input);
  let items = [], active = -1, typed = 0, timer;
  const ok = () => { error.hidden = true; };
  const fail = text => { error.innerHTML = `${glyph('warn')}${esc(text)}`; error.hidden = false; };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const draw = () => {
    list.innerHTML = items.map((it, i) => `<div role="option" id="${id}-list-${i}" class="suggest__row" data-i="${i}" aria-selected="${i === active}">
      ${picture(it)}<span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></div>`).join('')
      || '<p class="suggest__none">No places found. Try a street and town, or a station.</p>';
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `${id}-list-${active}` : '');
  };
  const pick = async i => {
    const item = items[i];
    if (!item) return;
    close(); input.blur(); ok();
    diagnose('place', id, i);
    if (item.here) return onHere();
    try { onPlace(await locate(item)); } catch { diagnose('error', id); fail('Place not found. Try a street and town, or a station.'); }
  };
  // Before anything is typed: My location and the places used lately, whatever the box still shows.
  const refresh = async () => {
    const text = fresh.untouched() ? '' : input.value.trim(), mine = ++typed;
    if (!text) items = [{here: true, label: 'My location'}, ...store.read('rjt-places', []).map(p => ({...p, recent: true, sub: 'Recent'}))];
    else {
      const found = await suggestions(text);
      if (mine !== typed) return;
      items = found;
    }
    active = text && items.length ? 0 : -1;
    draw();
  };
  input.addEventListener('focus', () => { ok(); refresh(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 120); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length) { active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; draw(); }
    } else if (event.key === 'Enter') { event.preventDefault(); pick(Math.max(active, 0)); }
    else if (event.key === 'Escape') { close(); input.blur(); }
  });
  // Leaving the box without choosing puts back the place that was chosen.
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) { close(); input.value = current(); } }, 180));
  list.addEventListener('pointerdown', event => {
    const row = event.target.closest('[data-i]');
    if (row) { event.preventDefault(); pick(+row.dataset.i); }
  });
  const clear = input.closest('.field').querySelector('.field__clear');
  clear.addEventListener('mousedown', event => event.preventDefault());
  clear.addEventListener('click', () => { input.value = ''; input.focus(); fresh.touch(); refresh(); });
  return {fail, ok};
}

// The reader's own position, with the nearest stop for a name. `problem` gets the words when it cannot be had.
export function myLocation(found, problem, pointOnMap = false) {
  const type = pointOnMap ? 'Type a place or choose a point on the map.' : 'Type a place.';
  if (!navigator.geolocation) return problem(`This browser cannot give a location. ${type}`);
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = +pos.coords.latitude.toFixed(5), lon = +pos.coords.longitude.toFixed(5);
    let near = null;
    try { near = await nameOf(data, {lat, lon}); } catch { /* the name is a nicety */ }
    found({lat, lon, here: true, label: near ? `My location (${near.replace(/^Near /, 'near ')})` : 'My location'});
  }, () => problem(`Location access is off. Allow it in browser settings, ${pointOnMap ? 'type a place, or choose a point on the map' : 'or type a place'}.`),
  {enableHighAccuracy: true, timeout: 10000, maximumAge: 60000});
}

export const nameOfPoint = point => nameOf(data, point);

// ---------- Plan's two boxes ----------

const fields = {a: {input: 'plan-from'}, b: {input: 'plan-to'}};

function setPlace(end, place) {
  trip[end] = place;
  $(fields[end].input).value = place ? place.label : '';
  if (place && !place.here) rememberPlace(place);
  plan();
}

function wirePlace(end) {
  const input = $(fields[end].input);
  const field = placeField(fields[end].input, {
    current: () => trip[end]?.label || '',
    onPlace: place => setPlace(end, place),
    onHere: () => {
      input.value = 'Finding location…';
      myLocation(place => setPlace(end, place), text => { input.value = trip[end]?.label || ''; field.fail(text); });
    },
  });
}

// ---------- asking ----------

function syncURL() {
  const p = new URLSearchParams();
  if (ctx.kmh() !== 15) p.set('kmh', ctx.kmh());
  for (const end of ['a', 'b']) if (trip[end]) { p.set(end, `${trip[end].lat},${trip[end].lon}`); p.set(end + 'n', trip[end].label); }
  if (trip.a || trip.b) { p.set('by', trip.by); p.set('time', trip.time); p.set('days', trip.days); }
  history.replaceState(null, '', '?' + p);
}

const WORKING = `<p class="answer">Checking every recorded day…<span class="skeleton" style="width: 150px; height: 44px; margin: var(--space-2) 0"></span></p>
  <span class="skeleton" style="height: 18px; width: 80%"></span><span class="skeleton" style="height: 46px"></span>`;

async function plan(mark = timeView('plan')) {
  if (!started) return;
  markPlan = mark;
  syncURL();
  store.write('rjt-when', {by: trip.by, time: trip.time, days: trip.days});
  $('plan-title').textContent = trip.by === 'leave' ? 'When will you arrive?' : 'When should you leave?';
  drawStart();
  const box = $('plan-answer'), mine = ++asked;
  if (!trip.a || !trip.b) { answer = bike = null; box.hidden = true; drawMap(); mark('answer'); mark('complete'); return; }
  box.hidden = false;
  if (answer?.plans) box.classList.add('card--busy');
  else { box.innerHTML = WORKING; box.setAttribute('aria-busy', 'true'); }
  const at = end => `${trip[end].lat},${trip[end].lon}`;
  const asking = planTrip(data, trip.a, trip.b, trip.by, seconds(trip.time), trip.days);
  // The bike route does not depend on the time, so it is only asked for when a place changes.
  const key = `${at('a')}|${at('b')}`;
  if (bike?.key !== key) {
    bike = {key, state: 'asking'};
    const mineBike = bike;
    const far = Math.hypot((trip.a.lat - trip.b.lat) * 111320, (trip.a.lon - trip.b.lon) * 68000) > BIKE_LIMIT;
    // The limit is on the route, not the straight line: a route can be over 80 km where the line is not.
    (far ? Promise.resolve({far: true}) : get(`api/bike-route?a=${at('a')}&b=${at('b')}`).then(r => r.metres > BIKE_LIMIT ? {far: true} : r))
      .then(r => Object.assign(mineBike, r, {state: 'done'}))
      .catch(() => Object.assign(mineBike, {state: 'failed'}))
      .then(() => { if (bike === mineBike && answer?.plans) { draw(); drawMap(); } });
  }
  try {
    const result = await asking;
    if (mine !== asked) return;
    answer = result; chosen = 0; open = false;
    const trips = store.read('rjt-trips', []).filter(t => t.a.label !== trip.a.label || t.b.label !== trip.b.label);
    if (!trip.a.here && !trip.b.here) store.write('rjt-trips', [{a: trip.a, b: trip.b}, ...trips].slice(0, 4));
  } catch (error) {
    if (mine !== asked) return;
    answer = {failed: error.message};
  }
  box.classList.remove('card--busy'); box.removeAttribute('aria-busy');
  draw(); mark(answer.failed ? 'error' : 'answer'); drawMap(true);
}

// ---------- the words ----------

const target = () => seconds(trip.time);
const arriving = () => trip.by === 'arrive';
const bikeSeconds = () => bike?.state === 'done' && bike.metres != null ? bike.metres / (ctx.kmh() * 1000 / 3600) : null;

// "Tram 20, Tram 21 or Bus 28"; trains by their kind ("Intercity or Sprinter"), since nobody knows the numbers.
function lineNames(leg) {
  const names = [...new Set(leg.lines.map(l => l.mode === 'train' ? l.short_name.replace(/\s*\d+$/, '') : l.name))];
  const shown = names.slice(0, 3), kind = shown[0].split(' ')[0];
  // "Metro A, B or C" rather than "Metro A, Metro B or Metro C".
  const short = shown.length > 1 && shown.every(n => n.startsWith(kind + ' '))
    ? shown.sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).map((n, i) => i ? n.slice(kind.length + 1) : n) : shown;
  return names.length > 3 ? `${short.join(', ')} or others` : short.length > 1 ? `${short.slice(0, -1).join(', ')} or ${short.at(-1)}` : short[0];
}
const vehicle = leg => ['train', 'metro', 'tram', 'bus'].includes(leg.lines[0]?.mode) ? leg.lines[0].mode : 'one';
const count = (n, word = 'day') => `${n} ${n === 1 ? word : word + 's'}`;

// The one sentence that answers the question. Its figure is the only large type on the screen.
function sentence() {
  const {plans, walk} = answer, best = plans[0], days = DAYS[answer.days];
  if (!best) return walk ? `Walk <b>${duration(walk.seconds)}</b>. Nothing is quicker.` : null;
  if (!arriving() && best.reliable > best.until) return `Leave at ${trip.time} and you usually arrive at <b>${arrival(best.typical, best)}</b>. More than 1 day in 10 arrives after ${clock(best.until)}.`;
  if (!arriving()) return `Leave at ${trip.time} and arrive by <b>${clockUp(best.reliable)}</b> on 9 ${days} in 10.`;
  if (best.unreliable) return `Leave by <b>${clock(best.leave)}</b> to arrive by ${trip.time}. On time ${inTen(best.share, days)} (best recorded).`;
  return `Leave by <b>${clock(best.leave)}</b> to arrive by ${trip.time} on 9 ${days} in 10.`;
}

function steps(p) {
  const out = [], walk = s => s >= 45 ? `Walk ${duration(s)}` : null;
  const first = walk(p.first_walk);
  if (first) out.push(`${first} to ${esc(p.legs[0].from.name)}.`);
  p.legs.forEach((leg, i) => {
    if (i) out.push(`Change at ${esc(leg.from.name)}. You have ${duration(p.changes[i - 1])}.`);
    out.push(`Take <b>${esc(lineNames(leg))}</b> from ${esc(leg.from.name)} to ${esc(leg.to.name)}${i ? '' : `, usually the ${clock(p.departure)}`}.`);
  });
  const last = walk(p.last_walk);
  if (last) out.push(`${last} to ${esc(trip.b.label)}.`);
  // The margin is worked out from the minutes shown, so 08:45 less 08:42 reads 3 min.
  const spare = arriving() && p.typical <= p.until ? Math.round(target() / 60) - Math.ceil(p.typical / 60) : 0;
  const facts = [`You usually arrive ${p.typical > p.until ? '' : 'at '}${arrival(p.typical, p)}${spare > 0 ? `, ${spare} min early: that is the margin for slow days` : ''}.${p.timetable != null ? ` The timetable says ${clockUp(p.timetable)}.` : ''}`];
  if (p.legs.length > 1) {
    const next = vehicle(p.legs.at(-1));
    if (p.gap != null && p.gap < 600) facts.push(`Miss the change and the next ${next} is about ${duration(p.gap)} later.`);
    else facts.push(`You made ${p.legs.length > 2 ? 'both changes' : 'the change'} on ${p.made === p.days ? `all ${p.days} days` : `${p.made} of ${p.days} days`}.${p.gap ? ` Miss it and the next ${next} is ${duration(p.gap)} later.` : ''}`);
  }
  if (p.cancelled) facts.push(`The first ${vehicle(p.legs[0])} was cancelled on ${p.cancelled} of ${p.days} days.`);
  const o = p.left_out, left = [];
  if (o.stranded) left.push(`${count(o.stranded)} with nothing running for 2 hours or more`);
  if (o.unknown) left.push(`${count(o.unknown)} when the ${vehicle(p.legs[0])} was not recorded`);
  if (o.none) left.push(`${count(o.none)} with no departure at this time`);
  if (left.length) facts.push(`Left out: ${left.join(', ')}.`);
  const charts = p.legs.filter(leg => leg.ride).map(leg => `<a href="?view=journeys&route=${encodeURIComponent(leg.ride.key)}&from=${encodeURIComponent(leg.ride.from)}&to=${encodeURIComponent(leg.ride.to)}&days=${answer.days}">${esc(lineNames({lines: [leg.lines[0]]}))} through the day</a>`);
  return `<ol>${out.map(s => `<li>${s}</li>`).join('')}</ol><p class="note">${facts.join(' ')}</p><p class="note">${charts.join(' · ')}</p>`;
}

// One way of making the trip by public transport: its lines, where to board and change, and how long it usually takes.
function optionRow(p, i) {
  const title = p.legs.map(leg => esc(lineNames(leg))).join(', then ');
  // The usual journey, from leaving to arriving (the leave-by time builds in the slack for the bad days).
  const took = Math.min(p.typical, p.until) - (arriving() ? p.leave : target());
  const sub = `From ${esc(p.legs[0].from.name)}. ${p.legs.length > 1 ? `Change at ${p.legs.slice(1).map(l => esc(l.from.name)).join(' and ')}. ` : ''}Usually ${duration(took)}.`;
  const shown = i === chosen && open;
  // The first way is the answer above, so its time is not said again.
  const when = i === 0 ? '' : !arriving() ? (p.reliable > p.until ? `<small>Arrive</small>after ${clock(p.until)}` : `<small>Arrive by</small>${clockUp(p.reliable)}`)
    : p.unreliable ? `<small class="late-text">On time only ${inTen(p.share)}</small>${clock(p.leave)}` : `<small>Leave by</small>${clock(p.leave)}`;
  return `<li data-i="${i}"><button type="button" class="row${i === chosen ? ' row--chosen' : ''}" aria-expanded="${shown}">
      <span><span class="row__title">${title}</span><span class="row__sub">${sub}</span></span>
      ${when ? `<span class="row__value">${when}</span>` : ''}<span class="row__go">${glyph('go')}</span></button>
    <div class="steps"${shown ? '' : ' hidden'}>${steps(p)}</div></li>`;
}

// The bike and the walk: the same every day, so each is one row with the time to leave or arrive.
function sideRows() {
  const t = target(), ride = bikeSeconds(), best = answer.plans[0];
  const at = s => arriving() ? clock(t - s) : clockUp(t + s), word = arriving() ? 'Leave by' : 'Arrive by';
  const pad = answer.plans.length > 1 ? '<span class="row__go"></span>' : '';
  const row = (name, picture, sub, s, wins) => `<li class="row"><span><span class="row__title">${picture}${name}</span><span class="row__sub">${sub}</span></span>
    ${s == null ? '' : `<span class="row__value${wins ? ' row__value--bike' : ''}"><small>${word}</small>${at(s)}</span>${pad}`}</li>`;
  const quicker = ride != null && best && (arriving() ? Math.floor((t - ride) / 60) > Math.floor(best.leave / 60) : Math.ceil((t + ride) / 60) < Math.ceil(best.reliable / 60));
  const why = !bike || bike.state === 'asking' ? 'Finding a cycle route…' : bike.far ? 'Over 80 km, so the bike is not compared.'
    : bike.pending ? 'Bike times are not ready yet. Try again later.' : 'No cycle route found. Ferries are not included.';
  let rows = row('Bike', glyph('bike', 'glyph--bike'), ride != null ? `${duration(ride)}, ${km(bike.metres)} ${atSpeed(ctx.kmh())}` : why, ride, quicker);
  if (answer.walk) rows += row('Walk', glyph('walk'), `${duration(answer.walk.seconds)}, ${km(answer.walk.metres)}`, answer.walk.seconds, false);
  return rows;
}

// Why there is nothing to show, and what to try.
function nothing() {
  const {nearest, tried} = answer, days = DAYS[answer.days];
  if (!nearest.from) return `No stop within 3 km of ${esc(trip.a.label)}. Choose a place nearer a stop or station.`;
  if (!nearest.to) return `No stop within 3 km of ${esc(trip.b.label)}. Choose a place nearer a stop or station.`;
  if (!tried) return `No public transport found around ${trip.time} on ${days}. Try another time, or a nearby station. Ferries are not included.`;
  return arriving() ? `Nothing recorded arrives by ${trip.time} on most ${days}. Try a later time or another day.`
    : `Too few departures recorded around ${trip.time} on ${days}. Try another time or day.`;
}

const notice = text => `<p class="notice">${glyph('warn')}<span>${text}</span></p>`;

function draw() {
  const box = $('plan-answer');
  if (answer.failed) {
    box.innerHTML = `${notice('Unable to load journey times. Check your connection and try again.')}
      <div><button type="button" class="button button--primary" id="plan-retry">Try again</button></div>`;
    return;
  }
  const {plans} = answer, best = plans[0], main = sentence(), days = DAYS[answer.days];
  let html = main ? `<p class="answer">${main}</p>` : notice(nothing());
  if (best) {
    const sources = new Set(plans.flatMap(p => p.legs.flatMap(l => l.lines.map(x => x.mode === 'train' ? 'trains' : 'transit'))));
    const span = [...sources].map(s => answer.coverage[s]).filter(Boolean);
    const from = span.map(c => c.start).sort()[0], to = span.map(c => c.end).sort().at(-1);
    const caption = `${best.dots.length > MANY_DAYS ? `When you would have arrived on each of ${best.days} recorded ${days}. Taller means more days.`
      : `Each dot is one of ${best.days} recorded ${days}, at the time you would have arrived.`}${arriving() ? ' <span class="late-text nowrap">Red is late.</span>' : ' The line marks 9 days in 10.'}`;
    const gap = best.later ? Math.floor(best.later.leave / 60) - Math.floor(best.leave / 60) : 0;
    html += `<ul class="rows">${optionRow(best, 0)}</ul>
      <div class="strip" data-strip="0"></div>
      <p class="note">${caption}</p>
      ${best.later ? `<p class="aside"><span>Leave ${gap} min later, at ${clock(best.later.leave)}, and you are on time <b${best.later.share < 0.9 ? ' class="late"' : ''}>${inTen(best.later.share)}</b>.</span></p>
        <div class="strip" data-strip="later"></div>` : ''}
      <h2 class="label">${arriving() ? `Other ways to arrive by ${trip.time}` : `Other ways, leaving at ${trip.time}`}</h2>
      <ul class="rows">${plans.slice(1).map((p, i) => optionRow(p, i + 1)).join('')}${sideRows()}</ul>
      <p class="note">Recorded on ${best.days} ${days} between ${dateLabel(from)} and ${dateLabel(to)}. Timetables change, so check today's times in 9292 or NS.</p>`;
  } else html += `<ul class="rows">${sideRows()}</ul>`;
  box.innerHTML = `${html}<div><button type="button" class="button" id="plan-share">${glyph('share')}Share</button></div>`;
  drawStrips();
}

// A mark for each recorded day at the time you would have arrived, stacked where days coincide, against a line
// at the time you asked for (or, leaving at a time, at the arrival that 9 days in 10 manage).
function drawStrips() {
  const best = answer?.plans?.[0];
  if (!best) return;
  const sets = {0: best.dots, later: best.later?.dots};
  const all = [...best.dots, ...(best.later?.dots || [])].map(d => d[0]).sort((a, b) => a - b), mark = arriving() ? target() : best.reliable;
  const lo = Math.floor((Math.min(all[0], mark) - 120) / 300) * 300;
  const hi = Math.min(Math.ceil((Math.max(all[Math.floor(all.length * 0.97)], mark) + 240) / 300) * 300, lo + 3 * 3600);
  for (const el of document.querySelectorAll('#plan-answer [data-strip]')) {
    const dots = sets[el.dataset.strip], w = el.clientWidth, h = 46, base = 27, size = 5.5;
    if (!w || !dots) continue;
    const x = s => Math.max(3, Math.min(w - 3, (s - lo) / (hi - lo) * w));
    const columns = new Map();
    for (const d of dots) { const c = Math.round(x(d[0]) / size); if (!columns.has(c)) columns.set(c, []); columns.get(c).push(d); }
    const tallest = Math.max(...[...columns.values()].map(c => c.length));
    const late = d => arriving() && d[0] > mark ? 'late' : '';
    let marks = '';
    if (dots.length > MANY_DAYS) for (const [c, list] of columns) {
      const height = Math.max(4, list.length / tallest * (base - 2));
      marks += `<rect x="${c * size - 2}" y="${base + 3 - height}" width="4" height="${height}" rx="1" class="${late(list[0])}"/>`;
    } else {
      const rise = Math.min(size, (base - 4) / Math.max(1, tallest - 1));
      for (const [c, list] of columns) list.forEach((d, k) => { marks += `<circle cx="${c * size}" cy="${base - k * rise}" r="2.3" class="${late(d)}"/>`; });
    }
    // An edge label gives way when the line is near it.
    const tx = x(mark), near = 70;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="Arrival time on each of ${dots.length} days">
      <line x1="0" x2="${w}" y1="${base + 4.5}" y2="${base + 4.5}" class="axis"/>
      <line x1="${tx}" x2="${tx}" y1="0" y2="${base + 4.5}" class="target"/>
      ${tx > near ? `<text x="0" y="${h - 2}">${clock(lo)}</text>` : ''}${tx < w - near ? `<text x="${w}" y="${h - 2}" class="end">${clock(hi)}</text>` : ''}
      <text x="${Math.max(16, Math.min(w - 16, tx))}" y="${h - 2}" class="target">${clockUp(mark)}</text>${marks}</svg>`;
  }
}

// What to do before a trip is chosen: what the site does, then recent trips or a few to try.
function drawStart() {
  const box = $('plan-start');
  box.hidden = !!(trip.a && trip.b);
  if (box.hidden) { box.innerHTML = ''; return; }
  const recent = store.read('rjt-trips', []), trips = recent.length ? recent : EXAMPLES, transit = coverage?.transit;
  // Nearly every day of a year is a year; fewer days are counted.
  const basis = !transit ? '' : transit.days >= 350 ? ' Based on a year of recorded trains, metros, trams and buses.'
    : ` Based on a year of recorded trains and ${transit.days} days of metros, trams and buses.`;
  box.innerHTML = `<p class="answer answer--start">Find out when to leave to arrive on time 9 days in 10, and whether the bike is quicker.${basis}</p>
    <p class="note note--out">${recent.length ? 'Recent trips' : 'Examples'}</p>
    <ul class="rows rows--card" aria-label="${recent.length ? 'Recent trips' : 'Examples'}">${trips.map((t, i) => `<li><button type="button" class="row" data-trip="${i}">
      <span><span class="row__title">${esc(t.title || `${t.a.label} to ${t.b.label}`)}</span>${t.sub ? `<span class="row__sub">${t.sub}</span>` : ''}</span>
      <span class="row__go">${glyph('go')}</span></button></li>`).join('')}</ul>`;
  box.querySelectorAll('[data-trip]').forEach(b => b.addEventListener('click', () => {
    const t = trips[+b.dataset.trip];
    trip.a = t.a; trip.b = t.b;
    $(fields.a.input).value = t.a.label; $(fields.b.input).value = t.b.label;
    plan();
  }));
}

// ---------- the map ----------

const pin = (place, letter) => L.marker([place.lat, place.lon], {icon: L.divIcon({className: '', html: `<div class="pin">${letter}</div>`, iconSize: [26, 26]}), zIndexOffset: 1000});

// The line a ride follows: the route's shape between the two stops, or straight lines between its stops.
const shapes = new Map();
async function pathOf({key, from, to}) {
  if (!shapes.has(key)) shapes.set(key, get(`api/route?key=${encodeURIComponent(key)}`));
  const r = await shapes.get(key), a = r.stop_ids.indexOf(from), b = r.stop_ids.indexOf(to);
  let best = null;
  r.patterns.forEach((p, index) => {
    const i = p.indexOf(a), j = i < 0 ? -1 : p.indexOf(b, i + 1);
    if (j > 0 && (!best || r.weights[index] > r.weights[best.index])) best = {index, i, j};
  });
  if (!best) return [];
  const at = local => [r.stops[r.stop_ids[local]].lat, r.stops[r.stop_ids[local]].lon];
  const pattern = r.patterns[best.index], shape = r.shapes?.[r.pattern_shape?.[best.index]];
  if (!shape) return pattern.slice(best.i, best.j + 1).map(at).filter(point => point[0] != null);
  const nearest = ([lat, lon], first) => {
    let found = first, d = Infinity;
    for (let k = first; k < shape.length; k++) {
      const e = (shape[k][0] - lat) ** 2 + ((shape[k][1] - lon) * 0.62) ** 2;
      if (e < d) { d = e; found = k; }
    }
    return found;
  };
  const i = nearest(at(a), 0), j = nearest(at(b), i);
  return shape.slice(i, j + 1);
}

let drawing = 0;
async function drawMap(fit = false) {
  if (!window.L || $('plan').hidden) return;
  if (!map) {
    map = ctx.baseMap('plan-map');
    map.setView([52.2, 5.3], 7);
    layer = L.layerGroup().addTo(map);
    map.on('click', event => {
      const at = {lat: +event.latlng.lat.toFixed(5), lon: +event.latlng.lng.toFixed(5)};
      const box = document.createElement('div');
      box.className = 'map-choice';
      box.innerHTML = '<button type="button" class="button" data-end="a">From here</button><button type="button" class="button" data-end="b">To here</button>';
      const popup = L.popup({closeButton: false}).setLatLng(event.latlng).setContent(box).openOn(map);
      box.addEventListener('click', async e => {
        const end = e.target.dataset.end;
        if (!end) return;
        map.closePopup(popup);
        let label = `${at.lat}, ${at.lon}`;
        try { label = await nameOf(data, at) || label; } catch { /* keep the coordinates */ }
        setPlace(end, {...at, label});
      });
    });
  }
  map.invalidateSize();
  const p = answer?.plans?.[chosen], mine = ++drawing;
  // Straight lines between the stops first, then the real route when it has loaded.
  if (p) for (const leg of p.legs) leg.path ||= [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
  const waiting = p ? p.legs.filter(leg => !leg.shaped && leg.ride) : [];
  if (waiting.length) {
    Promise.all(waiting.map(async leg => {
      const path = await pathOf(leg.ride).catch(() => []);
      if (path.length > 1) leg.path = path;
      leg.shaped = true;
    })).then(() => { if (mine === drawing) drawMap(fit); });
  }
  layer.clearLayers();
  const bounds = [], cycle = trip.a && trip.b && bike?.path?.length ? bike.path : null;
  if (cycle) L.polyline(cycle, {className: 'route-bike'}).addTo(layer);
  if (p && trip.a && trip.b) {
    const walk = (from, to) => L.polyline([from, to], {className: 'route-walk'}).addTo(layer);
    let at = [trip.a.lat, trip.a.lon];
    for (const leg of p.legs) { walk(at, leg.path[0]); at = leg.path.at(-1); }
    walk(at, [trip.b.lat, trip.b.lon]);
    for (const leg of p.legs) { L.polyline(leg.path, {className: 'route-casing'}).addTo(layer); L.polyline(leg.path, {className: 'route'}).addTo(layer); }
    for (const leg of p.legs) {
      for (const [stop, point] of [[leg.from, leg.path[0]], [leg.to, leg.path.at(-1)]]) {
        L.marker(point, {icon: L.divIcon({className: '', html: '<div class="stop"></div>', iconSize: [11, 11]})}).addTo(layer).bindTooltip(esc(stop.name), {direction: 'top'});
      }
      bounds.push(...leg.path);
    }
  } else if (cycle) bounds.push(...cycle);
  if (trip.a) { pin(trip.a, 'A').addTo(layer); bounds.push([trip.a.lat, trip.a.lon]); }
  if (trip.b) { pin(trip.b, 'B').addTo(layer); bounds.push([trip.b.lat, trip.b.lon]); }
  if (fit && bounds.length > 1) map.fitBounds(bounds, {padding: [34, 34], maxZoom: 16});
  else if (fit && bounds.length === 1) map.setView(bounds[0], 14);
  const key = $('plan-map-key');
  key.innerHTML = `${p ? '<li><i class="line"></i>Public transport</li><li><i class="line walk"></i>Walk</li>' : ''}${cycle ? '<li><i class="line bike"></i>Bike</li>' : ''}`;
  key.hidden = !key.innerHTML;
  if (answer?.plans && !$('plan-answer').hasAttribute('aria-busy') && !$('plan-answer').classList.contains('card--busy') &&
      !waiting.length && bike?.state !== 'asking') markPlan?.('complete');
}

// ---------- wiring ----------

function share() {
  const text = $('plan-answer').querySelector('.answer')?.textContent.replace(/\s+/g, ' ').trim() || '';
  const title = `${trip.a.label} to ${trip.b.label}`, button = $('plan-share');
  if (navigator.share) navigator.share({title, text: `${title}. ${text}`, url: location.href}).catch(() => {});
  else navigator.clipboard?.writeText(`${title}. ${text} ${location.href}`).then(() => { button.lastChild.textContent = 'Link copied'; });
}

function start() {
  started = true;
  const params = new URLSearchParams(location.search), saved = store.read('rjt-when', {});
  const point = end => {
    const p = (params.get(end) || '').split(',').map(Number);
    return p.length === 2 && p.every(Number.isFinite) ? {lat: p[0], lon: p[1], label: params.get(end + 'n') || `${p[0]}, ${p[1]}`} : null;
  };
  trip.a = point('a'); trip.b = point('b');
  trip.by = ['arrive', 'leave'].includes(params.get('by')) ? params.get('by') : saved.by || 'arrive';
  trip.time = /^\d\d:\d\d$/.test(params.get('time') || '') ? params.get('time') : saved.time || '09:00';
  trip.days = DAYS[params.get('days')] ? params.get('days') : saved.days || 'weekdays';
  for (const end of ['a', 'b']) { wirePlace(end); $(fields[end].input).value = trip[end]?.label || ''; }
  const setBy = () => document.querySelectorAll('[data-by]').forEach(b => b.setAttribute('aria-pressed', b.dataset.by === trip.by));
  setBy(); $('plan-time').value = trip.time; $('plan-days').value = trip.days;
  document.querySelectorAll('[data-by]').forEach(b => b.addEventListener('click', () => { trip.by = b.dataset.by; setBy(); plan(); }));
  $('plan-time').addEventListener('change', () => { if ($('plan-time').value) { trip.time = $('plan-time').value; plan(); } });
  $('plan-days').addEventListener('change', () => { trip.days = $('plan-days').value; plan(); });
  $('plan-swap').addEventListener('click', () => {
    [trip.a, trip.b] = [trip.b, trip.a];
    for (const end of ['a', 'b']) $(fields[end].input).value = trip[end]?.label || '';
    plan();
  });
  $('plan-form').addEventListener('submit', event => event.preventDefault());
  $('plan-answer').addEventListener('click', event => {
    if (event.target.closest('#plan-share')) return share();
    if (event.target.closest('#plan-retry')) return plan();
    const row = event.target.closest('li[data-i]');
    if (!row || !event.target.closest('button.row')) return;
    const i = +row.dataset.i, moved = i !== chosen;
    open = moved || !open; chosen = i;
    draw(); drawMap(moved);
  });
  new ResizeObserver(() => { if (answer?.plans && !$('plan').hidden) drawStrips(); }).observe($('plan-answer'));
  data.meta().then(meta => { coverage = meta.coverage; drawStart(); }).catch(() => {});
}

// Called whenever the view is shown, and when the bike speed changes.
export function showPlan(context, mark = timeView('plan')) {
  ctx = context;
  if (!started) { start(); plan(mark); return; }
  markPlan = mark;
  syncURL();
  if (answer && trip.a && trip.b) draw();
  if (!$('plan-answer').classList.contains('card--busy') && !$('plan-answer').hasAttribute('aria-busy')) {
    mark(answer?.failed ? 'error' : 'answer');
    if (!answer) mark('complete');
  }
  drawMap();
}
