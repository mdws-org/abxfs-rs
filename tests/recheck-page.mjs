// A token page in a browser, against a live chain: the page is served at once, the contract's call is run in
// the service worker behind it, and a later load reports the result in the x-abxfs-recomputed header.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... PLAYWRIGHT_DIR=... node tests/recheck-page.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
// VIEW_HOST names a live host to test instead of the local build: https://<label>.<VIEW_HOST>/
const at = (label) => (process.env.VIEW_HOST ? `https://${label}.${process.env.VIEW_HOST}/` : `http://${label}.localhost:${port}/`);
// [name, label, the state wanted]
const CASES = [
  ['an SVG image token on Ethereum', '1-ff75c6d3d76fea5fa19f9a14422a87ee88717b5f-0', 'proved'],
  ['a generator document on Ethereum (286 KB)', '1-36a34158ad7ead3b8502585136e7add92e4fb8d3-0', 'proved'],
  ['a PNG image token on Base, which has no light client', '8453-68ad94208485ae803b5924eb73c241976f48dfd6-0', 'agreed'],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
let bad = 0;
for (const [name, label, want] of CASES) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(at(label));
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.goto(`${at(label)}_abxfs/info.html`);
  const ask = () => page.evaluate(async () => { const r = await fetch('/', { cache: 'no-store' }); await r.arrayBuffer(); return { status: r.status, state: r.headers.get('x-abxfs-recomputed') }; });
  const t = Date.now();
  const first = await ask();
  let last = first;
  while (last.state === 'running' && Date.now() - t < 120_000) { await page.waitForTimeout(1500); last = await ask(); }
  const ok = first.status === 200 && last.status === 200 && last.state === want;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: served ${first.status} with "${first.state}" at once; "${last.state}" after ${Date.now() - t} ms`);
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} token pages`);
process.exit(bad ? 1 : 0);
