// The page frame: which of the four pages an address means, and drawing it without loading the site again.
import {diagnose, diagnostics} from './diagnostics.js';
import {$, go} from './ui.js';

const pages = {
  journey: () => import('./journey.js'),
  line: () => import('./line.js'),
  reach: () => import('./reach.js'),
  bike: () => import('./bike.js'),
};

function pageOf(q) {
  if (q.has('line')) return 'line';
  const view = q.get('view');
  return view === 'reach' || view === 'bike' ? view : 'journey';
}

let turn = 0;
async function draw() {
  const q = new URLSearchParams(location.search), name = pageOf(q), mine = ++turn;
  for (const a of document.querySelectorAll('nav a')) {
    const on = a.dataset.view === (name === 'line' ? 'journey' : name);
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.body.dataset.page = name;
  diagnose('view', name);
  const page = await pages[name]();
  if (mine === turn) page.show($('main'), q);
}

// Links inside the site change the address and redraw; everything else is an ordinary link.
document.addEventListener('click', event => {
  const a = event.target.closest?.('a[data-go]');
  if (!a || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
  event.preventDefault();
  go(a.getAttribute('href'));
  scrollTo(0, 0);
});
addEventListener('popstate', draw);
addEventListener('rjt:go', draw);
diagnostics();
draw();
