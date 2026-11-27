// One kind of map on every page: grey, so the lines carry the colour, and it only moves when you move it.
import {diagnose} from './diagnostics.js';
import {token} from './ui.js';

export function baseMap(id) {
  const m = L.map(id, {zoomControl: innerWidth > 700, zoomSnap: 0.25});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18}).addTo(m);
  for (const name of ['dragstart', 'dragend', 'zoomstart', 'zoomend', 'click']) m.on(name, () => diagnose('map-' + name, id, m.getZoom()));
  return m;
}

export const pin = (letter, cls = '') => L.divIcon({className: '', html: `<div class="pin ${cls}">${letter}</div>`, iconSize: [26, 26], iconAnchor: [13, 13]});

export function mapKey(m, name) {
  const key = L.control({position: 'bottomleft'});
  key.onAdd = () => { const el = L.DomUtil.create('div', 'mapkey'); el.innerHTML = `<i class="pt"></i>${name}<i class="bk"></i>Bike`; return el; };
  return key.addTo(m);
}

export const routeLine = points => L.polyline(points, {color: token('--sure'), weight: 5, opacity: 0.95});
export const bikeLine = points => L.polyline(points, {color: token('--bike'), weight: 4, dashArray: '1 8', lineCap: 'round'});
