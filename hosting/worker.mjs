import {Bike, BOUNDS} from './bike.mjs';
import {reach} from './reach.mjs';
import {chart, plannerLegs} from './timings.mjs';
import {requestTiming} from './request-timing.mjs';

const ASSETS = /*ASSETS*/ {};
const ASSET_PREFIX = /*ASSET_PREFIX*/ null;
const RELEASE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z0-9_.-]+$/;
const MAX_OBJECT = 32 * 1024 * 1024;
const CACHE = 'private, max-age=300';
const json = (data, status = 200, cache = 'no-store') =>
  Response.json(data, {status, headers: {'Cache-Control': cache}});
const missing = () => json({error: 'Not found'}, 404);
const VISIT_EVENTS = new Set(['start', 'stop', 'click', 'tap', 'input', 'change', 'view', 'place', 'error', 'timing',
  'map-dragstart', 'map-dragend', 'map-zoomstart', 'map-zoomend', 'map-click', 'reach-origin']);

async function diagnostics(request, url) {
  if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return missing();
  const length = Number(request.headers.get('Content-Length'));
  if (!Number.isInteger(length) || length < 1 || length > 8192) return json({error: 'Invalid diagnostic batch size'}, 413);
  let visit, sequence, events;
  try { ({visit, sequence, events} = await request.json()); } catch { return json({error: 'Invalid diagnostic batch'}, 400); }
  const number = value => Number.isInteger(value) && value >= 0 && value <= 2 ** 31 - 1;
  if (typeof visit !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(visit) ||
      !number(sequence) || !Array.isArray(events) || !events.length || events.length > 48 ||
      events.some(row => !Array.isArray(row) || row.length !== 4 || !number(row[0]) ||
        !VISIT_EVENTS.has(row[1]) || typeof row[2] !== 'string' || !/^[a-z0-9.-]{1,48}$/.test(row[2]) ||
        (row[3] !== null && !number(row[3])))) return json({error: 'Invalid diagnostic batch'}, 400);
  console.log(JSON.stringify({event: 'rjt.visit', visit, sequence, events}));
  return new Response(null, {status: 204, headers: {'Cache-Control': 'no-store'}});
}

function validPoint(point) {
  const [s, w, n, e] = BOUNDS, [lat, lon] = point;
  return point.length === 2 && Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= s && lat <= n && lon >= w && lon <= e;
}

const decode = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));
const ungzip = stream => stream.pipeThrough(new DecompressionStream('gzip'));

function objectPath(pathname) {
  if (pathname === '/data/index.json' || pathname === '/data/bike-pairs.json' ||
      pathname === '/data/bike/index.json' ||
      /^\/data\/(?:history\/[\w.-]+\.json|planner\/(?:\d+\/\d+|meta|trains|places)\.json|bike-comparison\/(?:12|15|20|25|45)\/(?:all|train|metro|tram|bus)\.json|bike\/\d+\.bin)$/.test(pathname)) {
    return 'public/' + pathname.slice('/data/'.length) + '.gz';
  }
  return null;
}

async function serveObject(request, timing, key) {
  const object = await timing.read(key, undefined, false);
  if (!object) return missing();
  const headers = {
    'Content-Type': key.endsWith('.json.gz') ? 'application/json; charset=utf-8' : 'application/octet-stream',
    'Cache-Control': CACHE, 'ETag': object.httpEtag, 'Vary': 'Accept-Encoding',
  };
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    await object.body.cancel();
    return new Response(null, {status: 304, headers});
  }
  const gzip = /\bgzip\b/.test(request.headers.get('Accept-Encoding') ?? '');
  if (gzip) headers['Content-Encoding'] = 'gzip';
  if (request.method === 'HEAD') await object.body.cancel();
  return new Response(request.method === 'HEAD' ? null : gzip ? object.body : ungzip(object.body),
    {headers, encodeBody: 'manual'});
}

async function upload(request, env, pathname) {
  const token = env.DATA_PUBLISH_TOKEN;
  if (!token || request.headers.get('Authorization') !== `Bearer ${token}`) return missing();
  if (request.method !== 'PUT') return json({error: 'Use PUT'}, 405);
  if (!env.DATA) return json({error: 'No R2 binding'}, 503);
  const key = pathname.slice('/__data/'.length);
  const [release, ...parts] = key.split('/');
  if (!RELEASE.test(release) || parts.some(p => !KEY.test(p) || p === '.' || p === '..')) return missing();
  const length = Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_OBJECT) {
    return json({error: 'Use a known body length of up to 32 MiB'}, 413);
  }
  if (parts.length === 1 && parts[0] === 'activate') {
    if (!await env.DATA.head(`releases/${release}/public/index.json.gz`)) {
      return json({error: 'The release has no index'}, 409);
    }
    await env.DATA.put('active', release);
  } else if (parts.length >= 2 && ['public', 'route', 'calls', 'grid', 'reach'].includes(parts[0])) {
    await env.DATA.put(`releases/${key}`, request.body);
  } else return missing();
  return new Response(null, {status: 201, headers: {'Cache-Control': 'no-store'}});
}

async function data(request, env, url, object, timing) {
  if (!env.DATA) return json({error: 'No R2 binding'}, 503);
  const active = await timing.read('active');
  const release = active && new TextDecoder().decode(active);
  if (!release || !RELEASE.test(release)) return json({error: 'Journey data has yet to be uploaded'}, 503);
  const prefix = `releases/${release}/`;
  if (object) {
    const response = await serveObject(request, timing, prefix + object);
    if (response.status === 404 && /^public\/planner\/\d+\//.test(object)) {
      return json({stops: [], routes: {}}, 200, CACHE);
    }
    return response;
  }
  const read = (key, options) => timing.read(prefix + key, options);
  const load = async key => {
    const body = await read(key);
    return body && await timing.unzip(body);
  };
  const loadJson = async key => {
    const body = await load(key);
    return body && JSON.parse(new TextDecoder().decode(body));
  };
  const loadBinary = async key => {
    const body = await load(key);
    if (!body) throw new Error('Missing map data');
    return body;
  };
  const calls = {read, unzip: timing.unzip};
  const bike = async () => new Bike((await loadJson('public/bike/index.json.gz')).tiles,
    key => loadBinary(`public/bike/${key}.bin.gz`));
  const q = Object.fromEntries(url.searchParams);
  switch (url.pathname) {
    case '/api/route': {
      if (!q.key || !KEY.test(q.key)) return missing();
      return serveObject(request, timing, prefix + `route/${q.key}.json.gz`);
    }
    case '/api/journeys': {
      if (!q.route || !KEY.test(q.route) || !q.from || !q.to) return json({error: 'Supply a route and two stops'}, 400);
      if (q.days && !['weekdays', 'saturday', 'sunday'].includes(q.days)) return json({error: 'Invalid day type'}, 400);
      if ([q.start, q.end].some(value => value && !/^\d{4}-\d{2}-\d{2}$/.test(value))) return json({error: 'Invalid date'}, 400);
      const answer = await chart(loadJson, calls, q);
      return answer ? json(answer, 200, CACHE) : missing();
    }
    case '/api/planner-legs': {
      if (!['weekdays', 'saturday', 'sunday'].includes(q.days)) return json({error: 'Invalid day type'}, 400);
      const legs = url.searchParams.getAll('leg');
      if (legs.length > 128) return json({error: 'Use at most 128 legs per request'}, 400);
      const queries = [];
      for (const spec of legs) {
        const [route, from, to, low, high, ...extra] = spec.split(',');
        const lo = Number(low), hi = Number(high);
        if (!KEY.test(route) || !from || !to || !low || !high || extra.length ||
            !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
          return json({error: 'Invalid leg'}, 400);
        }
        queries.push({route, from, to, lo, hi, days: q.days});
      }
      return json(await plannerLegs(loadJson, calls, queries), 200, CACHE);
    }
    case '/api/bike-route': {
      const a = (q.a ?? '').split(',').map(Number), b = (q.b ?? '').split(',').map(Number);
      if (!validPoint(a) || !validPoint(b)) return json({error: 'Choose two points in the Netherlands'}, 400);
      return json(await (await bike()).route(a, b), 200, CACHE);
    }
    case '/api/reach': {
      const point = [Number(q.lat), Number(q.lon)];
      const hour = Number(q.hour ?? 8), minutes = Number(q.minutes ?? 30), kmh = Number(q.kmh ?? 15);
      if (!validPoint(point) || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
          !(minutes > 0 && minutes <= 60) || !(kmh > 0 && kmh <= 45)) {
        return json({error: 'Choose a valid origin, hour, cycling speed and time budget'}, 400);
      }
      return json(await reach(loadJson, loadBinary, bike(), point, hour, minutes, kmh), 200, CACHE);
    }
    default: return missing();
  }
}

export default {
  async fetch(request, env) {
    const timing = requestTiming(env.DATA);
    const url = new URL(request.url);
    const object = objectPath(url.pathname);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const versioned = path.match(/^\/assets\/[a-f0-9]{16}(\/.*\.(?:js|css))$/);
    const file = versioned?.[1] ?? path;
    const asset = Object.hasOwn(ASSETS, file) ? ASSETS[file] : null;
    const immutable = versioned && path === ASSET_PREFIX + file;
    let route = 'unknown', response;
    try {
      if (path.startsWith('/__data/')) {
        route = 'upload';
        response = await upload(request, env, path);
      } else if (path === '/api/diagnostics') {
        route = path;
        response = await diagnostics(request, url);
      } else if (!['GET', 'HEAD'].includes(request.method)) response = json({error: 'Use GET or HEAD'}, 405);
      else if (asset) {
        route = file;
        response = new Response(request.method === 'HEAD' ? null : decode(asset[1]), {
          headers: {'Content-Type': asset[0],
            'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate'},
        });
      } else if (path === '/favicon.ico') {
        route = path;
        response = new Response(null, {status: 204});
      } else if (object || ['/api/route', '/api/journeys', '/api/planner-legs', '/api/bike-route', '/api/reach'].includes(path)) {
        route = object ? '/data/' + path.split('/')[2] : path;
        response = await data(request, env, url, object, timing);
      } else response = missing();
    } catch (error) {
      console.error('Journey data request failed', route, String(error.message));
      response = json({error: 'Journey data unavailable'}, 502);
    }
    return timing.finish(request, route, response);
  },
};
