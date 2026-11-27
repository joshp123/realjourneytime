// Where the bike wins: the share of trips the bike is quicker on, by train, metro, tram and bus, and the
// biggest win on each line. The tables are worked out when the data is built (hosting/bike_table.py).
import {SURE} from './chart.js';
import {json} from './data.js';
import {$, address, esc, go, minutes, speedControl, thousands} from './ui.js';
import {timeView} from './view-timing.js';

const MODES = {train: 'Train', metro: 'Metro', tram: 'Tram', bus: 'Bus'};
const share = (wins, total) => { const p = 100 * wins / total; return p >= 10 ? Math.round(p) : p >= 0.95 ? p.toFixed(0) : p >= 0.05 ? p.toFixed(1) : '0'; };
const town = t => t === "'s-Gravenhage" ? 'Den Haag' : t;
const short = label => label.replace(/, [^,]+$/, '');

const FRAME = `
  <div class="bikehead bar"><h1 id="bike-title">&nbsp;</h1><div class="speed" id="speed"></div></div>
  <section class="bars" id="bars"></section>
  <p class="count" id="bike-count"></p>
  <table class="wins" id="wins"></table>
  <p class="none" id="none" hidden></p>
  <details class="more"><summary>Data and methods</summary>
    <p>A trip is two stops on one line with at least 100 recorded journeys on weekdays. The bike wins when it is quicker than the time that was enough for nine journeys in ten.</p>
    <p>The list leaves out hops under a kilometre, and trips where a missed bus, not a slow line, sets the nine-in-ten time.</p>
    <p>The bike takes the shortest legal route on OpenStreetMap, with ferries that run all year, at the speed you choose. Traffic lights and parking are not counted.</p>
  </details>`;

let turn = 0;
export async function show(root, q) {
  const mine = ++turn, done = timeView('bike');
  const kmh = [15, 20, 25, 45].includes(+q.get('kmh')) ? +q.get('kmh') : 15, mode = MODES[q.get('mode')] ? q.get('mode') : 'all';
  const link = change => address({view: 'bike', kmh: kmh === 15 ? null : kmh, mode: mode === 'all' ? null : mode, ...change});
  if (!$('bars')) root.innerHTML = FRAME;
  $('speed').innerHTML = speedControl(kmh);
  $('speed').onclick = event => { const k = event.target.dataset?.kmh; if (k) go(link({kmh: k === '15' ? null : k}), true); };
  let table;
  try { table = await json(`data/bike-comparison/${kmh}/${mode}.json`); } catch (error) {
    if (mine !== turn) return;
    $('bars').innerHTML = '<div class="msg"><span>The bike table did not load.</span><button class="btn" type="button" id="again">Try again</button></div>';
    $('again').onclick = () => show(root, q);
    return done('error');
  }
  if (mine !== turn) return;
  $('bike-title').innerHTML = `The bike beats public transport on <b class="k-bike">${share(table.wins, table.total)}%</b> of trips`;
  $('bars').innerHTML = Object.entries(MODES).map(([k, name]) => { const v = table.byMode[k] || {wins: 0, total: 1};
    return `<a class="r ${mode === k ? 'on' : ''}" href="${link({mode: mode === k ? null : k})}" data-go><span>${name}</span><span class="track"><span class="fill" style="width:${100 * v.wins / v.total}%"></span></span><span class="pc">${share(v.wins, v.total)}%</span></a>`; }).join('');
  $('bike-count').textContent = `Counted over ${thousands(table.total)} pairs of stops on one line, on weekdays. If everything ran to timetable: ${share(table.timetableWins, table.total)}%.`;
  done('answer');
  const rows = table.lines.slice(0, 12).map(r => Object.fromEntries(table.fields.map((f, i) => [f, r[i]])));
  $('none').hidden = rows.length > 0;
  $('wins').hidden = !rows.length;
  if (!rows.length) $('none').innerHTML = `At ${kmh} km/h the bike wins no ${MODES[mode].toLowerCase()} trip.${kmh < 25 ? ` <a href="${link({kmh: 25})}" data-go>Try 25 km/h</a>.` : ''}`;
  else {
    const t = v => minutes(v);
    $('wins').innerHTML = `<tr><th>Biggest ${mode === 'all' ? '' : MODES[mode].toLowerCase() + ' '}wins, one for each line${mode === 'all' ? '' : ` · <a href="${link({mode: null})}" data-go>Show all</a>`}</th><th>Bike</th><th>${SURE}</th><th class="hide">Timetable</th><th>Saves</th><th></th></tr>` + rows.map(r => {
      const bike = Math.round(r.km / kmh * 60), sure = Math.ceil(r.p90 - 1e-9);
      const where = !r.from_town ? '' : ', ' + (town(r.from_town) === town(r.to_town) || !r.to_town ? town(r.from_town) : `${town(r.from_town)} to ${town(r.to_town)}`);
      const line = r.mode === 'train' ? r.label.replace(/ \d+$/, '') : `${MODES[r.mode]} ${r.label}`;
      return `<tr data-href="${address({from: r.from_place, to: r.to_place, kmh: kmh === 15 ? null : kmh})}"><td><a href="${address({from: r.from_place, to: r.to_place, kmh: kmh === 15 ? null : kmh})}" data-go>${esc(short(r.from_place))} to ${esc(short(r.to_place))}</a><small>${esc(line + where)}</small></td>
        <td class="g">${t(bike)}</td><td>${t(sure)}</td><td class="hide">${t(r.timetable)}</td><td class="g">${t(sure - bike)}</td><td class="go">›</td></tr>`; }).join('');
    $('wins').onclick = event => { const row = event.target.closest('tr[data-href]'); if (row && !event.target.closest('a')) { go(row.dataset.href); scrollTo(0, 0); } };
  }
  done('complete');
}
