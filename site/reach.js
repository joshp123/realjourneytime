// How far can I get? The area you reach from a point by public transport and by bike, and the people in it.
// The start moves only when you choose a place, press the location button or drag the pin.
import {json, metres, placeNamed, places, search} from './data.js';
import {diagnose} from './diagnostics.js';
import {baseMap, pin} from './map.js';
import {$, address, esc, go, pad, searchBox, speedControl, thousands} from './ui.js';
import {timeView} from './view-timing.js';

const OPENS = {name: 'Utrecht Centraal', lat: 52.08889, lon: 5.11028};
const short = label => label.replace(/, [^,]+$/, '');

const FRAME = `
  <div class="reachbar">
    <div class="field"><label for="reach-from">From</label><input class="box" id="reach-from" type="text" inputmode="search" enterkeyhint="search" spellcheck="false" autocomplete="off" autocorrect="off" placeholder="Stop or station" role="combobox" aria-expanded="false" aria-controls="reach-list">
      <button class="loc" id="here" type="button" aria-label="Use my location" title="Use my location"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 11.5 21 3l-8.5 18-2-7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
      <div class="list" id="reach-list" role="listbox" hidden></div></div>
    <div class="field"><label for="hour">Leave at</label><select class="box sel" id="hour">${Array.from({length: 19}, (_, i) => `<option value="${i + 5}">${pad(i + 5)}:00</option>`).join('')}</select></div>
    <div class="field"><label for="within">Within</label><select class="box sel" id="within">${[30, 45, 60].map(m => `<option value="${m}">${m} minutes</option>`).join('')}</select></div>
  </div>
  <div class="bar"><span></span><div class="speed" id="speed"></div></div>
  <div class="mapwrap">
    <section class="over"><h1 id="reach-title"></h1><div class="key" id="reach-key">&nbsp;</div></section>
    <div class="map tall" id="reach-map"></div>
    <div class="toast" id="toast" hidden></div>
  </div>
  <p class="count" id="reach-note">Drag pin A to move the start. Public transport is one direct ride, with enough time for nine journeys in ten.</p>
  <details class="more"><summary>Data and methods</summary>
    <p>Public transport is a walk of up to 1 km to a stop, one ride with no change, and a walk from the stop you get off at. The ride takes the time that was enough for nine journeys in ten at that hour, on weekdays. Waiting at the stop is not counted.</p>
    <p>The bike takes the shortest legal route on OpenStreetMap at the speed you choose.</p>
    <p>People are counted on the CBS map of 100 metre squares, 2024, rounded to the nearest 1,000.</p>
  </details>`;

// The server sends each area as a filled picture. Draw its edge firmly and its inside faintly, so the map
// under it stays readable where the two areas overlap.
function outline(src, colour, grow) {
  return new Promise(done => {
    const image = new Image();
    image.onload = () => {
      const w = image.width * grow, h = image.height * grow, canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high'; g.filter = `blur(${grow * 0.6}px)`; g.drawImage(image, 0, 0, w, h); g.filter = 'none';
      const a = g.getImageData(0, 0, w, h), o = g.createImageData(w, h), inside = i => a.data[i * 4 + 3] > 110, t = Math.max(1, Math.round(grow * 0.5));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!inside(i)) continue;
        let edge = false;
        for (let dy = -t; dy <= t && !edge; dy++) for (let dx = -t; dx <= t; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h || !inside(Y * w + X)) { edge = true; break; }
        }
        o.data.set([...colour, edge ? 255 : 34], i * 4);
      }
      g.putImageData(o, 0, 0);
      done(canvas.toDataURL());
    };
    image.src = src;
  });
}

let map = null, marker = null, layers = [], fitted = null, turn = 0, undo = null;

export async function show(root, q) {
  const mine = ++turn, done = timeView('reach');
  const at = (q.get('at') || '').split(',').map(Number);
  const state = {
    ...(at.length === 2 && at.every(Number.isFinite) ? {lat: at[0], lon: at[1], name: q.get('name') || 'this point'} : OPENS),
    hour: +q.get('hour') >= 5 && +q.get('hour') <= 23 ? +q.get('hour') : 8, minutes: [30, 45, 60].includes(+q.get('minutes')) ? +q.get('minutes') : 30,
    kmh: [15, 20, 25, 45].includes(+q.get('kmh')) ? +q.get('kmh') : 15,
  };
  const link = change => { const s = {...state, ...change}; return address({view: 'reach', at: `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`, name: s.name,
    hour: s.hour === 8 ? null : s.hour, minutes: s.minutes === 30 ? null : s.minutes, kmh: s.kmh === 15 ? null : s.kmh}); };
  // A deliberate move of the start: say where it was, and offer the way back.
  const move = (to, source) => { undo = {lat: state.lat, lon: state.lon, name: state.name}; diagnose('reach-origin', source); go(link(to)); };

  if (!$('reach-map')) {
    root.innerHTML = FRAME; map = null; marker = null; layers = []; fitted = null; undo = null;
    searchBox($('reach-from'), $('reach-list'), async text => ({rows: (await search(text)).map(p => ({label: p.label, small: p.kind, value: p}))}),
      p => now.move({lat: p.lat, lon: p.lon, name: p.label}, 'search'));
    $('here').onclick = () => navigator.geolocation?.getCurrentPosition(
      async at => now.move({lat: at.coords.latitude, lon: at.coords.longitude, name: await near(at.coords.latitude, at.coords.longitude)}, 'location'),
      () => { $('reach-note').textContent = 'Your location is not available. Choose a place, or drag pin A.'; });
  }
  Object.assign(now, {move, link});
  $('reach-from').value = state.name;
  $('hour').value = state.hour; $('within').value = state.minutes;
  $('hour').onchange = () => go(link({hour: +$('hour').value}), true);
  $('within').onchange = () => go(link({minutes: +$('within').value}), true);
  $('speed').innerHTML = speedControl(state.kmh);
  $('speed').onclick = event => { const k = event.target.dataset?.kmh; if (k) go(link({kmh: +k}), true); };
  $('reach-title').textContent = `Within ${state.minutes} minutes of ${short(state.name)}, leaving at ${pad(state.hour)}:00 on a weekday`;
  $('toast').hidden = !undo;
  if (undo) {
    $('toast').innerHTML = `Start moved from ${esc(short(undo.name))}. <button class="btn" type="button" id="undo">Undo</button>`;
    $('undo').onclick = () => { const back = undo; undo = null; diagnose('reach-origin', 'undo'); go(link(back)); };
  }

  if (!map) map = baseMap('reach-map').setView([state.lat, state.lon], 10);
  if (!marker) {
    marker = L.marker([state.lat, state.lon], {icon: pin('A'), draggable: true, autoPan: true}).addTo(map);
    marker.on('dragend', async () => { const p = marker.getLatLng(); now.move({lat: p.lat, lon: p.lng, name: await near(p.lat, p.lng)}, 'pin'); });
  }
  marker.setLatLng([state.lat, state.lon]);

  let data;
  try { data = await json(`api/reach?lat=${state.lat.toFixed(5)}&lon=${state.lon.toFixed(5)}&hour=${state.hour}&minutes=${state.minutes}&kmh=${state.kmh}`); } catch (error) {
    if (mine !== turn) return;
    $('reach-key').innerHTML = '<span>This area did not load.</span> <button class="btn" type="button" id="again">Try again</button>';
    $('again').onclick = () => show(root, q);
    return done('error');
  }
  if (mine !== turn) return;
  const people = layer => layer.pending ? '' : thousands(layer.people);
  $('reach-key').innerHTML = `<div class="k-sure"><b>${people(data.transit)}</b> people by public transport</div>` +
    (data.bike.pending ? '' : `<div class="k-bike"><b>${people(data.bike)}</b> people by bike</div>`);
  done('answer');
  const pictures = await Promise.all([[data.transit, [178, 69, 31], 4], [data.bike, [44, 122, 75], 8]].map(async ([layer, colour, grow]) =>
    layer.png ? L.imageOverlay(await outline(layer.png, colour, grow), layer.bounds, {interactive: false}) : null));
  if (mine !== turn) return;
  for (const layer of layers) layer.remove();
  layers = pictures.filter(Boolean).map(p => p.addTo(map));
  // Fit the map when the start or the time allowed changes. A change of bike speed leaves it where you put it.
  const what = `${state.lat},${state.lon},${state.minutes}`;
  const bounds = [data.transit.bounds, data.bike.bounds].filter(Boolean);
  if (fitted !== what && bounds.length) { map.fitBounds(L.latLngBounds(bounds.flat()), {padding: [12, 12]}); fitted = what; }
  done('complete');
}

const now = {};
async function near(lat, lon) {
  const at = {lat, lon}, best = (await places()).reduce((b, p) => !b || metres(p, at) < metres(b, at) ? p : b, null);
  return best && metres(best, at) < 150 ? best.label : best && metres(best, at) < 2000 ? `a point near ${best.label}` : 'this point';
}
