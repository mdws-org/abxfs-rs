// The check page and the worker that runs a contract's code (view/evm-worker.js), in a browser against a live
// chain: a token page is recomputed through the worker; a worker that never answers is ended and the page says
// so; a browser that cannot start a worker gets "agreed", not an error.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... PLAYWRIGHT_DIR=... node tests/worker-page.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/');
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
const label = '1-ff75c6d3d76fea5fa19f9a14422a87ee88717b5f-0'; // an SVG image token on Ethereum
// Long waits are cut to half a second, so that the page's 200 second limit on a run is reached at once.
const QUICK = () => { const real = window.setTimeout; window.setTimeout = (fn, ms, ...rest) => real(fn, ms >= 100_000 ? 500 : ms, ...rest); };
const CASES = [
  ['the worker runs the call', null, 'proved', /Recomputed here/, ''],
  ['a worker that never answers is ended', () => { window.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() { window.__ended = true; } }; }, 'agreed', /Not proved/, /the run was ended after 200 seconds/i],
  ['a browser with no workers', () => { window.Worker = class { constructor() { throw new Error('no workers here'); } }; }, 'agreed', /Not proved/, /could not start a worker/i],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
let bad = 0;
for (const [name, tamper, want, says, why] of CASES) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const workers = [];
  page.on('worker', (w) => workers.push(w.url()));
  if (tamper) { await page.addInitScript(QUICK); await page.addInitScript(tamper); }
  await page.goto(`http://check.localhost:${port}/#${label}`);
  await page.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 240_000 }).catch(() => {});
  const got = await page.evaluate(() => ({ state: document.querySelector('#verdict').dataset.state, text: document.querySelector('#verdict').textContent, reason: document.querySelector('#reason').textContent, ended: window.__ended === true }));
  const ok = got.state === want && says.test(got.text) && (!why || why.test(got.reason)) && (tamper ? true : workers.some((u) => u.endsWith('/evm-worker.js'))) && (name.includes('never answers') ? got.ended : true);
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.state} "${got.text}"; workers started: ${workers.map((u) => u.split('/').pop()).join(', ') || 'none'}${ok && !why ? '' : ` (${got.reason.slice(-160)})`}`);
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} cases`);
process.exit(bad ? 1 : 0);
