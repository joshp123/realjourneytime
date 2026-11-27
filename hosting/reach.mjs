import {BOUNDS, KX, KY} from './bike.mjs';

const [S, W, N, E] = BOUNDS;
const DY = 100 / KY, DX = 100 / KX;
const ROWS = Math.floor((N - S) / DY) + 1, COLS = Math.floor((E - W) / DX) + 1;
const PIXELS = 128, WALK = 80, BOARD_WITHIN = 1000;
const row = lat => Math.trunc((N - lat) / DY);
const col = lon => Math.trunc((lon - W) / DX);

class Mask {
  tiles = new Map();

  set(r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
    const key = `${r >> 7}/${c >> 7}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Uint8Array(PIXELS * PIXELS);
      this.tiles.set(key, tile);
    }
    tile[(r & 127) * PIXELS + (c & 127)] = 1;
  }

  circle(lat, lon, radius) {
    const r0 = Math.max(0, row(lat + radius / KY)), r1 = Math.min(ROWS - 1, row(lat - radius / KY));
    const c0 = Math.max(0, col(lon - radius / KX)), c1 = Math.min(COLS - 1, col(lon + radius / KX));
    for (let r = r0; r <= r1; r++) {
      const dy = ((N - (r + 0.5) * DY) - lat) * KY;
      const radiusX = Math.sqrt(radius * radius - dy * dy);
      for (let c = c0; c <= c1; c++) {
        if (Math.abs(((W + (c + 0.5) * DX) - lon) * KX) <= radiusX) this.set(r, c);
      }
    }
  }
}

function transitTiles([lat, lon]) {
  const keys = [];
  for (let r = Math.floor((lat - BOARD_WITHIN / KY) * 10); r <= Math.floor((lat + BOARD_WITHIN / KY) * 10); r++) {
    for (let c = Math.floor((lon - BOARD_WITHIN / KX) * 10); c <= Math.floor((lon + BOARD_WITHIN / KX) * 10); c++) {
      keys.push(`reach/${r}/${c}.json.gz`);
    }
  }
  return keys;
}

async function transit(loadJson, origin, hour, minutes) {
  const origins = (await Promise.all(transitTiles(origin).map(loadJson))).flatMap(rows => rows ?? []);
  const circles = new Map();
  for (const [a, b, destinations] of origins) {
    const walk = Math.hypot((origin[0] - a) * KY, (origin[1] - b) * KX) / WALK;
    if (walk * WALK > BOARD_WITHIN) continue;
    const h = Math.min(23, Math.floor(hour + walk / 60));
    for (const [y, x, ...hours] of destinations) {
      const ride = hours[h], left = minutes - walk - ride;
      if (ride < 0 || left <= 0) continue;
      const key = `${y},${x}`;
      if (left > (circles.get(key)?.[2] ?? 0)) circles.set(key, [y, x, left]);
    }
  }
  const mask = new Mask();
  mask.circle(...origin, minutes * WALK);
  for (const [lat, lon, left] of circles.values()) mask.circle(lat, lon, left * WALK);
  return mask;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crc = Uint32Array.from({length: 256}, (_, i) => {
  for (let j = 0; j < 8; j++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0);
  return i;
});
const encode = new TextEncoder();

function pngChunk(tag, data) {
  const body = new Uint8Array(data.length + 12), view = new DataView(body.buffer);
  view.setUint32(0, data.length);
  body.set(encode.encode(tag), 4);
  body.set(data, 8);
  let check = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) check = (check >>> 8) ^ crc[(check ^ body[i]) & 255];
  view.setUint32(data.length + 8, check ^ 0xffffffff);
  return body;
}

async function png(w, h, pixels, colour) {
  // A PNG with a two-colour palette. A zero byte before each row selects PNG's unfiltered mode.
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, w); view.setUint32(4, h);
  header[8] = 8; header[9] = 3;
  const stream = new Blob([pixels]).stream().pipeThrough(new CompressionStream('deflate'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const bytes = new Uint8Array(await new Blob([SIGNATURE, pngChunk('IHDR', header),
    pngChunk('PLTE', new Uint8Array([0, 0, 0, ...colour])), pngChunk('tRNS', new Uint8Array([0, 255])),
    pngChunk('IDAT', data), pngChunk('IEND', new Uint8Array())]).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:image/png;base64,' + btoa(binary);
}

async function layer(mask, grid, loadBinary, colour, cached) {
  let people = 0, r0 = ROWS, c0 = COLS, r1 = -1, c1 = -1;
  const keys = [...mask.tiles.keys()].filter(key => grid.has(key));
  const parts = [];
  for (let first = 0; first < keys.length; first += 4) {
    await Promise.all(keys.slice(first, first + 4).map(async key => {
      if (!cached.has(key)) cached.set(key, loadBinary(`grid/${key}.bin.gz`).then(buffer => new Uint16Array(buffer)));
      const cells = await cached.get(key), reached = mask.tiles.get(key);
      const [y, x] = key.split('/').map(Number).map(v => v * PIXELS);
      for (let i = 0; i < reached.length; i++) {
        if (reached[i] && cells[i] & 32768) {
          const r = y + (i >> 7), c = x + (i & 127);
          r0 = Math.min(r0, r); r1 = Math.max(r1, r);
          c0 = Math.min(c0, c); c1 = Math.max(c1, c);
          people += cells[i] & 32767;
        } else reached[i] = 0;
      }
      parts.push([y, x, reached]);
    }));
  }
  if (r1 < r0) return {people: 0, png: null, bounds: null};
  const width = c1 - c0 + 1, height = r1 - r0 + 1;
  const image = new Uint8Array((width + 1) * height);
  for (const [y, x, reached] of parts) {
    for (let i = 0; i < reached.length; i++) {
      if (reached[i]) image[(y + (i >> 7) - r0) * (width + 1) + x + (i & 127) - c0 + 1] = 1;
    }
  }
  return {people: Math.round(people / 1000) * 1000, png: await png(width, height, image, colour),
    bounds: [[N - (r1 + 1) * DY, W + c0 * DX], [N - r0 * DY, W + (c1 + 1) * DX]]};
}

export async function reach(loadJson, loadBinary, bike, point, hour, minutes, kmh) {
  const grid = new Set((await loadJson('grid/index.json.gz')).tiles);
  const cache = new Map();
  const bikeMask = new Mask();
  const [transitLayer, bikeLayer] = await Promise.all([
    transit(loadJson, point, hour, minutes).then(mask =>
      layer(mask, grid, loadBinary, [179, 79, 44], cache)),
    bike.reach(point, minutes * kmh * 1000 / 60, (lat, lon) => {
      const r = row(lat), c = col(lon);
      bikeMask.set(r, c);
      bikeMask.set(r - 1, c); bikeMask.set(r + 1, c);
      bikeMask.set(r, c - 1); bikeMask.set(r, c + 1);
    }).then(() => layer(bikeMask, grid, loadBinary, [47, 138, 60], cache)),
  ]);
  return {transit: transitLayer, bike: bikeLayer};
}
