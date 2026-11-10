// Drive the from-chain viewer in a browser and compare what it serves with an independent reader.
//
// usage: node tests/view-check.mjs <viewer address> <folder written by `abxfs-rs read <root> --out <folder>`> [screenshot path]
//   e.g. http://8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0.localhost:8853/
//
// Every file in <folder> is fetched through the viewer's service worker and must have the same SHA-256 as the file
// on disk. Also checked: a missing path is a 404, a directory path redirects to its trailing slash, a byte range is
// honoured, and the info page lists the files.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');

const [address, folder, shot] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function list(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await list(join(dir, e.name)));
    else out.push(join(dir, e.name));
  }
  return out;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })).newPage();
const failures = [];
const t0 = Date.now();
await page.goto(address, { waitUntil: 'load' });
// The start page hands over to the project once the worker controls the origin.
await page.waitForFunction(() => navigator.serviceWorker.controller && !document.querySelector('script[src="/_abxfs/boot.js"]'), null, { timeout: 120000 });
const firstMs = Date.now() - t0;
const title = await page.title();
if (shot) { await page.waitForTimeout(3000); await page.screenshot({ path: shot }); }

const files = await list(folder);
let equal = 0;
for (const f of files) {
  const rel = relative(folder, f).split('/').map(encodeURIComponent).join('/');
  const got = await page.evaluate(async (p) => {
    const r = await fetch('/' + p);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()));
    return { status: r.status, sha: Array.from(d, (x) => x.toString(16).padStart(2, '0')).join(''), root: r.headers.get('x-abxfs-root') };
  }, rel);
  if (got.status === 200 && got.sha === sha(await readFile(f))) equal++;
  else failures.push(`${rel}: status ${got.status}, bytes ${got.sha === sha(await readFile(f)) ? 'equal' : 'different'}`);
}

const extra = await page.evaluate(async () => {
  const missing = await fetch('/no-such-file-here.txt');
  const range = await fetch('/', { headers: { range: 'bytes=0-9' } });
  const whole = await fetch('/');
  const headReq = await fetch('/', { method: 'HEAD', headers: { range: 'bytes=0-9' } });
  // What a hostile project page could try: its own service worker, and a redirect off this origin.
  let worker;
  try { await navigator.serviceWorker.register('/index.html', { scope: '/' }); worker = 'REGISTERED'; } catch { worker = 'refused'; }
  const slashes = await fetch('//' + location.host.replace(/^[^.]+\./, 'elsewhere.') + '/', { redirect: 'manual' }).then((r) => r.type, () => 'failed');
  return {
    missing: missing.status,
    range: [range.status, (await range.arrayBuffer()).byteLength, range.headers.get('content-range'), range.headers.get('content-length')],
    length: [whole.headers.get('content-length'), (await whole.arrayBuffer()).byteLength],
    head: [headReq.status, headReq.headers.get('content-length')],
    worker,
    slashes,
  };
});
if (extra.worker !== 'refused') failures.push('a project page could register its own service worker');
if (Number(extra.length[0]) !== extra.length[1]) failures.push(`content-length ${extra.length[0]} for ${extra.length[1]} bytes`);
if (extra.head[0] !== 200) failures.push(`HEAD with a Range answered ${extra.head[0]}`);
if (extra.missing !== 404) failures.push(`a missing path answered ${extra.missing}`);
if (extra.range[0] !== 206 || extra.range[1] !== 10) failures.push(`a 10-byte range answered ${extra.range}`);

await page.goto(new URL('/_abxfs/info.html', address).href, { waitUntil: 'load' });
await page.waitForFunction(() => !document.querySelector('#files').hidden || /could not|not running|does not name/i.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
const info = { status: await page.textContent('#status'), rows: await page.locator('#files tbody tr').count() };
if (info.rows !== files.length) failures.push(`the info page lists ${info.rows} files, the folder holds ${files.length}`);
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-info.png'), fullPage: true });

console.log(JSON.stringify({ title, firstMs, files: files.length, equal, extra, info, failures }, null, 1));
await browser.close();
process.exit(failures.length ? 1 : 0);
