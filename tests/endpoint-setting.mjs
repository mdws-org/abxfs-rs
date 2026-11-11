// The reader's own endpoint, set from the info page.
// usage: CHROME_PATH=... node tests/endpoint-setting.mjs http://<base project label>.localhost:<port>/
import { createRequire } from 'node:module';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const [address] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('console', (m) => /Content Security|Refused/.test(m.text()) && errs.push(m.text().slice(0, 140)));
await page.goto(address, { waitUntil: 'load' });
await page.waitForFunction(() => navigator.serviceWorker.controller && !document.querySelector('script[src="/_abxfs/boot.js"]'), null, { timeout: 120000 });
const title = await page.title();
const info = new URL('/_abxfs/info.html', address).href;
const set = async (url, only) => {
  await page.goto(info, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#build').textContent.length === 64, null, { timeout: 60000 });
  await page.fill('#endpoint-url', url);
  await page.setChecked('#endpoint-only', only);
  await page.click('#endpoint-save');
  // A refused endpoint leaves a message; an accepted one reloads the page.
  const status = await Promise.race([
    page.waitForFunction(() => /Not saved/.test(document.querySelector('#endpoint-status')?.textContent || ''), null, { timeout: 60000 }).then(() => page.textContent('#endpoint-status')),
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).then(() => 'saved'),
  ]);
  await page.waitForFunction(() => document.querySelector('#build').textContent.length === 64, null, { timeout: 60000 });
  return { status, endpoints: (await page.textContent('#facts')).match(/Endpoints(.*)$/)?.[1] };
};
const results = { title, build: null };
results['not a URL'] = await set('javascript:alert(1)', false);
results['plain http, not local'] = await set('http://example.org/rpc', false);
results['another chain (Ethereum endpoint on a Base project)'] = await set('https://ethereum-rpc.publicnode.com', false);
results['own endpoint first'] = await set('https://base.drpc.org', false);
results['own endpoint only'] = await set('https://base-rpc.publicnode.com', true);
results.build = await page.textContent('#build');
results.viewerFiles = await page.locator('#viewer-files tbody tr').count();
await page.goto(address, { waitUntil: 'load' });
results['project with only that endpoint'] = await page.title();
await page.goto(info, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#build').textContent.length === 64);
await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#endpoint-clear')]);
await page.waitForFunction(() => document.querySelector('#build').textContent.length === 64);
results.cleared = (await page.textContent('#facts')).match(/Endpoints(.*)$/)?.[1];
results.cspErrors = errs;
console.log(JSON.stringify(results, null, 1));
await browser.close();
