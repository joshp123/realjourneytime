// One line, from its raw records: a day on the line, every vehicle drawn stop by stop, and how long each
// stretch between stops takes.
import {json} from './data.js';
import {$, address, clock, esc, go, thousands, token} from './ui.js';
import {timeView} from './view-timing.js';

const HOUR = 150;         // pixels an hour takes on the day chart; it scrolls sideways
const ROW = 22;           // pixels a stop takes at least
const SANS = '-apple-system, "Helvetica Neue", "Segoe UI", sans-serif';
const MODES = {train: 'train', metro: 'metro', tram: 'tram', bus: 'bus'};
const long = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
const whole = s => s < 600 ? `${(Math.round(s / 30) / 2).toString()} min` : `${Math.round(s / 60)} min`;

const FRAME = `
  <div class="line">
    <div class="linehead"><h1 id="line-title">&nbsp;</h1><div class="by" id="line-dirs"></div></div>
    <section class="card">
      <div class="dayhead"><h2 id="day-title">&nbsp;</h2>
        <div class="daypick"><button class="btn" id="day-before" type="button" aria-label="The day before">‹</button><input class="box" id="day" type="date" aria-label="Date"><button class="btn" id="day-after" type="button" aria-label="The day after">›</button></div></div>
      <p class="daykey" id="day-key"></p>
      <div class="marey" id="marey"><div class="marey-stops" id="marey-stops"></div><div class="marey-scroll" id="marey-scroll"><canvas id="marey-canvas"></canvas><div class="tip" id="marey-tip" hidden></div></div></div>
    </section>
    <div class="foot"><div><p class="count" id="day-count"></p></div><div class="acts"><button class="btn" id="day-download" type="button">Download the day</button></div></div>
    <section class="card slow">
      <h2>Where it loses time</h2>
      <p class="daykey" id="slow-key"></p>
      <div id="slow"></div>
    </section>
    <details class="more"><summary>Data and methods</summary>
      <p>The day chart draws every journey the timetable held for that day and direction, from its recorded time at each stop. Where a stop has no recorded time the line runs straight past it.</p>
      <p>A stretch is the ride from leaving one stop to arriving at the next, on weekdays. "Usually" is the middle one of all recorded rides. The slowest hour is the hour of the day with the highest middle ride, among hours with at least 20.</p>
    </details>
  </div>`;

let turn = 0, loaded = null;

export async function show(root, q) {
  const mine = ++turn, done = timeView('line'), key = q.get('line');
  if (!$('marey')) { root.innerHTML = FRAME; loaded = null; }
  const fail = () => { $('marey-stops').innerHTML = ''; $('day-key').innerHTML = '<span class="msg">This line did not load. <button class="btn" type="button" id="again">Try again</button></span>'; $('again').onclick = () => { loaded = null; show(root, q); }; done('error'); };
  try {
    if (loaded?.key !== key) {
      const [route, line] = await Promise.all([json(`api/route?key=${encodeURIComponent(key)}`), json(`api/line?key=${encodeURIComponent(key)}`)]);
      loaded = {key, route, line, days: new Map()};
    }
  } catch (error) { if (mine === turn) fail(); return; }
  if (mine !== turn) return;
  const {route, line} = loaded;
  if (!line.directions.length) { $('line-title').textContent = route.name; $('day-key').textContent = 'Too few journeys were recorded on this line to draw it.'; return done('complete'); }
  const d = Math.min(line.directions.length - 1, Math.max(0, +q.get('dir') || 0)), direction = line.directions[d];
  const weekdays = line.dates.filter((_, i) => line.types[i] === 'w');
  const date = line.dates.includes(q.get('date')) ? q.get('date') : weekdays.at(-1) || line.dates.at(-1);
  const link = change => address({line: key, dir: d || null, date: q.get('date'), ...change});
  const stops = route.patterns[direction.pattern].map(s => route.stops[route.stop_ids[s]] || {name: '?'});
  const mode = MODES[route.mode] || 'vehicle';

  const town = stops[0].town && !route.name.includes(stops[0].town) ? `, ${stops[0].town}` : '';
  $('line-title').textContent = route.mode === 'train' ? `${route.name}: ${stops[0].name} to ${stops.at(-1).name}` : `${route.name}${town}`;
  $('line-dirs').innerHTML = line.directions.map((x, i) => {
    const s = route.patterns[x.pattern].map(k => route.stops[route.stop_ids[k]]);
    return `<a href="${link({dir: i || null})}" data-go class="${i === d ? 'on' : ''}">${esc(s[0]?.name)} to ${esc(s.at(-1)?.name)}</a>`; }).join('');
  $('day-title').textContent = `Every ${mode} on ${long(date)}`;
  $('day').value = date; $('day').min = line.dates[0]; $('day').max = line.dates.at(-1);
  const at = line.dates.indexOf(date);
  $('day-before').disabled = at <= 0; $('day-after').disabled = at >= line.dates.length - 1;
  $('day-before').onclick = () => go(link({date: line.dates[at - 1]}), true);
  $('day-after').onclick = () => go(link({date: line.dates[at + 1]}), true);
  $('day').onchange = () => { const v = $('day').value; go(link({date: line.dates.includes(v) ? v : line.dates.reduce((b, x) => Math.abs(new Date(x) - new Date(v)) < Math.abs(new Date(b) - new Date(v)) ? x : b)}), true); };
  $('day-key').innerHTML = `<i class="ran"></i>Ran <i class="due"></i>Timetable <i class="not"></i>Cancelled`;
  slow(direction, stops);

  let day;
  try {
    if (!loaded.days.has(date)) loaded.days.set(date, await json(`api/line-day?key=${encodeURIComponent(key)}&date=${date}`));
    day = loaded.days.get(date);
  } catch (error) { if (mine === turn) fail(); return; }
  if (mine !== turn) return;
  done('answer');
  // A journey belongs to this direction when it calls at two or more of its stops, in the same order: short
  // workings and diversions are drawn over the stops they share.
  const wanted = route.patterns[direction.pattern], places = new Map();
  const placing = p => {
    if (!places.has(p)) {
      const at = wanted.map(s => route.patterns[p].indexOf(s)), seen = at.filter(i => i >= 0);
      places.set(p, seen.length >= 2 && seen.every((v, i) => !i || v > seen[i - 1]) ? at : null);
    }
    return places.get(p);
  };
  const journeys = day.journeys.filter(j => placing(j[0])).map(j => {
    // Times come as differences (pipeline/lines.mjs): planned since the stop before, recorded since planned.
    const own = [], ran = [];
    let before = 0;
    for (let k = 1; k < j.length; k += 2) {
      const planned = j[k] == null ? null : before + j[k];
      own.push(planned); ran.push(j[k + 1] == null ? null : j[k + 1] === false ? -1 : (planned ?? before) + j[k + 1]);
      before = planned ?? before;
    }
    const at = placing(j[0]);
    const planned = at.map(i => i < 0 ? null : own[i]), recorded = at.map(i => i < 0 ? null : ran[i]);
    return {planned, recorded, cancelled: recorded.some(t => t === -1)};
  }).filter(j => j.planned.some(t => t != null)).sort((a, b) => a.planned.find(t => t != null) - b.planned.find(t => t != null));
  const others = day.journeys.filter(j => j[0] !== direction.pattern && placing(j[0])).length;
  const cancelled = journeys.filter(j => j.cancelled).length;
  $('day-count').textContent = `${thousands(journeys.length)} journeys in this direction, ${cancelled} of them cancelled.` + (others ? ` ${thousands(others)} of them ran a shorter or diverted route.` : '');
  marey(stops, direction, journeys, mode);
  $('day-download').onclick = () => {
    const t = s => s == null ? '' : s === -1 ? 'cancelled' : clock(s) + ':' + String(((s % 60) + 60) % 60).padStart(2, '0');
    const rows = [['journey', 'stop', 'due', 'recorded']];
    journeys.forEach((j, n) => stops.forEach((s, i) => rows.push([n + 1, `"${s.name.replace(/"/g, '""')}"`, t(j.planned[i]), t(j.recorded[i])])));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n') + '\n'], {type: 'text/csv'}));
    a.download = `real-journey-time-${key}-${date}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  done('complete');
}

// Stops down the side, spaced by their timetabled time apart, and the time of day across.
function marey(stops, direction, journeys, mode) {
  const gaps = direction.stretches.map(s => Math.max(30, s[0] ?? s[1] ?? 60));
  const total = gaps.reduce((sum, g) => sum + g, 0), top = 26, bottom = 10;
  const height = Math.max(300, Math.min(1400, (stops.length - 1) * ROW)) + top + bottom;
  const y = [top];
  // No two stops closer than a line of text, however short the ride between them.
  const scale = (height - top - bottom) / total;
  for (const g of gaps) y.push(y.at(-1) + g * scale);
  const times = journeys.flatMap(j => [...j.planned, ...j.recorded]).filter(t => t != null && t >= 0);
  const scroll = $('marey-scroll'), canvas = $('marey-canvas'), tip = $('marey-tip');
  $('marey-stops').style.height = `${height}px`;
  let last = -99;
  $('marey-stops').innerHTML = stops.map((s, i) => { const show = y[i] - last >= 13 || i === stops.length - 1; if (show) last = y[i]; return show ? `<span style="top:${y[i]}px">${esc(s.name)}</span>` : ''; }).join('');
  tip.hidden = true;
  if (!times.length) { canvas.width = canvas.height = 0; return; }
  const t0 = Math.floor(Math.min(...times) / 3600) * 3600, t1 = Math.ceil(Math.max(...times) / 3600) * 3600;
  const width = Math.max(scroll.clientWidth, (t1 - t0) / 3600 * HOUR), dpr = devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const g = canvas.getContext('2d'), X = t => (t - t0) / (t1 - t0) * width;
  g.scale(dpr, dpr);
  g.font = `11px ${SANS}`; g.textAlign = 'center';
  for (let t = t0; t <= t1; t += 900) {
    const hour = t % 3600 === 0;
    g.strokeStyle = token('--grid'); g.lineWidth = hour ? 1 : 0.5;
    g.beginPath(); g.moveTo(X(t), top - (hour ? 6 : 0)); g.lineTo(X(t), height - bottom); g.stroke();
    if (hour && X(t) > 22 && t < t1) { g.fillStyle = token('--ink-2'); g.fillText(clock(t), X(t), 12); }
  }
  g.strokeStyle = token('--grid'); g.lineWidth = 0.5;
  for (const row of y) { g.beginPath(); g.moveTo(0, row); g.lineTo(width, row); g.stroke(); }
  const path = (list, colour, w, dash) => {
    g.strokeStyle = colour; g.lineWidth = w; g.setLineDash(dash || []);
    g.beginPath();
    let pen = false;
    list.forEach((t, i) => { if (t == null || t < 0) return; if (pen) g.lineTo(X(t), y[i]); else g.moveTo(X(t), y[i]); pen = true; });
    g.stroke();
  };
  for (const j of journeys) path(j.planned, j.cancelled ? token('--ink-2') : token('--due'), j.cancelled ? 1.2 : 1, j.cancelled ? [4, 3] : null);
  for (const j of journeys) if (!j.cancelled) path(j.recorded, token('--sure'), 1.5);
  g.setLineDash([]);
  if (scroll.scrollLeft === 0 && width > scroll.clientWidth) scroll.scrollLeft = Math.max(0, X(Math.max(t0, 7 * 3600)) - 10);

  // Tap or point at a line to read that journey.
  const pick = event => {
    const box = canvas.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
    let best = null, near = 12;
    for (const j of journeys) {
      const list = j.cancelled ? j.planned : j.recorded;
      let before = null;
      list.forEach((t, i) => {
        if (t == null || t < 0) return;
        if (before && py >= y[before[1]] - 2 && py <= y[i] + 2) {
          const x = X(before[0]) + (X(t) - X(before[0])) * (y[i] === y[before[1]] ? 0 : (py - y[before[1]]) / (y[i] - y[before[1]]));
          if (Math.abs(x - px) < near) { near = Math.abs(x - px); best = j; }
        }
        before = [t, i];
      });
    }
    tip.hidden = !best;
    if (!best) return;
    const first = best.planned.findIndex(t => t != null), end = best.planned.findLastIndex(t => t != null);
    const ran = (i, list = best.recorded) => list[i] != null && list[i] >= 0 ? clock(list[i]) : null;
    const late = best.recorded[end] != null && best.recorded[end] >= 0 ? Math.round((best.recorded[end] - best.planned[end]) / 60) : null;
    tip.innerHTML = best.cancelled ? `<b>Cancelled</b><br>Due to leave ${esc(stops[first].name)} at ${clock(best.planned[first])}.`
      : `<b>${late == null ? 'Not recorded to the end' : late > 0 ? `${late} min late` : late < 0 ? `${-late} min early` : 'On time'}</b><br>Due to leave ${esc(stops[first].name)} at ${clock(best.planned[first])}${ran(first) ? `, left at ${ran(first)}` : ''}.<br>Due at ${esc(stops[end].name)} at ${clock(best.planned[end])}${ran(end) ? `, arrived at ${ran(end)}` : ''}.`;
    tip.style.left = `${Math.max(scroll.scrollLeft + 4, Math.min(scroll.scrollLeft + scroll.clientWidth - tip.offsetWidth - 4, px - tip.offsetWidth / 2))}px`;
    tip.style.top = `${py - tip.offsetHeight - 14 < 0 ? py + 14 : py - tip.offsetHeight - 14}px`;
  };
  canvas.onclick = pick;
  canvas.onpointermove = event => { if (event.pointerType === 'mouse') pick(event); };
  canvas.onpointerleave = event => { if (event.pointerType === 'mouse') tip.hidden = true; };
}

// Each stretch between two stops: the timetable, the usual ride, and the slowest hour of the day.
function slow(direction, stops) {
  const rows = direction.stretches.map(([timetable, usual, worst, hour, n], i) => ({from: stops[i].name, to: stops[i + 1].name, timetable, usual, worst, hour, n}));
  const have = rows.filter(r => r.usual != null);
  $('slow-key').innerHTML = `<i class="usual"></i>Usually <i class="worst"></i>In its slowest hour <i class="tick"></i>Timetable`;
  if (!have.length) { $('slow').innerHTML = '<p class="count">Too few rides were recorded stop by stop on this line.</p>'; return; }
  const widest = Math.max(...have.map(r => Math.max(r.usual, r.worst ?? 0, r.timetable ?? 0)));
  const pc = v => `${(100 * v / widest).toFixed(1)}%`;
  $('slow').innerHTML = rows.map(r => `<div class="hop"><div class="name">${esc(r.from)} to ${esc(r.to)}</div>` + (r.usual == null ? '<div class="track"></div><div class="num">not recorded</div>'
    : `<div class="track">${r.worst != null && r.worst > r.usual ? `<span class="worst" style="width:${pc(r.worst)}"></span>` : ''}<span class="usual" style="width:${pc(r.usual)}"></span>${r.timetable != null ? `<span class="tick" style="left:${pc(r.timetable)}"></span>` : ''}</div>
       <div class="num">${whole(r.usual)}${r.worst != null && Math.round(r.worst / 30) > Math.round(r.usual / 30) ? `<small>${whole(r.worst)} at ${String(r.hour).padStart(2, '0')}:00</small>` : ''}</div>`) + '</div>').join('');
}
