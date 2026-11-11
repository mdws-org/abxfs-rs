// Does a project keep opening after the viewer's host stops answering?
// Opens a project through a local host, stops that host, then (1) reloads the page, (2) restarts the service
// worker and reloads again, (3) asks for a file not requested before. Each must still be served from chain.
// usage: CHROME_PATH=... node tests/host-gone.mjs http://<label>.localhost:<port>/ <pid of tools/view-serve.py>
import { createRequire } from 'node:module';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const [address, pid] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await (await browser.newContext()).newPage();
await page.goto(address, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker.controller && !document.querySelector('script[src="/_abxfs/boot.js"]'), null, { timeout: 120000 });
const title = await page.title();
await page.waitForTimeout(2500); // the worker keeps copies of the viewer's own files after it takes control
process.kill(Number(pid));
await new Promise((r) => setTimeout(r, 800));
const hostDown = await fetch(address).then(() => false, () => true);
const results = { title, hostDown };
const check = async (name) => {
  try {
    const r = await page.reload({ waitUntil: 'load', timeout: 60000 });
    results[name] = { status: r.status(), title: await page.title(), same: (await page.title()) === title };
  } catch (e) { results[name] = { error: e.message.slice(0, 100) }; }
};
await check('reload with the host down');
const cdp = await page.context().newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await check('reload after the worker restarted');
results['a file not asked for before'] = await page.evaluate(async () => {
  const r = await fetch('/_abxfs/info.html').then((x) => x.status + ' ' + (x.headers.get('x-abxfs-from') || 'from the host'), (e) => 'failed: ' + e.message);
  const f = await fetch('/404-probe-' + Date.now()).then((x) => x.status, (e) => 'failed');
  return { viewerOwnPage: r, missingProjectPath: f };
});
console.log(JSON.stringify(results, null, 1));
await browser.close();
