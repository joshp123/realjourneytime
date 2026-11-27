// Run the built Worker in Node against a pretend R2 bucket holding real packed line files.
// node hosting/build.mjs, then: node tests/worker.mjs "$PWD/dist" <a directory packed by hosting/pack_lines.mjs>
import {readFileSync, existsSync, statSync, openSync, readSync, closeSync} from 'node:fs';
const [dist, pack] = process.argv.slice(2);
const worker = (await import(dist + '/server/index.js')).default;
const fileOf = key => key === 'active' ? null : pack + '/' + key.replace(/^releases\/test\//, '');
const DATA = {async get(key, options) {
  if (key === 'active') return {size: 4, arrayBuffer: async () => new TextEncoder().encode('test').buffer};
  const f = fileOf(key);
  if (!existsSync(f)) return null;
  let body = readFileSync(f);
  if (options?.range) body = body.subarray(options.range.offset, options.range.offset + options.range.length);
  return {size: body.length, httpEtag: '"x"', arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), body: new Blob([body]).stream()};
}};
for (const [path, gzip] of [['/api/line?key=GVB-2', true], ['/api/line-day?key=GVB-2&date=2026-03-10', true], ['/api/line-day?key=GVB-2&date=2026-03-10', false], ['/api/line-day?key=GVB-2&date=1999-01-01', true], ['/api/line?key=NOPE', true]]) {
  const r = await worker.fetch(new Request('https://x.test' + path, {headers: gzip ? {'Accept-Encoding': 'gzip'} : {}}), {DATA});
  let text = '';
  if (r.ok) {
    const raw = new Uint8Array(await r.arrayBuffer());
    const plain = r.headers.get('Content-Encoding') === 'gzip' ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : raw;
    const j = JSON.parse(new TextDecoder().decode(plain));
    text = `${raw.length} bytes sent, ${j.journeys ? j.journeys.length + ' journeys' : j.directions.length + ' directions, ' + j.dates.length + ' dates'}`;
  }
  console.log(r.status, path, gzip ? 'gzip' : 'plain', text, r.headers.get('Server-Timing')?.slice(0, 60));
}
