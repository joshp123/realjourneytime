// What the pages share: how times, dates and counts are written, the bike speed control and the search box.

export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const pad = n => String(n).padStart(2, '0');
// A time of day from seconds since midnight, as a clock shows it (the minute it is in); times wrap at midnight.
export const clock = s => { s = ((s % 86400) + 86400) % 86400; return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`; };
export const thousands = v => v.toLocaleString('en-GB');
export const dateLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
export const DAYS = {weekdays: 'weekdays', saturday: 'Saturdays', sunday: 'Sundays'};
export const SPEEDS = [15, 20, 25, 45];
export const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// "17" and "min", or "1 h 34" and nothing, so the two can be set in different sizes.
export const span = v => v >= 60 ? [`${Math.floor(v / 60)} h ${pad(Math.round(v % 60))}`, ''] : [String(Math.round(v)), 'min'];
export const minutes = v => span(v).join(' ').trim();

// The address of a page, from what it shows. Empty values are left out.
export function address(values) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v != null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : './';
}

// Go to another page of the site without loading it again. app.js draws the page for the new address.
export function go(values, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', typeof values === 'string' ? values : address(values));
  dispatchEvent(new Event('rjt:go'));
}

export const speedControl = kmh => `<span>Bike</span>${SPEEDS.map(k => `<button type="button" data-kmh="${k}" class="${k === kmh ? 'on' : ''}" aria-pressed="${k === kmh}">${k}</button>`).join('')}<span>km/h</span>`;

// A search box with a list under it. `suggest(text)` gives rows {label, small, off, value}; `pick(value)` is
// called with the chosen row's value. Typing into a box that shows a choice replaces it: the old text is
// selected when the tap that focused the box ends (Safari drops a selection made on focus itself).
export function searchBox(input, list, suggest, pick) {
  let rows = [], active = -1, untouched = false, tapped = false, turn = 0, shown = '', closing = 0;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); rows = []; active = -1; };
  const paint = head => {
    list.innerHTML = (head ? `<div class="head">${esc(head)}</div>` : '') + rows.map((r, i) =>
      `<div class="row${i === active ? ' on' : ''}${r.off ? ' off' : ''}" role="option" data-i="${i}"><span>${esc(r.label)}</span><small>${esc(r.small || '')}</small></div>`).join('');
    list.hidden = !rows.length;
    input.setAttribute('aria-expanded', String(rows.length > 0));
  };
  const ask = async () => {
    const mine = ++turn, found = await suggest(untouched ? '' : input.value.trim());
    if (mine !== turn || document.activeElement !== input) return;
    rows = found.rows; active = rows.findIndex(r => !r.off);
    paint(found.head);
  };
  const choose = i => { const row = rows[i]; if (!row || row.off) return; shown = row.label; close(); input.blur(); pick(row.value); };
  input.addEventListener('focus', () => { clearTimeout(closing); untouched = true; tapped = false; shown = input.value; ask(); });
  input.addEventListener('click', () => { if (untouched && !tapped) input.select(); tapped = true; });
  input.addEventListener('input', () => { untouched = false; ask(); });
  // Leaving the box without choosing puts back what it showed.
  input.addEventListener('blur', () => { input.value = shown; closing = setTimeout(close, 150); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      for (let i = active + step; i >= 0 && i < rows.length; i += step) if (!rows[i].off) { active = i; break; }
      paint(list.querySelector('.head')?.textContent);
    } else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
    else if (event.key === 'Escape') { close(); input.blur(); }
  });
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('click', event => { const row = event.target.closest('.row'); if (row) choose(+row.dataset.i); });
}
