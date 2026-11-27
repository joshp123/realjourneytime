// The line page's answers for the hosted site, where the Worker can only read ready-made files:
//   line/<key>.json.gz   the /api/line answer, plus `ranges`: where each date's journeys are in the .bin
//   line/<key>.bin       one gzipped /api/line-day answer after another, in date order
// Run after pipeline/packed.mjs: node hosting/pack_lines.mjs <the pack.py output directory>
// (RJT_DATA names the source build, as for packed.mjs.)
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {DATA, open} from '../pipeline/packed.mjs';
import {lineDay, lineSummary} from '../pipeline/lines.mjs';

const out = join(process.argv[2] ?? '', 'line');
if (!process.argv[2]) throw new Error('Name the pack.py output directory');
mkdirSync(out, {recursive: true});
const {routes} = JSON.parse(readFileSync(new URL('packed/network.json', DATA)));
let bytes = 0, done = 0;
for (const entry of routes) {
  const route = open(entry), summary = lineSummary(route), ranges = [], blocks = [];
  let offset = 0;
  for (const date of summary.dates) {
    const block = gzipSync(JSON.stringify(lineDay(route, date)), {level: 6});
    ranges.push([offset, block.length]);
    blocks.push(block);
    offset += block.length;
  }
  const head = gzipSync(JSON.stringify({...summary, ranges}), {level: 6});
  writeFileSync(join(out, `${entry.key}.json.gz`), head);
  writeFileSync(join(out, `${entry.key}.bin`), Buffer.concat(blocks));
  bytes += head.length + offset;
  if (++done % 200 === 0) console.log(`${done} of ${routes.length} lines, ${(bytes / 1e6).toFixed(0)} MB`);
}
console.log(`${done} lines, ${2 * done} objects, ${bytes.toLocaleString('en-GB')} bytes`);
