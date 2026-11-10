// What a hostile project's own scripts could try from inside its origin, run against the viewer.
//   1. Register a script of its own as a service worker: must be refused (the host answers worker-script
//      fetches, and it answers unknown paths with the start page).
//   2. Overwrite everything the viewer stored for the origin, three ways, then restart the worker: the real
//      page must be served or the read refused, never the overwritten bytes.
// usage: CHROME_PATH=... node tests/hostile-page.mjs http://<label>.localhost:8853/ <path of a file in the project>
import { createRequire } from 'node:module';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const [address, jsPath] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await (await browser.newContext()).newPage();
await page.goto(address, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker.controller && !document.querySelector('script[src="/_abxfs/boot.js"]'), null, { timeout: 120000 });

const r1 = await page.evaluate(async (p) => {
  const served = await fetch(p);
  const out = { servedToPage: [served.status, served.headers.get('content-type')] };
  try {
    const reg = await navigator.serviceWorker.register(p, { scope: p.replace(/[^/]*$/, '') });
    out.register = `REGISTERED scope ${reg.scope}`;
    await reg.unregister();
  } catch (e) { out.register = `refused: ${e.message}`; }
  try {
    const reg = await navigator.serviceWorker.register(p, { scope: '/' });
    out.registerRoot = `REGISTERED scope ${reg.scope}`;
  } catch (e) { out.registerRoot = `refused: ${e.message}`; }
  return out;
}, jsPath);
console.log('own worker', JSON.stringify(r1));

for (const lie of ['html', 'zeros', 'flip']) {
  const before = await page.title();
  const r2 = await page.evaluate(async (kind) => {
    const names = (await caches.keys()).filter((n) => n.startsWith('abxfs-view-'));
    let changed = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const old = await (await cache.match(req)).text();
        const body = kind === 'html' ? '<!doctype html><title>POISONED</title>poisoned'
          : kind === 'zeros' ? '0x' + '00'.repeat(Math.max(32, (old.length - 2) >> 1))
            : old.slice(0, old.length >> 1) + (old[old.length >> 1] === '0' ? '1' : '0') + old.slice((old.length >> 1) + 1);
        await cache.put(req, new Response(body, { headers: { 'content-type': 'text/html' } }));
        changed++;
      }
    }
    // Stop the worker's memory from answering: unregistering is something a project page can also do.
    return { names, changed };
  }, lie);
  // A new worker life has no memory of checked files: restart it the way the browser would.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload({ waitUntil: 'load' });
  const title = await page.title();
  console.log('storage', lie, JSON.stringify({ ...r2, before, titleAfterReload: title, verdict: title === 'POISONED' ? 'SERVED THE LIE' : title === before ? 'served the real page' : 'refused' }));
}
await browser.close();
