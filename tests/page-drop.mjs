// Drop a folder onto the fs.abx page (a real DataTransfer with directory entries is not scriptable, so this
// builds a synthetic FileSystemEntry tree in the page from files read here) and report the computed root.
// Also exercises Check on chain, the per-file column and the plan download, at a given viewport width.
// usage: node tests/page-drop.mjs <page url> <folder> <chain> <width> <screenshot>
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire('/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const [url, folder, chain, width, shot] = process.argv.slice(2);

const tree = (dir) => readdirSync(dir).map((name) => {
  const p = join(dir, name), st = lstatSync(p);
  return st.isDirectory() ? { name, dir: tree(p) } : { name, b64: readFileSync(p).toString('base64') };
});
const top = { name: folder.split('/').pop(), dir: tree(folder) };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#tool-version').textContent.length > 0);
await page.evaluate((t) => {
  const entry = (n) => n.dir
    ? { isFile: false, isDirectory: true, name: n.name, createReader() { let done = false; return { readEntries(res) { res(done ? [] : (done = true, n.dir.map(entry))); } }; } }
    : { isFile: true, isDirectory: false, name: n.name, file(res) { res(new File([Uint8Array.from(atob(n.b64), (c) => c.charCodeAt(0))], n.name)); } };
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { items: [{ webkitGetAsEntry: () => entry(t) }] };
  document.querySelector('#drop').dispatchEvent(ev);
}, top);
await page.waitForFunction(() => !document.querySelector('#result').hidden || /Could not/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
const root = await page.textContent('#root');
await page.selectOption('#chain', chain);
await page.click('#check');
await page.waitForFunction(() => /Root stored|Root not stored|failed|did not check out/.test(document.querySelector('#chain-result').textContent), null, { timeout: 60000 });
const verdict = await page.textContent('#chain-result');
const column = await page.evaluate(() => [document.querySelector('#onchain-head').textContent, ...[...document.querySelectorAll('#files tbody tr')].map((r) => r.lastChild.textContent)]);
const beforeDl = await page.textContent('#chain-result');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
const afterDl = await page.textContent('#chain-result');
const plan = JSON.parse(readFileSync(await dl.path(), 'utf8'));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const dirsNoteHidden = await page.evaluate(() => document.querySelector('#dirs-note').hidden);
await page.screenshot({ path: shot, fullPage: true });
console.log(JSON.stringify({ beforeDl, afterDl, atShot: await page.textContent('#chain-result'), root, verdict, column: column.slice(0, 6), downloadRoot: plan.rootCid, downloadFiles: plan.files.length, overflowPx: overflow, dirsNoteHidden, errors }, null, 1));
await browser.close();
