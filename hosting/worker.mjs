import {Bike, BOUNDS} from './bike.mjs';
import {reach} from './reach.mjs';
import {chart, plannerLegs} from './timings.mjs';

const ASSETS = /*ASSETS*/ {};
const RELEASE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z0-9_.-]+$/;
const MAX_OBJECT = 32 * 1024 * 1024;
const CACHE = 'private, max-age=300';
const json = (data, status = 200, cache = 'no-store') =>
  Response.json(data, {status, headers: {'Cache-Control': cache}});
const missing = () => json({error: 'Not found'}, 404);

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

async function serveObject(request, bucket, key) {
  const object = await bucket.get(key);
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

async function data(request, env, url, object) {
  if (!env.DATA) return json({error: 'No R2 binding'}, 503);
  const active = await env.DATA.get('active');
  const release = active && await active.text();
  if (!release || !RELEASE.test(release)) return json({error: 'Journey data has yet to be uploaded'}, 503);
  const prefix = `releases/${release}/`;
  if (object) {
    const response = await serveObject(request, env.DATA, prefix + object);
    if (response.status === 404 && /^public\/planner\/\d+\//.test(object)) {
      return json({stops: [], routes: {}}, 200, CACHE);
    }
    return response;
  }
  const load = async key => {
    const object = await env.DATA.get(prefix + key);
    return object ? new Response(ungzip(object.body)) : null;
  };
  const loadJson = async key => (await load(key))?.json();
  const loadBinary = async key => {
    const response = await load(key);
    if (!response) throw new Error('Missing map data');
    return response.arrayBuffer();
  };
  const bike = async () => new Bike((await loadJson('public/bike/index.json.gz')).tiles,
    key => loadBinary(`public/bike/${key}.bin.gz`));
  const q = Object.fromEntries(url.searchParams);
  switch (url.pathname) {
    case '/api/route': {
      if (!q.key || !KEY.test(q.key)) return missing();
      return serveObject(request, env.DATA, prefix + `route/${q.key}.json.gz`);
    }
    case '/api/journeys': {
      if (!q.route || !KEY.test(q.route) || !q.from || !q.to) return json({error: 'Supply a route and two stops'}, 400);
      if (q.days && !['weekdays', 'saturday', 'sunday'].includes(q.days)) return json({error: 'Invalid day type'}, 400);
      if ([q.start, q.end].some(value => value && !/^\d{4}-\d{2}-\d{2}$/.test(value))) return json({error: 'Invalid date'}, 400);
      const index = await loadJson('public/index.json.gz');
      const answer = await chart(loadJson, env.DATA, prefix, index, q);
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
      return json(await plannerLegs(loadJson, env.DATA, prefix, queries), 200, CACHE);
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
      return json(await reach(loadJson, loadBinary, await bike(), point, hour, minutes, kmh), 200, CACHE);
    }
    default: return missing();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__data/')) return upload(request, env, url.pathname);
    if (!['GET', 'HEAD'].includes(request.method)) return json({error: 'Use GET or HEAD'}, 405);
    const asset = ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
    if (asset) return new Response(request.method === 'HEAD' ? null : decode(asset[1]), {
      headers: {'Content-Type': asset[0], 'Cache-Control': 'private, max-age=0, must-revalidate'},
    });
    if (url.pathname === '/favicon.ico') return new Response(null, {status: 204});
    const object = objectPath(url.pathname);
    if (!object && !url.pathname.startsWith('/api/')) return missing();
    try {
      return await data(request, env, url, object);
    } catch (error) {
      console.error('Journey data request failed', url.pathname, String(error.message));
      return json({error: 'Journey data unavailable'}, 502);
    }
  },
};
