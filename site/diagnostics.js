const KEY = 'rjt-diagnostics';
let record = () => {};
export const diagnose = (...args) => record(...args);

export function diagnostics() {
  const url = new URL(location.href), setting = url.searchParams.get('debug');
  let enabled = setting === '1';
  try {
    if (setting === '1') localStorage.setItem(KEY, '1');
    if (setting === '0') localStorage.removeItem(KEY);
    enabled = localStorage.getItem(KEY) === '1';
  } catch { /* private storage may be unavailable */ }
  if (setting !== null) {
    url.searchParams.delete('debug');
    history.replaceState(null, '', url);
  }
  if (!enabled) return;

  const visit = crypto.randomUUID();
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.textContent = 'Diagnostics on · Stop';
  indicator.id = 'diagnostics-stop';
  indicator.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2000;padding:5px 8px;background:#fff;color:#111;border:1px solid #111;border-radius:4px;font-size:12px';
  document.body.append(indicator);

  const controller = new AbortController(), options = {capture: true, signal: controller.signal};
  let events = [], sequence = 0, lastFlush = 0;
  function flush() {
    if (!events.length) return;
    lastFlush = performance.now();
    const body = JSON.stringify({visit, sequence: sequence++, events});
    events = [];
    fetch('/api/diagnostics', {method: 'POST', body, keepalive: true}).catch(() => {});
  }
  record = (kind, target, value) => {
    if (events.length >= 48 || !/^[a-z0-9.-]{1,48}$/.test(target)) return;
    events.push([Math.round(performance.now()), kind, target, value ?? null]);
    if (events.length >= 24 && performance.now() - lastFlush > 1500) flush();
  };
  const targetOf = element => {
    const item = element.closest('button, input, select, a, label, [role=option], .leaflet-container');
    if (!item) return null;
    return item.id || item.dataset.view || item.dataset.mode || item.dataset.by ||
      (item.dataset.minutes && 'minutes-' + item.dataset.minutes) ||
      (item.matches('[role=option]') ? (item.closest('.place')?.querySelector('input')?.id || 'suggestion') :
        item.matches('.field__clear') ? (item.closest('.field')?.querySelector('input')?.id || 'clear') :
          item.tagName.toLowerCase());
  };
  document.addEventListener('click', event => {
    const target = event.target instanceof Element && targetOf(event.target);
    if (target) diagnose(event.pointerType === 'touch' ? 'tap' : 'click', target);
  }, options);
  document.addEventListener('input', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement) diagnose('input', target.id || 'input', target.value.length);
  }, options);
  document.addEventListener('change', event => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) diagnose('change', target.id || 'select', target.selectedIndex);
    else if (target instanceof HTMLInputElement && target.type === 'checkbox') diagnose('change', target.id, +target.checked);
  }, options);
  window.addEventListener('error', () => diagnose('error', 'browser'), options);
  window.addEventListener('unhandledrejection', () => diagnose('error', 'promise'), options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); }, options);
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.name.startsWith('rjt.')) diagnose('timing', entry.name, Math.round(entry.duration));
      if (entry.entryType !== 'resource' || entry.responseStatus < 400 || !entry.responseStatus) continue;
      const url = new URL(entry.name);
      if (url.origin !== location.origin) continue;
      const path = url.pathname.split('/')[2];
      if (path && path !== 'diagnostics') diagnose('error', /^api\//.test(url.pathname.slice(1)) ? path : 'data', entry.responseStatus);
    }
  });
  observer.observe({type: 'measure', buffered: true});
  observer.observe({type: 'resource', buffered: true});
  const timer = setInterval(flush, 8000);
  indicator.addEventListener('click', () => {
    diagnose('stop', 'diagnostics');
    flush();
    record = () => {};
    controller.abort();
    observer.disconnect();
    clearInterval(timer);
    try { localStorage.removeItem(KEY); } catch { /* preference unavailable */ }
    indicator.remove();
  }, {once: true});
  diagnose('start', 'diagnostics');
}
