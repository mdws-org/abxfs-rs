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
  ['an SVG image token on Ethereum', '1-ff75c6d3d76fea5fa19f9a14422a87ee88717b5f-0', 'same'],
  ['a generator document on Ethereum (286 KB)', '1-36a34158ad7ead3b8502585136e7add92e4fb8d3-0', 'same'],
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
// The warning in a real browser. A difference cannot be made to happen on a live chain, so a warning is placed
// in the worker's store before the worker starts, as one it kept from before a restart. The first load must
// then be the warning; scripts on the origin must not be able to read its link; following the link opens the page.
{
  const label = CASES[0][1];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${at(label)}_abxfs/info.html`);
  await page.evaluate(async () => {
    const shown = { mine: '0x' + '11'.repeat(32), block: 100, theirs: [['one.example', '0x' + '22'.repeat(32)]], pageHash: '0x' + '22'.repeat(32), pageBlock: 180, sources: ['one.example', 'two.example'], reason: 'at block 100 this viewer computes one reply and one.example returns another' };
    await (await caches.open('abxfs-view-v2')).put('/_abxfs/store/token-warning', new Response(JSON.stringify({ open: false, shown })));
  });
  await page.goto(at(label));
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.goto(at(label));
  const title = await page.title();
  const link = await page.getAttribute('a[href^="/?abxfs-open="]', 'href').catch(() => null);
  const styled = await page.evaluate(() => getComputedStyle(document.querySelector('main')).maxWidth !== 'none').catch(() => false);
  // From the viewer's own info page on the same origin, as a project's script would try.
  const probe = await ctx.newPage();
  await probe.goto(`${at(label)}_abxfs/info.html`);
  const tried = await probe.evaluate(async () => {
    const text = await (await fetch('/', { cache: 'no-store' })).text();
    const frame = document.createElement('iframe'); frame.src = '/'; document.body.append(frame);
    await new Promise((r) => setTimeout(r, 1500));
    let framed = 'unreadable';
    try { framed = frame.contentDocument ? frame.contentDocument.documentElement.outerHTML : 'no document'; } catch { /* another origin */ }
    return { fetched: /abxfs-open/.test(text), framed: /abxfs-open/.test(framed) };
  });
  await probe.close();
  await page.click('a[href^="/?abxfs-open="]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ title: document.title, svg: Boolean(document.querySelector('svg')) || document.contentType }));
  const ok = /compute different pages/.test(title) && Boolean(link) && styled && !tried.fetched && !tried.framed && !/compute different pages/.test(after.title);
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} a warning kept from before a restart: first load "${title}"${styled ? ', styled' : ', NOT styled'}; a fetch ${tried.fetched ? 'READ' : 'did not read'} the link, a frame ${tried.framed ? 'READ' : 'did not read'} it; the link opened ${after.svg === true ? 'the token page' : `"${after.title}" (${after.svg})`}`);
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} token pages and the warning`);
process.exit(bad ? 1 : 0);
