// The check page in a browser, against live chains: each address must reach the verdict named beside it.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... node tests/check-page.mjs [port]
//        CHECK_BASE=https://check.<host>/ CHROME_PATH=... node tests/check-page.mjs     the deployed page
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
// CHECK_BASE names another check page, such as the deployed one: CHECK_BASE=https://check.fromchain.dynv6.net/
const port = process.argv[2] || '8853';
// VIEW_HOST names a live host to test instead of the local build: https://check.<VIEW_HOST>/
const base = process.env.VIEW_HOST ? `https://check.${process.env.VIEW_HOST}/` : process.env.CHECK_BASE || `http://check.localhost:${port}/`;
const CASES = [
  ['an Ethereum project', '#1-e8978b5d18980fa16494fb83167c84cbbe9a6816-0', ['proved', 'newer']],
  ['a Base project', '#8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0', ['settled', 'claimed', 'agreed']],
  ['an Arbitrum One project', '#42161-4338cd826b34ccf3bd6b09c3c8d1a1794eb1400a-0', ['settled', 'agreed']],
  ['a Robinhood Chain project', '#4663-9e488d245f20fecb0210399b725ae0f0e9f5292b-0', ['settled', 'agreed']],
  ['a token page on Ethereum', '#1-ff75c6d3d76fea5fa19f9a14422a87ee88717b5f-0', ['proved', 'newer']],
  ['a token page on Base', '#8453-c4b6048ee69d445dcb63795b89121b40f085738a-0', ['recomputed', 'agreed']],
  ['a token page on Arbitrum One', '#42161-6dd8e2d3ea605d6cc61f84896f967de476294b2e-0', ['recomputed', 'agreed']],
  ['an Ethereum contract that is not an ABX collection', '#1-c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2-0', ['agreed', 'unreachable', 'none']],
  ['a fixed root', '#r1-5wm4rku5u6ow2hylwi7igsn4mvs3aq4hilw4vgcnfp275atmoama', ['fixed']],
  ['no project named', '', ['none']],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
let bad = 0;
for (const [name, hash, want] of CASES) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(base + hash);
  await page.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 120_000 }).catch(() => {});
  const got = await page.evaluate(() => ({ state: document.querySelector('#verdict')?.dataset.state, text: document.querySelector('#verdict')?.textContent, reason: document.querySelector('#reason')?.textContent, facts: [...document.querySelectorAll('#facts dt')].map((dt) => dt.textContent), path: location.pathname, workers: navigator.serviceWorker ? null : 'none', open: !document.querySelector('#open').hidden }));
  const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  // Cloudflare Pages answers /_abxfs/check.html with a redirect to /_abxfs/check (its pretty URLs); both are the check page.
  const ok = want.includes(got.state) && ['/_abxfs/check.html', '/_abxfs/check'].includes(got.path) && regs === 0 && !errors.length;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.state} in ${Date.now() - t0} ms: "${got.text}" ${got.reason ? `(${got.reason.slice(0, 110)})` : ''}${regs ? ' A SERVICE WORKER WAS REGISTERED' : ''}${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
  if (process.env.VERBOSE) console.log('     facts:', got.facts.join(' | '), '| open link shown:', got.open);
  if (hash.startsWith('#1-e897') && process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await page.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} addresses`);
process.exit(bad ? 1 : 0);
