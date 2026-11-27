export const BOUNDS = [50.70, 3.30, 53.60, 7.25];
export const KY = 111320;
export const KX = KY * Math.cos((BOUNDS[0] + BOUNDS[2]) / 2 * Math.PI / 180);
const GRAPH_SCALE = 5, GRAPH_SOUTH = 50, GRAPH_WEST = 3, STRIDE = 64;
const NODE_BITS = 20, NODE_MASK = (1 << NODE_BITS) - 1, NO_NODE = 0xffffffff;
const distance = (a, b) => Math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * KX);
// A point further than this from any path is off the map (the sea, or over the border): no bike route.
const SNAP_LIMIT = 500;
// The search gives up beyond this many times the straight line (or 5 km more on short trips). Bridges over the big
// rivers can make a ride four or five times longer than the straight line.
const DETOUR = 5;

export function tileKeys(lat, lon, radius) {
  const r0 = Math.floor((lat - radius / KY - GRAPH_SOUTH) * GRAPH_SCALE);
  const r1 = Math.floor((lat + radius / KY - GRAPH_SOUTH) * GRAPH_SCALE);
  const c0 = Math.floor((lon - radius / KX - GRAPH_WEST) * GRAPH_SCALE);
  const c1 = Math.floor((lon + radius / KX - GRAPH_WEST) * GRAPH_SCALE);
  const keys = [];
  for (let r = Math.max(0, r0); r <= Math.min(STRIDE - 1, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(STRIDE - 1, c1); c++) keys.push(r * STRIDE + c);
  }
  return keys;
}

function decode(buffer) {
  const contents = new Uint32Array(buffer);
  const n = contents[0], m = contents[1];
  return {
    lat: contents.subarray(2, 2 + n), lon: contents.subarray(2 + n, 2 + 2 * n),
    offset: contents.subarray(2 + 2 * n, 3 + 3 * n),
    edge: contents.subarray(3 + 3 * n, 3 + 3 * n + m),
    cost: contents.subarray(3 + 3 * n + m),
  };
}

class Queue {
  ids = [];
  scores = [];

  push(id, score) {
    const {ids, scores} = this;
    let i = ids.length;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= score) break;
      ids[i] = ids[parent]; scores[i] = scores[parent];
      i = parent;
    }
    ids[i] = id; scores[i] = score;
  }

  pop() {
    const {ids, scores} = this;
    const first = [ids[0], scores[0]];
    const id = ids.pop(), score = scores.pop();
    if (!ids.length) return first;
    let i = 0;
    while (2 * i + 1 < ids.length) {
      let j = 2 * i + 1;
      if (j + 1 < ids.length && scores[j + 1] < scores[j]) j++;
      if (scores[j] >= score) break;
      ids[i] = ids[j]; scores[i] = scores[j];
      i = j;
    }
    ids[i] = id; scores[i] = score;
    return first;
  }
}

const lat = (t, i) => (t.lat[i] & 0x7fffffff) / 1e6;
const lon = (t, i) => t.lon[i] / 1e6;

export class Bike {
  constructor(keys, readTile) {
    this.available = new Set(keys);
    this.readTile = readTile;
    this.tiles = new Map();
  }

  async load(key) {
    if (!this.available.has(key)) return null;
    if (!this.tiles.has(key)) this.tiles.set(key, this.readTile(key).then(decode));
    const tile = await this.tiles.get(key);
    this.tiles.set(key, tile);
    return tile;
  }

  async preload(keys) {
    const present = keys.filter(k => this.available.has(k) && !this.tiles.has(k));
    for (let i = 0; i < present.length; i += 4) await Promise.all(present.slice(i, i + 4).map(k => this.load(k)));
  }

  async snap(point) {
    let best = SNAP_LIMIT * SNAP_LIMIT, node = NO_NODE;
    const keys = tileKeys(...point, SNAP_LIMIT);
    await this.preload(keys);
    for (const key of keys) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      for (let i = 0; i < tile.lat.length; i++) {
        if (!(tile.lat[i] >>> 31)) continue;
        const dx = (lon(tile, i) - point[1]) * KX, dy = (lat(tile, i) - point[0]) * KY;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; node = (key << NODE_BITS) + i; }
      }
    }
    return [node, Math.sqrt(best)];
  }

  async search(start, budget, end = NO_NODE, visit) {
    const queue = new Queue(), states = new Map();
    const route = end !== NO_NODE;
    const goal = route ? this.tiles.get(end >>> NODE_BITS) : null;
    const target = route ? [lat(goal, end & NODE_MASK), lon(goal, end & NODE_MASK)] : null;
    function state(key, tile) {
      let s = states.get(key);
      if (!s) {
        const costs = new Float64Array(tile.lat.length).fill(Infinity);
        const prev = route ? new Uint32Array(tile.lat.length).fill(NO_NODE) : null;
        s = {costs, prev};
        states.set(key, s);
      }
      return s;
    }
    // Round down the lower bound to allow for the sub-metre coordinate quantisation.
    const estimate = route ? (t, i) => Math.max(0, Math.hypot(
      (lat(t, i) - target[0]) * KY, (lon(t, i) - target[1]) * KX) - 0.2) : () => 0;
    const key = start >>> NODE_BITS, i = start & NODE_MASK;
    const initial = this.tiles.get(key);
    state(key, initial).costs[i] = 0;
    queue.push(start, estimate(initial, i));
    while (queue.ids.length) {
      const [node, score] = queue.pop();
      if (score > budget) break;
      const key = node >>> NODE_BITS, i = node & NODE_MASK;
      const tile = this.tiles.get(key);
      const here = states.get(key).costs[i];
      if (score > here + estimate(tile, i)) continue;
      if (node === end) {
        const path = [];
        for (let at = end; at !== NO_NODE;) {
          const key = at >>> NODE_BITS, i = at & NODE_MASK, t = this.tiles.get(key);
          path.push([lat(t, i), lon(t, i)]);
          at = states.get(key).prev[i];
        }
        return {metres: here, path: path.reverse()};
      }
      if (visit) visit(lat(tile, i), lon(tile, i));
      for (let e = tile.offset[i]; e < tile.offset[i + 1]; e++) {
        const next = tile.edge[e], k = next >>> NODE_BITS, j = next & NODE_MASK;
        const cost = here + tile.cost[e] / 100;
        if (cost > budget) continue;
        const t = this.tiles.get(k) ?? await this.load(k);
        if (!t) throw new Error('Missing connected cycle tile');
        const s = state(k, t);
        if (cost >= s.costs[j]) continue;
        const priority = cost + estimate(t, j);
        if (priority > budget) continue;
        s.costs[j] = cost;
        if (route) s.prev[j] = node;
        queue.push(next, priority);
      }
    }
    return null;
  }

  async route(a, b) {
    const [start, access] = await this.snap(a);
    const [end, exit] = await this.snap(b);
    if (start === NO_NODE || end === NO_NODE) return {metres: null, path: []};
    const straight = distance(a, b);
    const result = await this.search(start, Math.max(DETOUR * straight, straight + 5000), end);
    if (!result) return {metres: null, path: []};
    return {metres: Math.round(result.metres + access + exit), path: [a, ...result.path, b]};
  }

  async reach(point, metres, visit) {
    const [start, access] = await this.snap(point);
    if (start === NO_NODE || access > metres) return;
    await this.search(start, metres - access, NO_NODE, visit);
  }
}
