// The check page in a browser, against live chains: each address must reach the verdict named beside it.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... node tests/check-page.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || '/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
const CASES = [
  ['an Ethereum project', '#1-e8978b5d18980fa16494fb83167c84cbbe9a6816-0', ['proved', 'newer']],
  ['a Base project (no light client for Base)', '#8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0', ['agreed']],
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
  await page.goto(`http://check.localhost:${port}/${hash}`);
  await page.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 120_000 }).catch(() => {});
  const got = await page.evaluate(() => ({ state: document.querySelector('#verdict')?.dataset.state, text: document.querySelector('#verdict')?.textContent, reason: document.querySelector('#reason')?.textContent, facts: [...document.querySelectorAll('#facts dt')].map((dt) => dt.textContent), path: location.pathname, workers: navigator.serviceWorker ? null : 'none', open: !document.querySelector('#open').hidden }));
  const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  const ok = want.includes(got.state) && got.path === '/_abxfs/check.html' && regs === 0 && !errors.length;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.state} in ${Date.now() - t0} ms: "${got.text}" ${got.reason ? `(${got.reason.slice(0, 110)})` : ''}${regs ? ' A SERVICE WORKER WAS REGISTERED' : ''}${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
  if (process.env.VERBOSE) console.log('     facts:', got.facts.join(' | '), '| open link shown:', got.open);
  if (hash.startsWith('#1-e897') && process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await page.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} addresses`);
process.exit(bad ? 1 : 0);
