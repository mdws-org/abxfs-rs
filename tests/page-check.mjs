// Drive the fs.abx page: pick a folder, read the root it computes, check it on a chain, and screenshot.
// usage: node tests/page-check.mjs <page url> <folder> <chain value> <screenshot path> [light|dark]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
const [url, folder, chain, shot, scheme = 'dark'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 }, colorScheme: scheme });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#tool-version').textContent.length > 0, null, { timeout: 20000 });
await page.setInputFiles('#folder', folder);
await page.waitForFunction(() => !document.querySelector('#result').hidden || /Could not/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
const root = await page.textContent('#root');
const facts = await page.textContent('#plan-facts');
await page.selectOption('#chain', chain);
await page.click('#check');
await page.waitForFunction(() => /Root stored|Root not stored|failed|did not check out/.test(document.querySelector('#chain-result').textContent), null, { timeout: 60000 });
const verdict = await page.textContent('#chain-result');
await page.screenshot({ path: shot, fullPage: true });
console.log(JSON.stringify({ root, facts, verdict, errors, version: await page.textContent('#tool-version') }, null, 1));
await browser.close();
