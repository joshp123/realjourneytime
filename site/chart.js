// The chart: every recorded journey as a dot, by the time it arrived, with the timetable, the average and the
// time that was enough for nine journeys in ten drawn through the day, and the bike as a level line.
import {clock, dateLabel, token} from './ui.js';

const SANS = '-apple-system, "Helvetica Neue", "Segoe UI", sans-serif';
const SERIF = 'Charter, "Iowan Old Style", "Bitstream Charter", Georgia, serif';
const NEAR = 14;          // pixels: how close the pointer must be to a dot to mean that dot
const CELL = 8;           // pixels: the grid the dots are sorted into, to find the nearest quickly
export const SURE = 'To be sure';

const minutes = v => v >= 60 ? `${Math.floor(v / 60)} h ${String(Math.round(v % 60)).padStart(2, '0')}` : `${Math.round(v)} min`;

// model: {records, rows} from trip.js. options: {bikeMinutes, lines (false: dots only), onAt(row or null),
// describe(record) -> text for a dot}. Returns {redraw}.
export function chart(el, model, options) {
  const state = {at: null, picked: null};
  let geometry = null;

  function draw() {
    el.replaceChildren();
    const phone = innerWidth <= 700, W = el.clientWidth, H = el.clientHeight, dpr = devicePixelRatio || 1;
    const pad = {l: phone ? 30 : 44, r: phone ? 80 : 108, t: 10, b: 44};
    // An hour with under a fifth of the usual number of journeys gets dots but no lines: a few late-night
    // journeys would otherwise draw a cliff.
    const counts = model.rows.filter(r => r.p90 != null).map(r => r.n).sort((a, b) => a - b);
    const need = Math.max(5, (counts[counts.length >> 1] || 0) / 5);
    const rows = options.lines === false ? [] : model.rows.filter(r => r.p90 != null && r.n >= need);
    const times = rows.length ? rows.map(r => r.at) : model.records.map(r => r.arrival);
    if (!times.length) return;
    const x0 = Math.floor(Math.min(...times) / 3600) * 3600, x1 = Math.max(x0 + 3600, Math.ceil(Math.max(...times) / 3600) * 3600);
    // The scale fits nine tenths of the day, so one bad hour does not flatten the rest.
    const ninth = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.9)];
    const top = rows.length ? ninth(rows.map(r => r.p90)) : ninth(model.records.map(r => r.real));
    const bike = options.bikeMinutes, bikeOn = bike != null && bike <= top * 1.5;
    const want = Math.max(top * 1.3, bikeOn ? bike * 1.12 : 0, 5);
    const step = [1, 2, 5, 10, 20, 30, 60, 120].find(s => want / s <= 6);
    const y1 = Math.ceil(want / step) * step;
    const X = t => pad.l + (t - x0) / (x1 - x0) * (W - pad.l - pad.r), Y = v => H - pad.b - v / y1 * (H - pad.t - pad.b);

    const canvas = document.createElement('canvas');
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const n = model.records.length, radius = n > 500 ? 1.3 : 2.4;
    g.fillStyle = token('--sure');
    // Fewer pixels hold the same dots on a phone, so each is fainter there.
    g.globalAlpha = (n > 20000 ? 0.05 : n > 5000 ? 0.09 : n > 500 ? 0.2 : 0.5) * (n > 500 ? Math.min(1, W / 900) : 1);
    const cells = new Map();
    for (const r of model.records) {
      if (r.real > y1 || r.arrival < x0 || r.arrival > x1) continue;
      const x = X(r.arrival), y = Y(r.real);
      g.beginPath(); g.arc(x, y, radius, 0, 7); g.fill();
      const key = (Math.floor(x / CELL) << 12) | Math.floor(y / CELL);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(r);
    }
    el.append(canvas);

    const text = (x, y, s, more = '') => `<text x="${x}" y="${y}" font-family='${SANS}' font-size="${phone ? 11 : 12}" fill="${token('--ink-2')}" ${more}>${s}</text>`;
    let s = '';
    for (let v = 0; v <= y1; v += step) {
      s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? token('--grid') : token('--ink')}" stroke-width="${v ? 1 : 1.5}"/>` + text(pad.l - 8, Y(v) + 4, v, 'text-anchor="end"');
    }
    s += text(pad.l + 6, Y(y1) + 4, 'min');
    s += `<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${H - pad.b}" stroke="${token('--ink')}" stroke-width="1.5"/>`;
    const hours = (x1 - x0) / 3600, every = [1, 2, 3, 4, 6].find(e => hours / e <= (phone ? 5 : 11)) || 6;
    for (let t = x0; t <= x1; t += 3600 * every) s += text(X(t), H - pad.b + 17, clock(t), 'text-anchor="middle"');
    s += text((pad.l + W - pad.r) / 2, H - 8, 'Arrival time', 'text-anchor="middle"');
    const path = (field, colour, width, dash) => {
      let d = '', last = null;
      for (const r of rows) {
        d += `${last != null && r.at - last <= 300 ? 'L' : 'M'}${X(r.at).toFixed(1)} ${Y(Math.min(r[field], y1)).toFixed(1)}`;
        last = r.at;
      }
      return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
    };
    const labels = [];
    if (rows.length) {
      s += path('mean', token('--average-line'), 1.6, '5 3') + path('timetable', token('--timetable'), 2.4) + path('p90', token('--sure'), 2.6);
      const end = rows.at(-1);
      labels.push([SURE, end.p90, token('--sure')], ['Average', end.mean, token('--average')], ['Timetable', end.timetable, token('--timetable')]);
    }
    const xe = rows.length ? X(rows.at(-1).at) : W - pad.r;
    if (bikeOn) {
      s += `<line x1="${pad.l}" x2="${xe}" y1="${Y(bike)}" y2="${Y(bike)}" stroke="${token('--bike')}" stroke-width="2.4" stroke-dasharray="1 5" stroke-linecap="round"/>`;
      labels.push(['Bike', bike, token('--bike')]);
    }
    labels.sort((a, b) => b[1] - a[1]);
    let previous = -99;
    for (const [name, v, colour] of labels) {
      const y = Math.max(Y(Math.min(v, y1)) + 5, previous + 19);
      previous = y;
      s += `<text x="${xe + 10}" y="${y}" font-family='${SERIF}' font-weight="700" font-size="15" fill="${colour}">${name}</text>`;
    }
    s += '<line class="rule" y1="' + pad.t + '" y2="' + (H - pad.b) + '" stroke="' + token('--ink') + '" stroke-width="1" visibility="hidden"/>';
    s += '<circle class="pick" r="5" fill="none" stroke="' + token('--ink') + '" stroke-width="1.5" visibility="hidden"/>';
    el.insertAdjacentHTML('beforeend', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg><div class="tip" hidden></div>`);
    geometry = {X, Y, x0, x1, y1, pad, W, H, rows, cells};
    show();
  }

  function nearest(px, py) {
    let best = null, d2 = NEAR * NEAR;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), reach = Math.ceil(NEAR / CELL);
    for (let i = cx - reach; i <= cx + reach; i++) for (let j = cy - reach; j <= cy + reach; j++) {
      for (const r of geometry.cells.get((i << 12) | j) || []) {
        const d = (geometry.X(r.arrival) - px) ** 2 + (geometry.Y(r.real) - py) ** 2;
        if (d < d2) { d2 = d; best = r; }
      }
    }
    return best;
  }

  function show() {
    if (!geometry) return;
    const rule = el.querySelector('.rule'), pick = el.querySelector('.pick'), tip = el.querySelector('.tip');
    const row = state.at == null ? null : geometry.rows.reduce((best, r) => !best || Math.abs(r.at - state.at) < Math.abs(best.at - state.at) ? r : best, null);
    const on = row && Math.abs(row.at - state.at) <= 600;
    rule.setAttribute('visibility', on ? 'visible' : 'hidden');
    if (on) { rule.setAttribute('x1', geometry.X(row.at)); rule.setAttribute('x2', geometry.X(row.at)); }
    options.onAt?.(on ? row : null);
    const r = state.picked;
    pick.setAttribute('visibility', r ? 'visible' : 'hidden');
    tip.hidden = !r;
    if (r) {
      const x = geometry.X(r.arrival), y = geometry.Y(r.real);
      pick.setAttribute('cx', x); pick.setAttribute('cy', y);
      tip.innerHTML = options.describe(r);
      tip.style.left = `${Math.max(4, Math.min(geometry.W - tip.offsetWidth - 4, x - tip.offsetWidth / 2))}px`;
      tip.style.top = `${y - tip.offsetHeight - 12 < 0 ? y + 12 : y - tip.offsetHeight - 12}px`;
    }
  }

  const point = event => { const box = el.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  const inside = (x, y) => geometry && x >= geometry.pad.l && x <= geometry.W - geometry.pad.r && y >= geometry.pad.t && y <= geometry.H - geometry.pad.b;
  const timeAt = x => geometry.x0 + (x - geometry.pad.l) / (geometry.W - geometry.pad.l - geometry.pad.r) * (geometry.x1 - geometry.x0);
  el.onpointermove = event => {
    const [x, y] = point(event);
    if (!inside(x, y)) { el.onpointerleave(event); return; }
    state.at = timeAt(x);
    if (event.pointerType === 'mouse') state.picked = options.describe ? nearest(x, y) : null;
    show();
  };
  el.onpointerleave = event => { if (event.pointerType === 'mouse') { state.at = null; state.picked = null; show(); } };
  el.onclick = event => {
    const [x, y] = point(event);
    if (!inside(x, y)) return;
    state.at = timeAt(x);
    state.picked = options.describe ? nearest(x, y) : null;
    show();
  };

  draw();
  return {redraw: draw, at: seconds => { state.at = seconds; show(); }};
}

// "Tue 10 Mar 2026 · Tram 2 · due 08:14, arrived 08:31 · 17 min"
export function describeJourney(r, toLabel) {
  const day = new Date(r.date + 'T12:00:00Z').toLocaleDateString('en-GB', {weekday: 'short', timeZone: 'UTC'});
  const waited = r.cancelled ? `<br>Cancelled. The next to arrive was ${r.got.line}, leaving at ${clock(r.got.ad)}.`
    : r.got.sd !== r.sd || r.got.line !== r.line ? `<br>${r.got.line}, leaving at ${clock(r.got.ad)}, got there first.` : '';
  // Whole minutes between the two clock times shown, so the sum on screen is right.
  const took = Math.floor(r.arrival / 60) - Math.floor(r.sd / 60);
  return `<b>${minutes(took)}</b> · ${day} ${dateLabel(r.date)} · ${r.line}<br>Due to leave at ${clock(r.sd)} and arrive at ${clock(r.sa)}. Arrived at ${clock(r.arrival)}.${waited}`;
}

// The chart as a picture, with its title and numbers, for sharing.
export async function chartImage(el, title, numbers, footer) {
  const canvas = el.querySelector('canvas'), svg = el.querySelector('svg');
  const W = el.clientWidth, H = el.clientHeight, dpr = devicePixelRatio || 1, head = 92, foot = 34, edge = 24;
  const out = document.createElement('canvas');
  out.width = (W + 2 * edge) * dpr; out.height = (H + head + foot) * dpr;
  const g = out.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = token('--card'); g.fillRect(0, 0, W + 2 * edge, H + head + foot);
  g.fillStyle = token('--ink'); g.font = `400 22px ${SERIF}`; g.fillText(title, edge, 36, W);
  let x = edge;
  for (const [value, name, colour] of numbers) {
    g.fillStyle = colour; g.font = `700 22px ${SERIF}`; g.fillText(value, x, 72);
    x += g.measureText(value).width + 6;
    g.font = `14px ${SANS}`; g.fillText(name, x, 72);
    x += g.measureText(name).width + 22;
  }
  g.drawImage(canvas, edge, head, W, H);
  const picture = new Image();
  picture.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await picture.decode();
  g.drawImage(picture, edge, head, W, H);
  g.fillStyle = token('--ink-2'); g.font = `12px ${SANS}`; g.fillText(footer, edge, H + head + 20, W);
  return new Promise(done => out.toBlob(done, 'image/png'));
}
