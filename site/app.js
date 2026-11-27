// The page: its five views, and everything on Lines, How far, History and Bike. Plan is in plan.js.
import {ride, lines, bikeMinutes, percentile, DAY_START} from './stats.js';
import {showPlan, placeField, myLocation, nameOfPoint, rememberPlace} from './plan.js';
import {$, esc, pad, clock, duration, thousands, dateLabel, glyph, fillGlyphs, atSpeed, replaceOnType, token, DAYS, SPEEDS} from './ui.js';
import {timeView} from './view-timing.js';
import {diagnose, diagnostics} from './diagnostics.js';

const DEFAULT = {route: 'GVB-2', from: 'NL:Q:30005011', to: 'NL:Q:30006054'};   // Amsterdam tram 2, Centraal Station to Rijksmuseum
const REACH_START = {point: [52.08889, 5.11028], name: 'Utrecht Centraal'};
const VIEWS = ['plan', 'journeys', 'reach', 'history', 'bike'];
const BIKE_PAGE = 10;   // trips on the Bike list before Show more
const params = new URLSearchParams(location.search);
const startAt = (params.get('at') || '').split(',').map(Number);
const state = {index: [], route: null, from: null, to: null, days: 'weekdays', start: '', end: '',
               // Links from before the planner have a route and no view: they are charts.
               view: VIEWS.includes(params.get('view')) ? params.get('view') : params.get('route') ? 'journeys' : 'plan',
               kmh: SPEEDS.includes(+params.get('kmh')) ? +params.get('kmh') : 15,
               result: null, mapStart: null, bikeShown: BIKE_PAGE,
               reach: {...(startAt.length === 2 && startAt.every(Number.isFinite) ? {point: startAt, name: params.get('atn') || ''} : REACH_START),
                       hour: +(params.get('hour') ?? 8), minutes: [30, 45, 60].includes(+params.get('minutes')) ? +params.get('minutes') : 30}};
const cache = new Map();
let map, mapLayer, reachMap, reachLayer, drawn = [], bikeOnChart = false;
let catalog;

const mins = m => duration(m * 60);
const stopName = id => state.route?.stops[id]?.name || id;
const metaOf = key => state.index.find(r => r.key === key);
// A train is named by its kind (Sprinter), since nobody knows the series numbers; the rest by their own name (Tram 8).
const lineName = r => r.mode === 'train' ? r.short_name.replace(/\s*\d+$/, '') : r.name;
const vehicleOf = r => ['train', 'metro', 'tram', 'bus'].includes(r.mode) ? r.mode : 'one';
const notice = text => `<p class="notice">${glyph('warn')}<span>${text}</span></p>`;
const retry = id => `<div><button type="button" class="button button--primary" id="${id}">Try again</button></div>`;
const FAILED = 'Unable to load journey times. Check your connection and try again.';
const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];

// One retry: a large file can fail once while the server prepares its compressed copy.
const load = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
async function json(url) {
  if (!cache.has(url)) {
    const p = load(url).catch(() => load(url));
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

// ---------- line and stop choice ----------

function byWeight(route) {
  return route.patterns.map((stops, index) => ({index, stops: stops.map(s => route.stop_ids[s]), weight: route.weights[index]}))
    .sort((a, b) => b.weight - a.weight);
}

function origins(route) {
  const seen = new Map();
  for (const p of byWeight(route)) p.stops.slice(0, -1).forEach(s => { if (!seen.has(s)) seen.set(s, p.stops.at(-1)); });
  return seen;
}

function destinations(route, from) {
  const seen = new Map();
  for (const p of byWeight(route)) {
    const i = p.stops.indexOf(from);
    if (i >= 0) p.stops.slice(i + 1).forEach(s => { if (!seen.has(s)) seen.set(s, p.stops.at(-1)); });
  }
  return seen;
}

function fillSelect(select, stops, value) {
  const names = new Map();
  for (const id of stops.keys()) names.set(stopName(id), (names.get(stopName(id)) || 0) + 1);
  select.replaceChildren(...[...stops].map(([id, end]) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = names.get(stopName(id)) > 1 ? `${stopName(id)} (towards ${stopName(end)})` : stopName(id);
    return option;
  }));
  select.value = value;
}

function setStops(from, to) {
  const route = state.route;
  const starts = origins(route);
  const runsOnFrom = p => { const i = p.stops.indexOf(from); return i >= 0 && i < p.stops.length - 1; };
  const main = byWeight(route).find(runsOnFrom) || byWeight(route)[0];
  state.from = starts.has(from) ? from : main.stops[0];
  const ends = destinations(route, state.from);
  state.to = ends.has(to) ? to : main.stops.at(-1);
  fillSelect($('from-stop'), starts, state.from);
  fillSelect($('to-stop'), ends, state.to);
}

const WORKING = '<p class="answer answer--plain">Loading…</p><span class="skeleton" style="width: 150px; height: 44px"></span><span class="skeleton" style="height: 18px; width: 80%"></span>';

async function loadRoute(key, from, to, mark = timeView(state.view), details) {
  const meta = metaOf(key) || state.index[0];
  const view = state.view, attempt = state.routeAttempt = (state.routeAttempt || 0) + 1;
  state.version = (state.version || 0) + 1;
  if (!state.result) for (const id of ['lines-answer', 'history-answer']) $(id).innerHTML = WORKING;
  let route;
  // The server sends the route without its journeys (a year of a busy line is tens of megabytes).
  const routeLoading = details || json(`api/route?key=${encodeURIComponent(meta.key)}`);
  if (view === 'history') historyData(meta).catch(() => {});
  if (view === 'journeys' && !state.start && !state.end && meta.stop_ids.includes(from) && meta.stop_ids.includes(to) && from !== to) {
    json(journeyURL(meta.key, from, to, state.days)).catch(() => {});
  }
  try { route = await routeLoading; } catch {
    if (attempt === state.routeAttempt && view === state.view) {
      failLines(() => loadRoute(key, from, to));
      mark('error');
    }
    return;
  }
  if (attempt !== state.routeAttempt || view !== state.view) return;
  state.route = route;
  state.result = null;
  state.mapStart = null;
  $('route-search').value = lineName(meta);
  const first = route.first, last = route.last;
  for (const id of ['start-date', 'end-date']) { $(id).min = first; $(id).max = last; }
  state.start = state.start && state.start >= first && state.start <= last ? state.start : first;
  state.end = state.end && state.end >= state.start && state.end <= last ? state.end : last;
  $('start-date').value = state.start; $('end-date').value = state.end;
  setStops(from, to);
  return refresh(true, mark);
}

function reverse() {
  const route = state.route, from = route.stops[state.from], to = route.stops[state.to];
  const near = (id, target) => {
    const s = route.stops[id];
    return s.name === target.name ? 0 : s.lat == null ? Infinity : Math.hypot((s.lat - target.lat) * 111, (s.lon - target.lon) * 69);
  };
  let best = null;
  for (const [a] of origins(route)) {
    const da = near(a, to);
    if (da > 0.5) continue;
    for (const [b] of destinations(route, a)) {
      const score = da + near(b, from);
      if (near(b, from) <= 0.5 && (!best || score < best.score)) best = {a, b, score};
    }
  }
  if (!best) { $('route-error').innerHTML = `${glyph('warn')}No journeys run the other way between these stops.`; $('route-error').hidden = false; return; }
  setStops(best.a, best.b);
  refresh(true);
}

// ---------- line search ----------

const searchBox = () => $('route-search');
let untouchedSearch;
function searchRoutes() {
  const words = searchBox().value.toLowerCase().split(/\s+/).filter(Boolean), whole = words.join(' ');
  const matches = state.index.filter(r => {
    const text = `${r.short_name} ${r.name} ${r.detail} ${r.mode} ${r.operator}`.toLowerCase();
    return words.every(w => text.includes(w)) || words.length === 1 && r.short_name.toLowerCase() === words[0];
  });
  // The line whose name is what was typed comes first, then the busiest.
  const rank = r => { const name = lineName(r).toLowerCase(); return name === whole ? 2 : name.startsWith(whole) ? 1 : 0; };
  matches.sort((a, b) => rank(b) - rank(a) || b.journeys - a.journeys);
  const box = $('route-results');
  box.innerHTML = matches.slice(0, 80).map(r => `<div class="suggest__row" role="option" data-key="${esc(r.key)}">${glyph(vehicleOf(r) === 'one' ? 'bus' : r.mode === 'metro' ? 'metro' : r.mode)}
    <span>${esc(lineName(r))}<small>${esc(r.operator)} · ${esc(r.detail.replaceAll(' – ', ' to ').replaceAll(' / ', ', '))}</small></span></div>`).join('')
    || '<p class="suggest__none">No lines found. Try a number or a place.</p>';
  box.hidden = false; searchBox().setAttribute('aria-expanded', 'true');
}

function wireSearch() {
  const input = searchBox(), box = $('route-results');
  untouchedSearch = replaceOnType(input);
  const pick = row => { if (!row) return; box.hidden = true; input.blur(); loadRoute(row.dataset.key); };
  input.addEventListener('focus', searchRoutes);
  input.addEventListener('input', searchRoutes);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); pick(box.querySelector('[data-key]')); }
    else if (event.key === 'Escape') input.blur();
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement === input) return;
    box.hidden = true; input.setAttribute('aria-expanded', 'false');
    if (state.route) input.value = lineName(metaOf(state.route.key));
  }, 180));
  box.addEventListener('pointerdown', event => { const row = event.target.closest('[data-key]'); if (row) { event.preventDefault(); pick(row); } });
  const clear = input.closest('.field').querySelector('.field__clear');
  clear.addEventListener('mousedown', event => event.preventDefault());
  clear.addEventListener('click', () => { input.value = ''; input.focus(); untouchedSearch.touch(); searchRoutes(); });
}

// ---------- Lines: how long it really takes ----------

let again = () => {};
function failLines(tryAgain) {
  again = tryAgain;
  state.result = null;
  for (const id of ['lines-answer', 'history-answer']) $(id).innerHTML = `${notice(FAILED)}${retry('lines-retry')}`;
  $('chart-card').hidden = true; $('history-stage').hidden = true;
}

function journeyURL(route, from, to, days, start, end) {
  const q = new URLSearchParams({route, from, to, days});
  if (start) q.set('start', start);
  if (end) q.set('end', end);
  return `api/journeys?${q}`;
}

function cyclePath(route, from, to) {
  const a = route.stops[from], b = route.stops[to];
  if (a?.lat == null || b?.lat == null) return Promise.resolve(null);
  return json(`api/bike-route?a=${a.lat},${a.lon}&b=${b.lat},${b.lon}`).catch(() => null);
}

async function refresh(fitMap = false, mark = timeView(state.view)) {
  const {route, from, to, days, start, end} = state;
  if (state.view === 'history') { syncURL(); return showHistory(mark); }
  const version = state.version = (state.version || 0) + 1;
  let answer;
  $('route-error').hidden = true;
  $('lines-answer').classList.add('card--busy');
  $('date-summary').textContent = `${dateLabel(start)} to ${dateLabel(end)}`;
  $('days').value = days;
  const bike = cyclePath(route, from, to);
  try {
    answer = await json(journeyURL(route.key, from, to, days, start === route.first ? '' : start, end === route.last ? '' : end));
  } catch (error) {
    if (version === state.version) { $('lines-answer').classList.remove('card--busy'); failLines(() => refresh(fitMap)); mark('error'); }
    return;
  }
  if (version !== state.version) return;
  $('lines-answer').classList.remove('card--busy');
  const records = answer.records.map(r => Object.fromEntries(answer.fields.map((f, i) => [f, r[i]])));
  for (const r of records) { r.cancelled = !!r.cancelled; r.own = !!r.own; }
  // An hour with a journey on fewer than a fifth of the days (a late train that runs now and then) gets no line:
  // a handful of journeys and their long waits would draw a spike.
  const dayCount = new Set(records.map(r => r.date)).size;
  state.result = {records, line: lines(records, Math.max(3, Math.round(dayCount / 5))), cancelled: answer.cancelled, stranded: answer.stranded};
  if (state.view === 'journeys') showLines(fitMap, mark, bike);
  syncURL();
}

function showLines(fitMap, mark, bike) {
  const {records, cancelled, stranded} = state.result, route = state.route, meta = metaOf(route.key), days = DAYS[state.days];
  const box = $('lines-answer');
  $('chart-card').hidden = !records.length;
  if (!records.length) box.innerHTML = notice(`No journeys recorded between these stops on ${days}. Try other days or stops.`);
  else {
    const allow = Math.ceil(percentile(records.map(r => r.real), 0.9) - 1e-9), timetable = Math.round(percentile(records.map(r => r.timetable), 0.5));
    const nDays = new Set(records.map(r => r.date)).size, vehicle = vehicleOf(meta);
    const metres = route.bike_metres?.[route.stop_ids.indexOf(state.from)]?.[route.stop_ids.indexOf(state.to)];
    const bike = metres != null ? `By bike: ${mins(metres / (state.kmh * 1000 / 60))}, ${(metres / 1000).toFixed(1)} km ${atSpeed(state.kmh)}`
      : !state.bikeReady ? 'Bike times are not ready yet.' : 'No bike time: over 80 km, or no cycle route found.';
    box.innerHTML = `<p class="answer">Allow <b>${mins(allow)}</b> to be on time on 9 ${days} in 10. The timetable says ${mins(timetable)}.</p>
      <p class="aside">${glyph('bike')}<span>${bike}</span></p>
      <p class="note">From ${thousands(records.length)} ${records.length === 1 ? 'journey' : 'journeys'} on ${nDays} ${nDays === 1 ? days.replace(/s$/, '') : days}.
        ${cancelled ? `Cancelled journeys (${thousands(cancelled)}) are timed to the next ${vehicle}.` : ''}
        ${stranded ? `${thousands(stranded)} ${stranded === 1 ? 'journey' : 'journeys'} during disruptions of 2 hours or more ${stranded === 1 ? 'is' : 'are'} left out.` : ''}</p>`;
    drawChart();
  }
  map?.invalidateSize();
  mark?.('answer');
  drawMap(fitMap, MAP_NOTE, bike).then(() => mark?.('complete'));
}

function syncURL() {
  if (state.view === 'plan') return;   // the planner keeps its own address (plan.js)
  const p = new URLSearchParams();
  p.set('view', state.view);
  if (state.kmh !== 15) p.set('kmh', state.kmh);
  if (state.view === 'reach') {
    p.set('at', state.reach.point.map(v => v.toFixed(5)).join(',')); if (state.reach.name) p.set('atn', state.reach.name);
    p.set('hour', state.reach.hour); p.set('minutes', state.reach.minutes);
  } else if (state.route && state.view !== 'bike') {
    p.set('route', state.route.key); p.set('from', state.from); p.set('to', state.to);
    if (state.view === 'journeys') { p.set('days', state.days); p.set('start', state.start); p.set('end', state.end); }
  }
  history.replaceState(null, '', '?' + p);
}

// ---------- charts ----------

// A canvas the size of its box, with the type for chart ticks. Colours and type come from the tokens.
const fontOf = name => { const probe = document.createElement('span'); probe.style.font = `var(${name})`; document.body.append(probe);
  const cs = getComputedStyle(probe), font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; probe.remove(); return font; };
function canvasOf(areaId, canvasId) {
  const area = $(areaId), canvas = $(canvasId), w = area.clientWidth, h = area.clientHeight, dpr = devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h); ctx.font = fontOf('--text-micro');
  return {ctx, w, h};
}

// A step that gives a handful of lines between two numbers of minutes.
const stepFor = span => [1, 2, 5, 10, 15, 30, 60, 120].find(s => span / s <= 6) || 240;
// A time of day on the chart's own day, which runs from 03:00 to 03:00.
const onDay = s => ((s - DAY_START) % 86400 + 86400) % 86400 + DAY_START;

// Shared axes: no frame, hairline grid, minutes up the side with the unit on the top one, hours along the bottom.
function axes(ctx, w, h, x0, x1, y0, y1, step) {
  const left = 46, right = 14, top = 12, bottom = 22, pw = w - left - right, ph = h - top - bottom;
  const x = s => left + (s - x0) / (x1 - x0) * pw, y = v => top + ph - (v - y0) / (y1 - y0) * ph;
  ctx.lineWidth = 1; ctx.strokeStyle = token('--separator'); ctx.fillStyle = token('--text-2'); ctx.textBaseline = 'middle';
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
    ctx.beginPath(); ctx.moveTo(left, Math.round(y(v)) + 0.5); ctx.lineTo(left + pw, Math.round(y(v)) + 0.5); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(v + (v + step > y1 ? ' min' : ''), left - 6, y(v));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const hours = (x1 - x0) / 3600, every = [1, 2, 3, 4, 6].find(e => hours / e * 46 <= pw) || 6;
  for (let hr = Math.ceil(x0 / 3600 / every) * every; hr * 3600 <= x1; hr += every) if (x(hr * 3600) < w - 16) ctx.fillText(`${pad(hr % 24)}:00`, x(hr * 3600), h - 5);
  return {x, y, left, top, pw, ph};
}

// The scale fits an ordinary day: from 0.7 to 1.5 times the usual timetable time. Longer journeys sit on the top edge.
function drawChart() {
  const result = state.result;
  drawn = [];
  if (!result?.records.length || $('chart-card').hidden) return;
  const {ctx, w, h} = canvasOf('chart-area', 'chart'), {records, line} = result;
  const bike = bikeMinutes(state.route, state.from, state.to, state.kmh);
  const at = records.map(r => onDay(r.arrival));
  const from = Math.floor(Math.min(...at) / 3600) * 3600, to = Math.max(Math.ceil(Math.max(...at) / 3600) * 3600, from + 3600);
  const usual = percentile(records.map(r => r.timetable), 0.5);
  const step = usual > 80 ? 30 : usual > 40 ? 10 : usual > 12 ? 5 : usual > 4 ? 2 : 1;
  const ymin = Math.floor(usual * 0.7 / step) * step, ymax = Math.max(Math.ceil(usual * 1.5 / step) * step, ymin + 2 * step);
  const {x, y, left, top, pw, ph} = axes(ctx, w, h, from, to, ymin, ymax, step);
  ctx.save(); ctx.beginPath(); ctx.rect(left, top - 4, pw, ph + 4); ctx.clip();
  ctx.fillStyle = token('--pt-wash');
  const r = w < 500 ? 1.3 : 1.7;
  records.forEach((rec, i) => {
    const px = x(at[i]), py = y(Math.max(ymin, Math.min(rec.real, ymax)));
    drawn.push({px, py, rec});
    ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
  });
  for (const [field, colour, width, dash] of [['timetable', '--timetable', 1.5, [4, 3]], ['p90', '--pt', 2.5, []]]) {
    ctx.strokeStyle = token(colour); ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = 'round'; ctx.beginPath();
    let pen = false;
    for (const p of line) {
      if (p[field] == null) { pen = false; continue; }
      const py = y(Math.max(ymin, Math.min(p[field], ymax)));
      pen ? ctx.lineTo(x(p.at), py) : ctx.moveTo(x(p.at), py); pen = true;
    }
    ctx.stroke();
  }
  // The bike's line is drawn only when it fits the scale; otherwise the sentence beside the chart says it.
  const bikeFits = bikeOnChart = bike != null && bike <= ymax && bike >= ymin;
  if (bikeFits) { ctx.setLineDash([]); ctx.strokeStyle = token('--bike'); ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(left, y(bike)); ctx.lineTo(left + pw, y(bike)); ctx.stroke(); }
  ctx.restore();
  $('chart-key').innerHTML = `<li><i class="line"></i>Allow: on time 9 days in 10</li><li><i class="line timetable"></i>Timetable</li><li><i class="dots"></i>One journey</li>
    ${bikeFits ? `<li><i class="line bike-time"></i>Bike at ${state.kmh} km/h</li>` : ''}`;
  $('chart-note').textContent = `Minutes from the timetabled departure to arrival, through the day. Where the solid line reaches the top, allow more than ${ymax} min.`;
}

function showTooltip(event) {
  const rect = $('chart').getBoundingClientRect(), mx = event.clientX - rect.left, my = event.clientY - rect.top;
  let best = null, bestD = event.pointerType === 'touch' ? 400 : 100;
  for (const p of drawn) { const d = (p.px - mx) ** 2 + (p.py - my) ** 2; if (d < bestD) { bestD = d; best = p; } }
  const tip = $('tooltip');
  tip.hidden = !best;
  if (!best) return;
  const rec = best.rec, vehicle = vehicleOf(metaOf(state.route.key)), time = s => s == null || s < 0 ? '–' : clock(s);
  const what = rec.cancelled ? `Cancelled, so timed to the next ${vehicle}.` : !rec.own ? `Another ${vehicle} got there first, so timed to that one.` : '';
  tip.innerHTML = `${new Date(rec.date + 'T12:00:00Z').toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'})}<br>
    Took ${Math.round(rec.real)} min. Timetable: ${Math.round(rec.timetable)} min.<br>
    Due ${time(rec.sd)} to ${time(rec.sa)}. Arrived ${time(rec.arrival)}.${what ? '<br>' + what : ''}`;
  const area = $('chart-area');
  tip.style.left = Math.max(4, Math.min(best.px + 12, area.clientWidth - tip.offsetWidth - 4)) + 'px';
  tip.style.top = Math.max(4, best.py - tip.offsetHeight - 10) + 'px';
}

// A PNG of the chart with its title and sources, for sharing.
function saveChart() {
  const chart = $('chart'), dpr = devicePixelRatio || 1, edge = 28, w = chart.width / dpr, h = chart.height / dpr;
  const out = document.createElement('canvas');
  out.width = (w + 2 * edge) * dpr; out.height = (h + 120) * dpr;
  const ctx = out.getContext('2d'), meta = metaOf(state.route.key);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = token('--surface'); ctx.fillRect(0, 0, w + 2 * edge, h + 120);
  ctx.fillStyle = token('--text'); ctx.font = fontOf('--text-title');
  ctx.fillText(`${lineName(meta)}, ${stopName(state.from)} to ${stopName(state.to)}, ${DAYS[state.days]}`, edge, 38);
  ctx.fillStyle = token('--text-2'); ctx.font = fontOf('--text-caption');
  ctx.fillText(`Solid blue: allow to be on time 9 days in 10. Dashed: timetable.${bikeOnChart ? ` Green: bike at ${state.kmh} km/h.` : ''} ${$('date-summary').textContent}.`, edge, 62);
  ctx.drawImage(chart, edge, 76, w, h);
  ctx.fillText('realjourneytime.jjpcodes.com · Data: Rijden de Treinen, Adriaan van Natijne, CBS, OpenStreetMap', edge, h + 104);
  out.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `real-journey-time-${state.route.key}-${stopName(state.from)}-${stopName(state.to)}.png`.replace(/[^\w.-]+/g, '-');
    a.click();
  });
}

// ---------- maps ----------

// Grey tiles, so the routes carry the colour. Lines on a map get a class and their colour from style.css.
function baseMap(id) {
  const m = L.map(id, {scrollWheelZoom: false, zoomControl: innerWidth >= 900}).setView([52.2, 5.3], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19, className: 'tiles'}).addTo(m);
  m.attributionControl.setPrefix(false);
  m.zoomControl?.setPosition('topright');
  for (const name of ['dragstart', 'dragend', 'zoomstart', 'zoomend', 'click']) {
    m.on(name, () => diagnose('map-' + name, id, m.getZoom()));
  }
  return m;
}

// The line a pattern follows: its shape if it has one, otherwise straight lines between stops.
function patternLine(route, p) {
  const shape = route.pattern_shape?.[p.index];
  if (shape != null) return route.shapes[shape];
  return p.stops.filter(id => route.stops[id]?.lat != null).map(id => [route.stops[id].lat, route.stops[id].lon]);
}

function nearestVertex(line, [lat, lon], from = 0) {
  let best = from, bestD = Infinity;
  for (let i = from; i < line.length; i++) {
    const d = (line[i][0] - lat) ** 2 + ((line[i][1] - lon) * 0.62) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const MAP_NOTE = 'Choose a stop on the map for From, then another for To.';
async function drawMap(fit, note = MAP_NOTE, bikePath) {
  if (!window.L || !state.route || state.view !== 'journeys') return;
  if (!map) { map = baseMap('map'); mapLayer = L.layerGroup().addTo(map); fit = true; }
  mapLayer.clearLayers();
  const route = state.route, ll = id => [route.stops[id].lat, route.stops[id].lon];
  const located = id => route.stops[id]?.lat != null;
  const pattern = byWeight(route).find(p => ride(p.stops, state.from, state.to));
  for (const p of byWeight(route)) L.polyline(patternLine(route, p), {className: 'route-other'}).addTo(mapLayer);
  let section = [];
  if (pattern && located(state.from) && located(state.to)) {
    const line = patternLine(route, pattern);
    const i = nearestVertex(line, ll(state.from)), j = nearestVertex(line, ll(state.to), i + 1);
    section = line.slice(i, j + 1);
    L.polyline(section, {className: 'route-casing'}).addTo(mapLayer); L.polyline(section, {className: 'route'}).addTo(mapLayer);
  }
  const start = state.mapStart || state.from;
  for (const id of route.stop_ids.filter(located)) {
    const isFrom = id === start, isTo = !state.mapStart && id === state.to, end = isFrom || isTo;
    const icon = L.divIcon({className: '', html: end ? `<div class="pin">${isFrom ? 'A' : 'B'}</div>` : '<div class="stop stop--plain"></div>', iconSize: end ? [26, 26] : [9, 9]});
    L.marker(ll(id), {icon, title: stopName(id), zIndexOffset: end ? 1000 : 0}).addTo(mapLayer)
      .bindTooltip(esc(stopName(id)), {direction: 'top'}).on('click', () => chooseOnMap(id));
  }
  if (fit && section.length > 1) map.fitBounds(section, {padding: [28, 28]});
  const key = $('map-key'), name = `<li><i class="line"></i>${esc(lineName(metaOf(route.key)))}</li>`;
  key.innerHTML = name; key.hidden = false;
  $('map-note').textContent = note;
  if (state.mapStart || !located(state.from) || !located(state.to)) return;
  const asked = `${route.key}|${state.from}|${state.to}`;
  try {
    const bike = await (bikePath || cyclePath(route, state.from, state.to));
    if (asked !== `${state.route.key}|${state.from}|${state.to}` || !bike?.path?.length) return;
    L.polyline(bike.path, {className: 'route-bike'}).addTo(mapLayer);
    key.innerHTML = `${name}<li><i class="line bike"></i>Bike</li>`;
  } catch { /* the page works without the bike route */ }
}

function chooseOnMap(id) {
  if (!state.mapStart) { state.mapStart = id; drawMap(false, `From ${stopName(id)}. Now choose where to end.`); return; }
  const from = state.mapStart;
  state.mapStart = null;
  if (!destinations(state.route, from).has(id)) {
    drawMap(false, `${lineName(metaOf(state.route.key))} does not run from ${stopName(from)} to ${stopName(id)}. Choose another stop.`);
    return;
  }
  setStops(from, id);
  refresh(false);
}

// ---------- How far ----------

let reachField, reachAreas = {}, reachFit = true;

function setReach(point, name, source = 'link') {
  diagnose('reach-origin', source);
  state.reach.point = point; state.reach.name = name;
  $('reach-from').value = name;
  reachFit = true;
  showReach();
}

// The reach areas arrive as pictures; they are painted in the token colours here, so they follow light and dark.
async function tinted(url, colour) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = colour; ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL();
}

function showAreas() {
  for (const [kind, box] of [['transit', 'show-transit'], ['bike', 'show-bike']]) {
    const area = reachAreas[kind];
    if (area) $(box).checked ? area.addTo(reachLayer) : area.remove();
  }
}

async function showReach(mark = timeView('reach')) {
  if (!reachMap) {
    reachMap = baseMap('reach-map');
    reachLayer = L.layerGroup().addTo(reachMap);
    reachMap.on('click', async e => {
      const at = {lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5)};
      let name = '';
      try { name = await nameOfPoint(at) || ''; } catch { /* a point without a name */ }
      setReach([at.lat, at.lon], name, 'map');
    });
    reachMap.setView(state.reach.point, 11, {animate: false});
    // A link that gives only the point: name it by its nearest stop, as a point chosen on the map is.
    if (!state.reach.name) nameOfPoint({lat: state.reach.point[0], lon: state.reach.point[1]}).then(name => { if (name && !state.reach.name) setReach(state.reach.point, name); }).catch(() => {});
  }
  reachMap.invalidateSize();
  const {point, name, hour, minutes: budget} = state.reach, box = $('reach-answer');
  $('reach-from').value = name;
  if (box.querySelector('.bars')) box.classList.add('card--busy');
  else box.innerHTML = '<p class="answer answer--plain">Working out how far you can get…</p><span class="skeleton" style="height: 44px"></span><span class="skeleton" style="height: 44px; width: 70%"></span>';
  syncURL();
  const version = state.reachVersion = (state.reachVersion || 0) + 1;
  let data;
  try { data = await json(`api/reach?lat=${point[0].toFixed(5)}&lon=${point[1].toFixed(5)}&hour=${hour}&minutes=${budget}&kmh=${state.kmh}`); }
  catch { if (version === state.reachVersion) { box.classList.remove('card--busy'); box.innerHTML = `${notice(FAILED)}${retry('reach-retry')}`; mark('error'); } return; }
  if (version !== state.reachVersion) return;
  const solid = c => c.replace(/\/\s*[\d.]+\)/, '/ 1)');
  const area = async (layer, tokenName) => {
    if (!layer.png) return null;
    const colour = token(tokenName), alpha = +colour.match(/\/\s*([\d.]+)\)/)[1];
    return L.imageOverlay(await tinted(layer.png, solid(colour)), layer.bounds, {opacity: alpha});
  };
  const [bike, transit] = await Promise.all([area(data.bike, '--bike-area'), area(data.transit, '--pt-area')]);
  const areas = {bike, transit};
  if (version !== state.reachVersion) return;
  reachLayer.clearLayers();
  reachAreas = areas;
  showAreas();
  L.marker(point, {icon: L.divIcon({className: '', html: '<div class="pin"></div>', iconSize: [26, 26]}), zIndexOffset: 1000}).addTo(reachLayer);
  // Wide enough for the whole bike area and the towns round it; the rides beyond are a pan away.
  const bounds = (data.bike.png ? data.bike : data.transit).bounds;
  if (reachFit && bounds) {
    const [[s, w], [n, e]] = bounds, dy = (n - s) * 0.6, dx = (e - w) * 0.6;
    reachMap.fitBounds(data.bike.png ? [[s - dy, w - dx], [n + dy, e + dx]] : bounds, {animate: false});
    reachFit = false;
  }
  const most = Math.max(data.transit.people, data.bike.pending ? 0 : data.bike.people, 1);
  const row = (kind, people, label) => `<div class="bar-row bar-row--${kind}"><span class="bar-row__name">${label}</span>
    <span class="bar-row__value">${people == null ? 'Not ready yet' : thousands(people)}</span>
    <span class="bar-row__track"><i class="bar-row__fill" style="width: ${100 * (people || 0) / most}%"></i></span></div>`;
  box.classList.remove('card--busy');
  box.innerHTML = `<h2 class="heading">People living within ${budget} min of ${name && !/^Near |^My location/.test(name) ? esc(name) : 'this point'}</h2>
    <div class="bars bars--big">${row('pt', data.transit.people, 'By public transport')}${row('bike', data.bike.pending ? null : data.bike.people, `By bike ${atSpeed(state.kmh)}`)}</div>
    <p class="note">Public transport here means a walk to a stop, one ride with no change, then a walk.</p>`;
  mark('answer'); mark('complete');
}

// ---------- History: has it got slower ----------

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameLabel = stop => `${norm(stop?.town)}|${norm(stop?.name)}`;
let historyYears = [];

function historyData(meta) {
  const file = meta.mode !== 'train' ? `${meta.key.split('-')[0]}-${meta.mode}` : meta.key;
  return json(`data/history/${file}.json`);
}

async function showHistory(mark = timeView('history')) {
  const meta = metaOf(state.route.key);
  const version = state.historyVersion = (state.historyVersion || 0) + 1;
  let data;
  try { data = await historyData(meta); } catch { data = null; }
  if (version !== state.historyVersion || state.view !== 'history' || state.route.key !== meta.key) return;
  const years = [];
  if (data) {
    const want = data.match === 'id' ? [state.from, state.to] : [nameLabel(state.route.stops[state.from]), nameLabel(state.route.stops[state.to])];
    for (const year of data.years) {
      const points = [], used = new Set();
      const serving = year.journeys.filter(j => ride(data.patterns[j[0]], want[0], want[1]));
      // Today's line number if it ran that year; otherwise any line of the kind (lines get renumbered).
      const same = serving.filter(j => data.lines[j[0]] === meta.short_name);
      for (const j of (data.match === 'name' && same.length ? same : serving)) {
        const r = ride(data.patterns[j[0]], want[0], want[1]);
        used.add(data.lines[j[0]]);
        const sd = j[2 + 2 * r[0]] ?? j[1 + 2 * r[0]], sa = j[1 + 2 * r[1]] ?? j[2 + 2 * r[1]];
        if (sd != null && sa != null && sa > sd) points.push({at: sa, minutes: (sa - sd) / 60});
      }
      points.sort((a, b) => a.at - b.at);
      const sorted = points.map(p => p.minutes).sort((a, b) => a - b);
      years.push({year: year.date.slice(0, 4), points, usual: sorted.length ? Math.round(sorted[sorted.length >> 1]) : null,
                  lines: [...used].sort((a, b) => a.localeCompare(b, 'en', {numeric: true}))});
    }
  }
  const shown = years.filter(y => y.points.length), missing = years.filter(y => !y.points.length).map(y => y.year), box = $('history-answer');
  historyYears = shown.length > 1 ? [shown[0], shown.at(-1)] : shown;
  $('history-stage').hidden = !shown.length;
  if (!shown.length) { box.innerHTML = notice('No earlier timetables found for these stops. Try a stop nearby.'); mark('answer'); mark('complete'); return; }
  const first = shown[0], last = shown.at(-1), change = last.usual - first.usual;
  const against = shown.length < 2 ? '' : change ? `${mins(Math.abs(change))} ${change > 0 ? 'slower' : 'quicker'} than in ${first.year}.` : `the same as in ${first.year}.`;
  // A line that was renumbered is counted under its old numbers, and the year says which.
  const was = y => meta.mode !== 'train' && data.match === 'name' && y.lines.length && !y.lines.includes(meta.short_name)
    ? `<span class="row__sub">In ${y.year} this was ${meta.mode} ${esc(list(y.lines))}.</span>` : '';
  const gap = !missing.length ? '' : ` No timetable found for ${missing.length > 2 && +missing.at(-1) - +missing[0] === missing.length - 1 ? `${missing[0]} to ${missing.at(-1)}` : list(missing)}.`;
  box.innerHTML = `<p class="answer">In the ${last.year} timetable <b>${mins(last.usual)}</b>${against}</p>
    <ul class="rows years">${[...shown].reverse().map(y => `<li class="row"><span><span class="row__title">${y.year}</span>${was(y)}</span><span class="row__value">${mins(y.usual)}</span></li>`).join('')}</ul>
    <p class="note">The usual time in each year's timetable.${gap}</p>`;
  $('history-key').innerHTML = `<li><i class="year"></i>${last.year}</li>${shown.length > 1 ? `<li><i class="line timetable"></i>${first.year}</li>` : ''}`;
  const note = $('history-renumbered');
  note.hidden = meta.mode === 'train';
  note.textContent = `Lines are sometimes renumbered, so each year counts every ${meta.operator} ${vehicleOf(meta)} between these stops. A stop that was renamed leaves a gap.`;
  drawHistory();
  mark('answer'); mark('complete');
}

// Two years only, the latest solid and the earliest dashed.
function drawHistory() {
  if (!historyYears.length || $('history-stage').hidden) return;
  const {ctx, w, h} = canvasOf('history-area', 'history-chart');
  const all = historyYears.flatMap(y => y.points.map(p => p.minutes)), xs = historyYears.flatMap(y => y.points.map(p => onDay(p.at)));
  const low = Math.min(...all), high = Math.max(...all), step = stepFor(Math.max(high - low, 4) * 1.6);
  const y0 = Math.max(0, Math.floor((low - step * 0.6) / step) * step), y1 = Math.ceil((high + step * 0.4) / step) * step;
  const x0 = Math.floor(Math.min(...xs) / 3600) * 3600, x1 = Math.max(Math.ceil(Math.max(...xs) / 3600) * 3600, x0 + 3600);
  const {x, y} = axes(ctx, w, h, x0, x1, y0, y1, step);
  historyYears.forEach((year, i) => {
    const latest = i === historyYears.length - 1;
    ctx.strokeStyle = token(latest ? '--text' : '--text-2'); ctx.lineWidth = latest ? 2.5 : 1.5; ctx.setLineDash(latest ? [] : [4, 3]); ctx.lineJoin = 'round'; ctx.beginPath();
    [...year.points].sort((a, b) => onDay(a.at) - onDay(b.at)).forEach((p, k) => k ? ctx.lineTo(x(onDay(p.at)), y(p.minutes)) : ctx.moveTo(x(onDay(p.at)), y(p.minutes)));
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

// ---------- Bike: where the bike is quicker ----------

// The counts and rows for one bike speed and kind of transport, worked out from every trip. The hosted site has
// these ready made (data/bike-comparison/, hosting/bike_table.py) so the page need not download all the trips.
async function bikeTable(mode) {
  const data = await json('data/bike-pairs.json');
  const f = Object.fromEntries(data.fields.map((name, i) => [name, i]));
  const table = {total: 0, wins: 0, timetableWins: 0, byMode: {}, fields: data.fields};
  const steady = [], flaky = [];
  for (const row of data.rows) {
    const bike = row[f.km] / state.kmh * 60, wins = bike <= row[f.p90] - 1;
    const counts = table.byMode[row[f.mode]] ||= {total: 0, wins: 0, longTotal: 0, longWins: 0};
    table.total++; table.wins += wins; table.timetableWins += bike <= row[f.timetable] - 1;
    counts.total++; counts.wins += wins;
    if (row[f.km] >= 3) { counts.longTotal++; counts.longWins += wins; }
    // Ranked by the saving on a usual journey (the median), not the 9-in-10 time, which a few cancellations
    // can push up by an hour. Trips where more than 1 in 10 journeys was cancelled are listed apart.
    const saving = (row[f.median] ?? row[f.mean]) - bike;
    if (wins && saving >= 1 && (mode === 'all' || row[f.mode] === mode)) (row[f.cancelled] > 0.1 ? flaky : steady).push([saving, row]);
  }
  const top = (rows, n) => rows.sort((x, y) => y[0] - x[0]).slice(0, n).map(([, row]) => row);
  return {...table, steady: top(steady, 150), flaky: top(flaky, 50)};
}

const bikeMode = () => document.querySelector('[data-mode][aria-pressed="true"]').dataset.mode;
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let bikeRows = [];

async function showBike(mark = timeView('bike'), prefetched) {
  await catalog;
  if (state.view !== 'bike' || !state.index.length) return;
  const box = $('bike-answer');
  $('bike-stage').hidden = !state.bikeReady;
  if (!state.bikeReady) { box.innerHTML = notice('Bike times are not ready yet. Try again later.'); mark('answer'); mark('complete'); return; }
  const mode = bikeMode(), kmh = state.kmh;
  if (!box.querySelector('.answer')) box.innerHTML = WORKING;
  let table = null;
  try {
    if (!state.noBikeTables) {
      table = await (prefetched || json(bikeTableURL(kmh, mode))).catch(() => null);
      if (!table) state.noBikeTables = true;
    }
    table ||= await bikeTable(mode);
  } catch { box.innerHTML = `${notice(FAILED)}${retry('bike-retry')}`; $('bike-stage').hidden = true; mark('error'); return; }
  if (kmh !== state.kmh || mode !== bikeMode() || state.view !== 'bike') return;
  const share = (n, of) => of ? Math.round(100 * n / of) : 0;
  const modes = ['train', 'metro', 'tram', 'bus'].filter(m => table.byMode[m]?.total);
  box.innerHTML = `<p class="answer">The bike is quicker on <b>${share(table.wins, table.total)}%</b> of trips with no change, if you need to be on time 9 days in 10. Against the timetable alone: ${share(table.timetableWins, table.total)}%.</p>
    <p class="aside">${glyph('bike')}<span>Bike ${atSpeed(kmh)}</span></p>
    <h2 class="label">Trips where the bike is quicker</h2>
    <div class="bars">${modes.map(m => { const c = table.byMode[m], s = share(c.wins, c.total);
      return `<div class="bar-row bar-row--bike"><span class="bar-row__name">${m[0].toUpperCase() + m.slice(1)}</span><span class="bar-row__value">${s}%</span>
        <span class="bar-row__track"><i class="bar-row__fill" style="width: ${s}%"></i></span><span class="bar-row__note">Trips over 3 km: ${share(c.longWins, c.longTotal)}%</span></div>`; }).join('')}</div>
    <p class="note">${thousands(table.total)} trips between two stops on one line, each with at least 100 recorded journeys.</p>`;
  const pairs = (rows, flaky) => rows.map(r => { const p = Object.fromEntries(table.fields.map((f, i) => [f, r[i]])); p.bike = p.km / kmh * 60; p.usual = p.median ?? p.mean; p.flaky = flaky; return p; });
  bikeRows = [...pairs(table.steady, false), ...pairs(table.flaky, true)];
  mark('answer');
  await drawBikeRows();
  mark('complete');
}

const bikeTableURL = (kmh, mode) => `data/bike-comparison/${kmh}/${mode}.json`;

// The trips on the list so far. The ready-made tables carry each stop's town; without them (the dev server's
// fallback) it comes from the line's file, read only for the trips shown.
async function drawBikeRows() {
  const rows = bikeRows.slice(0, state.bikeShown), mine = bikeRows;
  const lookup = rows.filter(p => p.from_town === undefined).map(p => p.route);
  const routes = new Map(await Promise.all([...new Set(lookup)].map(async key => [key, await json(`api/route?key=${encodeURIComponent(key)}`).catch(() => null)])));
  if (mine !== bikeRows) return;
  const place = (p, id, name, town = routes.get(p.route)?.stops[id]?.town) => esc(town && !fold(name).includes(fold(town)) ? `${name}, ${town}` : name);
  const go = glyph('go'), m = v => `${Math.round(v)} min`;
  const GROUP = 'Often cancelled: more than 1 journey in 10';
  let table = '', cards = '';
  rows.forEach((p, i) => {
    const meta = metaOf(p.route), train = p.mode === 'train', kind = train ? p.label.replace(/\s*\d+$/, '') : `${p.mode} ${p.label}`;
    const from = place(p, p.from, p.from_name, p.from_town), to = place(p, p.to, p.to_name, p.to_town), cancelled = p.flaky ? `${Math.round(100 * p.cancelled)}% cancelled` : '';
    if (p.flaky && !rows[i - 1]?.flaky) { table += `<tr class="group"><th colspan="8">${GROUP}</th></tr>`; cards += `<li class="group">${GROUP}</li>`; }
    table += `<tr data-i="${i}"><td>${from}<small>to ${to}</small></td><td>${esc(`${meta?.operator || ''} ${kind}`.trim())}${cancelled ? `<small>${cancelled}</small>` : ''}</td>
      <td class="num">${m(p.bike)}</td><td class="num">${m(p.usual)}</td><td class="num">${m(p.p90)}</td><td class="num">${m(p.timetable)}</td>
      <td class="num main">${m(p.usual - p.bike)}</td><td class="go">${go}</td></tr>`;
    cards += `<li><a class="row" data-i="${i}" href="?view=journeys&route=${encodeURIComponent(p.route)}&from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}&days=weekdays">
      <span><span class="row__title">${from}</span><span class="row__sub">to ${to}</span>
      <span class="row__sub">${esc(kind[0].toUpperCase() + kind.slice(1))}: usually ${m(p.usual)}. Bike: ${m(p.bike)}.${cancelled ? ` ${cancelled}.` : ''}</span></span>
      <span class="row__value"><small>Saves</small>${m(p.usual - p.bike)}</span><span class="row__go">${go}</span></a></li>`;
  });
  $('wins-body').innerHTML = table; $('wins-list').innerHTML = cards;
  $('bike-more').hidden = state.bikeShown >= bikeRows.length;
}

function openBikeRow(event) {
  const row = event.target.closest('[data-i]'), p = row && bikeRows[+row.dataset.i];
  if (!p) return;
  event.preventDefault();
  state.days = 'weekdays';
  frame('journeys'); loadRoute(p.route, p.from, p.to);
  scrollTo(0, 0);
}

// ---------- page wiring ----------

function setKmh(kmh) {
  state.kmh = kmh;
  showView(state.view);
}

// Which view is on the page, without filling it.
function frame(view) {
  diagnose('view', view);
  state.view = view;
  const history = view === 'history';
  $('plan').hidden = view !== 'plan';
  $('route-views').hidden = !['journeys', 'history'].includes(view);
  $('reach').hidden = view !== 'reach';
  $('bike').hidden = view !== 'bike';
  $('route-title').textContent = history ? 'Has it got slower?' : 'How long does it really take?';
  for (const id of ['lines-answer', 'lines-stage', 'days-row', 'dates-row']) $(id).hidden = history;
  $('history-answer').hidden = !history;
  if (!history) $('history-stage').hidden = true;
  document.querySelectorAll('[data-view]').forEach(a => a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
}

function showView(view, mark = timeView(view)) {
  frame(view);
  const history = view === 'history';
  if (view === 'plan') showPlan({kmh: () => state.kmh, baseMap}, mark);
  else if (view === 'bike') showBike(mark);
  else if (view === 'reach') showReach(mark);
  else if (!state.route) {
    catalog.then(() => { if (state.view === view && state.index.length) loadRoute(DEFAULT.route, DEFAULT.from, DEFAULT.to, mark); });
  } else if (history) showHistory(mark);
  else if (state.result) showLines(false, mark);
  else refresh(true, mark);
  syncURL();
}

function wire() {
  fillGlyphs();
  const hours = $('reach-hour');
  for (let hr = 5; hr <= 23; hr++) hours.append(new Option(`${pad(hr)}:00 on a weekday`, hr));
  hours.value = state.reach.hour;
  hours.addEventListener('change', () => { state.reach.hour = +hours.value; showReach(); });
  const pressed = (name, value) => document.querySelectorAll(`[data-${name}]`).forEach(b => b.setAttribute('aria-pressed', b.dataset[name] === String(value)));
  pressed('minutes', state.reach.minutes);
  document.querySelectorAll('[data-minutes]').forEach(b => b.addEventListener('click', () => {
    state.reach.minutes = +b.dataset.minutes; pressed('minutes', state.reach.minutes); reachFit = true; showReach();
  }));
  $('show-transit').addEventListener('change', showAreas);
  $('show-bike').addEventListener('change', showAreas);
  reachField = placeField('reach-from', {
    current: () => state.reach.name,
    onPlace: place => { rememberPlace(place); setReach([place.lat, place.lon], place.label, 'place'); },
    onHere: () => useMyLocation(),
  });
  const useMyLocation = () => myLocation(place => setReach([place.lat, place.lon], place.label, 'location'), text => reachField.fail(text), true);
  $('my-location').addEventListener('click', () => { reachField.ok(); useMyLocation(); });
  $('reach-form').addEventListener('submit', event => event.preventDefault());
  $('reach-answer').addEventListener('click', event => { if (event.target.closest('#reach-retry')) showReach(); });

  // The bike speed is chosen in the bike's own sentence, wherever that is.
  document.addEventListener('change', event => { if (event.target.matches('select.kmh')) setKmh(+event.target.value); });

  wireSearch();
  $('route-form').addEventListener('submit', event => event.preventDefault());
  $('from-stop').addEventListener('change', () => { setStops($('from-stop').value, state.to); refresh(true); });
  $('to-stop').addEventListener('change', () => { state.to = $('to-stop').value; refresh(true); });
  $('reverse').addEventListener('click', reverse);
  $('days').addEventListener('change', () => { state.days = $('days').value; refresh(); });
  const dates = open => { $('date-panel').hidden = !open; $('dates-button').setAttribute('aria-expanded', open); };
  $('dates-button').addEventListener('click', () => dates($('date-panel').hidden));
  $('apply-dates').addEventListener('click', () => {
    [state.start, state.end] = [$('start-date').value || state.start, $('end-date').value || state.end].sort();
    dates(false); refresh();
  });
  for (const id of ['lines-answer', 'history-answer']) $(id).addEventListener('click', event => { if (event.target.closest('#lines-retry')) again(); });
  $('save-chart').addEventListener('click', saveChart);
  $('chart').addEventListener('pointermove', showTooltip);
  $('chart').addEventListener('pointerdown', showTooltip);
  $('chart').addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') $('tooltip').hidden = true; });
  new ResizeObserver(() => { if (state.view === 'journeys') { drawChart(); map?.invalidateSize(); } }).observe($('chart-area'));
  new ResizeObserver(() => { if (state.view === 'history') drawHistory(); }).observe($('history-area'));

  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    pressed('mode', b.dataset.mode); state.bikeShown = BIKE_PAGE; showBike();
  }));
  $('bike-more').addEventListener('click', () => { state.bikeShown += 2 * BIKE_PAGE; drawBikeRows(); });
  $('wins-body').addEventListener('click', openBikeRow);
  $('wins-list').addEventListener('click', openBikeRow);
  $('bike-answer').addEventListener('click', event => { if (event.target.closest('#bike-retry')) showBike(); });
  document.addEventListener('click', event => { if (event.target.closest('#boot-retry')) boot(); });

  document.querySelectorAll('[data-view]').forEach(a => a.addEventListener('click', event => { event.preventDefault(); showView(a.dataset.view); }));
  // The charts and the reach areas are painted with the tokens, so they are painted again when light turns to dark.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.view === 'journeys') drawChart(); else if (state.view === 'history') drawHistory(); else if (state.view === 'reach') showReach();
  });
}

async function boot() {
  const view = state.view, mark = timeView(view, 0);
  const routeView = ['journeys', 'history'].includes(view);
  state.days = DAYS[params.get('days')] ? params.get('days') : 'weekdays';
  state.start = params.get('start') || ''; state.end = params.get('end') || '';
  catalog = json('data/index.json').then(index => {
    state.index = index.routes;
    state.bikeReady = index.bike !== false;
    const transit = index.coverage.transit || index.coverage.ret, trains = index.coverage.trains;
    if (transit) $('transit-days').textContent = `${transit.days} days between ${dateLabel(transit.start)} and ${dateLabel(transit.end)}`;
    if (trains) $('train-days').textContent = `from ${dateLabel(trains.start)} to ${dateLabel(trains.end)}`;
  }).catch(() => {
    if (state.view === 'plan' || state.view === 'reach') return;
    failLines(boot);
    $('bike-answer').innerHTML = `${notice(FAILED)}${retry('boot-retry')}`;
    $('bike-stage').hidden = true;
    mark('error');
  });
  if (view === 'plan' || view === 'reach') return showView(view, mark);
  frame(view);
  if (view === 'bike') {
    const table = json(bikeTableURL(state.kmh, bikeMode())).catch(() => null);
    return showBike(mark, table);
  }
  const requested = params.get('route') || DEFAULT.route;
  const from = params.get('from') || DEFAULT.from, to = params.get('to') || DEFAULT.to;
  const details = routeView && /^[\w.-]+$/.test(requested)
    ? json(`api/route?key=${encodeURIComponent(requested)}`) : null;
  details?.catch(() => {});
  await catalog;
  if (state.view === view && state.index.length) {
    const key = state.index.some(r => r.key === params.get('route')) ? params.get('route') : DEFAULT.route;
    return loadRoute(key, from, to, mark, key === requested ? details : null);
  }
}
diagnostics();
wire();
boot();
