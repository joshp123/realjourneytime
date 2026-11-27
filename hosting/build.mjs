import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const server = join(dist, 'server');
const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'};
const assets = {};

async function embed(directory, prefix = '') {
  for (const file of await readdir(directory, {withFileTypes: true})) {
    if (file.name.startsWith('.') || file.isSymbolicLink()) continue;
    const source = join(directory, file.name), key = `${prefix}/${file.name}`;
    if (file.isDirectory()) await embed(source, key);
    else {
      const type = types[extname(file.name)];
      if (!type) throw new Error(`Specify a MIME type for ${key}`);
      assets[key] = [type, (await readFile(source)).toString('base64')];
    }
  }
}

await embed(join(root, 'site'));
if (!assets['/index.html']) throw new Error('The real site has no index.html');
// Pin the browser's local scripts and styles to the content of this build.
const prefix = '/assets/' + createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
const [type, document] = assets['/index.html'];
const html = Buffer.from(document, 'base64').toString('utf8').replace(
  /((?:src|href)=")([^"]+\.(?:js|css))"/g,
  (tag, attribute, file) => Object.hasOwn(assets, '/' + file) ? `${attribute}${prefix}/${file}"` : tag,
);
assets['/index.html'] = [type, Buffer.from(html).toString('base64')];
await rm(dist, {recursive: true, force: true});
await mkdir(server, {recursive: true});
await mkdir(join(dist, '.openai'));
await cp(join(root, '.openai', 'hosting.json'), join(dist, '.openai', 'hosting.json'));
await cp(join(root, 'site', 'stats.js'), join(server, 'stats.js'));
for (const file of ['timings.mjs', 'bike.mjs', 'reach.mjs', 'request-timing.mjs']) {
  await cp(join(root, 'hosting', file), join(server, file));
}
const source = await readFile(join(root, 'hosting', 'worker.mjs'), 'utf8');
await writeFile(join(server, 'index.js'), source
  .replace('/*ASSETS*/ {}', () => JSON.stringify(assets))
  .replace('/*ASSET_PREFIX*/ null', () => JSON.stringify(prefix)));
console.log(`Built Sites Worker with ${Object.keys(assets).length} web assets.`);
