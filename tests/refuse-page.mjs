// A host that declines a project, in a browser: the worker shows the refusal page and reads nothing of the project;
// with the same host listing another project, and with no list, the project loads.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... PLAYWRIGHT_DIR=... node tests/refuse-page.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/');
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
const L = '8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0';
const at = `http://${L}.localhost:${port}/`;
// [name, the host's refuse list (null: the built switch.json), refused?]
const CASES = [
  ['the host lists this project', [L], true],
  ['the host lists another project', ['1-0000000000000000000000000000000000000000-0'], false],
  ['the host lists nothing', null, false],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
let bad = 0;
for (const [name, list, refused] of CASES) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let chainCalls = 0;
  // Counted at the context, which also sees what the service worker fetches.
  await ctx.route((u) => !u.hostname.endsWith('localhost'), (route) => { chainCalls++; return route.continue(); });
  if (list) await ctx.route('**/_abxfs/switch.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proof: true, refuse: list }) }));
  await page.goto(at);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 60_000 }).catch(() => {});
  const before = chainCalls;
  const res = await page.goto(at, { waitUntil: 'load', timeout: 120_000 });
  const got = { status: res.status(), title: await page.title(), text: (await page.evaluate(() => document.body.innerText)).slice(0, 400), links: await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))) };
  // Another path of the same origin, by navigation: the refusal page's own policy lets its scripts fetch nothing.
  const sub = (await page.goto(at + 'index.html', { waitUntil: 'load', timeout: 120_000 })).status();
  const ok = refused
    ? got.status === 451 && sub === 451 && /does not show this project/.test(got.title) && /this host's choice alone/.test(got.text) && got.links.some((h) => /abxfs-rs/.test(h)) && got.links.some((h) => /archive\/manifest\.json/.test(h)) && chainCalls === before
    : got.status === 200 && sub === 200 && !/does not show this project/.test(got.title) && chainCalls > 0;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.status} "${got.title}", a file ${sub}, requests off this host after the worker took over: ${chainCalls - before}`);
  if (!ok) console.log('     ', JSON.stringify(got).slice(0, 500));
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} hosts`);
process.exit(bad ? 1 : 0);
