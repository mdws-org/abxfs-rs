// The reader's own endpoint, set from the info page, and what a project's own scripts can do with that setting.
// usage: CHROME_PATH=... node tests/endpoint-setting.mjs http://<base project label>.localhost:<port>/
import { createRequire } from 'node:module';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const [address] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('console', (m) => /Content Security|Refused/.test(m.text()) && errs.push(m.text().slice(0, 140)));
const opened = () => page.waitForFunction(() => navigator.serviceWorker.controller && !document.querySelector('script[src="/_abxfs/boot.js"]'), null, { timeout: 120000 });
const infoReady = () => page.waitForFunction(() => document.querySelector('#host-match').textContent.length > 0, null, { timeout: 90000 });
await page.goto(address, { waitUntil: 'load' });
await opened();
const title = await page.title();
const info = new URL('/_abxfs/info.html', address).href;
const facts = async () => (await page.textContent('#facts')).replace(/\s+/g, ' ');
const set = async (url) => {
  await page.goto(info, { waitUntil: 'load' });
  await infoReady();
  await page.fill('#endpoint-url', url);
  await page.click('#endpoint-save');
  // A refused endpoint leaves a message; an accepted one reloads the page.
  const status = await Promise.race([
    page.waitForFunction(() => /Not saved/.test(document.querySelector('#endpoint-status')?.textContent || ''), null, { timeout: 60000 }).then(() => page.textContent('#endpoint-status')),
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).then(() => 'saved'),
  ]);
  await infoReady();
  return { status: status.slice(0, 70), yours: (await facts()).match(/Your endpoint(.*?)(Root|$)/)?.[1]?.trim() || null };
};
const results = { title };
let bad = 0;
const expect = (name, ok, got) => { results[name] = { ok, got }; bad += !ok; };
for (const [name, url] of [['not a URL', 'javascript:alert(1)'], ['plain http, not local', 'http://example.org/rpc'], ['a password in the address', 'https://user:secret@base.drpc.org/'], ['another chain', 'https://ethereum-rpc.publicnode.com']]) {
  const r = await set(url);
  expect(`refused: ${name}`, /Not saved/.test(r.status) && !r.yours, r);
}
const saved = await set('https://base.drpc.org');
expect('saved, and asked first for checked reads', saved.status === 'saved' && /base\.drpc\.org/.test(saved.yours || ''), saved);
expect('the info page says the host serves this build', /serves exactly these files/.test(await page.textContent('#host-match')), await page.textContent('#host-match'));
expect('the info page came from the kept copy', /kept copy/.test(await page.evaluate(async () => (await fetch('/_abxfs/info.js')).headers.get('x-abxfs-from'))), '');

// A project's own script plants an endpoint in storage and sends the worker a message, then the worker restarts.
await page.goto(address, { waitUntil: 'load' });
const planted = await page.evaluate(async () => {
  const cache = await caches.open((await caches.keys()).find((n) => n.startsWith('abxfs-view-')));
  await cache.put('/_abxfs/store/setting/endpoint', new Response('https://example.org/attacker-rpc'));
  const channel = new MessageChannel();
  const reply = new Promise((ok) => { channel.port1.onmessage = (e) => ok(e.data); setTimeout(() => ok('no reply'), 3000); });
  navigator.serviceWorker.controller.postMessage({ type: 'abxfs-endpoint', value: 'https://example.org/attacker-rpc' }, [channel.port2]);
  return reply;
});
expect('a message from a project page is not answered', planted === 'no reply', planted);
const cdp = await page.context().newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await page.reload({ waitUntil: 'load' });
expect('with a planted endpoint the project still opens', (await page.title()) === title, await page.title());
await page.goto(info, { waitUntil: 'load' });
await infoReady();
const after = await facts();
const agreed = after.match(/Current root\s*(agreed by .*?) at block/)?.[1] || '';
expect('the current root still came from public endpoints', /mainnet\.base\.org/.test(agreed) && !/example\.org/.test(agreed), agreed);
await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#endpoint-clear')]);
await infoReady();
expect('cleared', !/Your endpoint/.test(await facts()), '');
expect('no security-policy errors', errs.length === 0, errs);
console.log(JSON.stringify(results, null, 1));
await browser.close();
process.exit(bad ? 1 : 0);
