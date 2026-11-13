// The check page as one file (tools/build-check-file.py), opened from disk in a browser with no server of its
// own, against live chains: it must reach the same states the served check page does, run the contract's call
// in its worker (or in the page, where a browser will not start a worker from a file), and start from a block
// root the reader gives. ENGINE picks the browser (chromium, webkit, firefox).
// usage: tools/build-view.py && tools/build-check-file.py   then   CHROME_PATH=... PLAYWRIGHT_DIR=... node tests/check-file.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { BEACONS } from '../site/checkpoint.js';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const engine = process.env.ENGINE || 'chromium';
const file = pathToFileURL(join(new URL('.', import.meta.url).pathname, '..', 'view-dist-file', 'abxfs-check.html')).href;
const browser = await require('playwright-core')[engine].launch({ headless: true, executablePath: (engine === 'chromium' && process.env.CHROME_PATH) || undefined });
const settle = (page) => page.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 240_000 }).catch(() => {});
const read = (page) => page.evaluate(() => ({ state: document.querySelector('#verdict').dataset.state, text: document.querySelector('#verdict').textContent, reason: document.querySelector('#reason').textContent,
  facts: Object.fromEntries([...document.querySelectorAll('#facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])), build: document.querySelector('#build').textContent, note: document.querySelector('#start-note')?.textContent || '' }));
let bad = 0;
const check = (ok, name, detail) => { bad += !ok; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const errors = [];
// [name, label, states allowed]
const CASES = [
  ['an Ethereum project', '1-e8978b5d18980fa16494fb83167c84cbbe9a6816-0', ['proved', 'newer']],
  ['a token page on Ethereum, run in the worker', '1-ff75c6d3d76fea5fa19f9a14422a87ee88717b5f-0', ['proved', 'newer']],
  ['a Base project', '8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0', ['settled', 'claimed', 'agreed']],
  ['a token page on Base, run in the worker', '8453-c4b6048ee69d445dcb63795b89121b40f085738a-0', ['recomputed', 'agreed']],
];
for (const [name, label, want] of CASES) {
  const page = await (await browser.newContext()).newPage();
  // A browser that will not start the worker from a file says so as an error; the page then runs the call itself.
  page.on('pageerror', (e) => { if (!/Cross-origin script load denied/.test(e.message)) errors.push(`${name}: ${e.message}`); });
  const workers = [];
  page.on('worker', (w) => workers.push(w.url().slice(0, 5)));
  const t = Date.now();
  await page.goto(`${file}#${label}`);
  await settle(page);
  const got = await read(page);
  check(want.includes(got.state) && /^[0-9a-f]{64}$/.test(got.build) && (!name.includes('worker') || workers.includes('blob:')) && (!name.includes('Ethereum, run') || got.state !== 'agreed'), name, `${got.state} in ${Date.now() - t} ms: "${got.text.slice(0, 70)}"${name.includes('worker') ? `; worker ${workers.join(',') || 'none'}` : ''}`);
  await page.context().close();
}

// A starting block of the reader's own: a finalized block root asked of a beacon node here, typed into the page.
let root = null;
for (const url of BEACONS[1]) { try { root = (await (await fetch(`${url}/eth/v1/beacon/headers/finalized`, { signal: AbortSignal.timeout(15000) })).json()).data.root; break; } catch { /* next */ } }
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`own block: ${e.message}`));
  const at = `${file}#1-e8978b5d18980fa16494fb83167c84cbbe9a6816-0`;
  await page.goto(at);
  await settle(page);
  // The check runs again in place: the page is not loaded again, and from a file the block is not kept.
  const again = async () => { await page.waitForFunction(() => document.querySelector('#verdict').dataset.state === 'working', null, { timeout: 5000 }).catch(() => {}); await settle(page); return read(page); };
  const banner = () => page.evaluate(() => { const b = document.querySelector('#start-banner'); return b.hidden ? '' : b.textContent; });
  await page.fill('#start-own', 'not a root');
  await page.click('#start-save');
  const refused = (await read(page)).note;
  await page.fill('#start-own', root);
  await page.click('#start-save');
  const mine = await again();
  check(/not a block root/.test(refused), 'something that is not a block root is not used', `"${refused}"`);
  check(['proved', 'newer'].includes(mine.state) && (mine.facts['Starting block'] || '').startsWith(`yours, ${root}`) && (await banner()).includes(root), 'a proof from a block root the reader gave, named in the facts and under the verdict', `${mine.state}; starting block: ${(mine.facts['Starting block'] || '').slice(0, 60)}…`);
  await page.fill('#start-own', '0x' + '12'.repeat(32));
  await page.click('#start-save');
  const wrong = await again();
  check(wrong.state === 'agreed' && /not proved/i.test(wrong.text), 'a block root no beacon node knows proves nothing', `${wrong.state}: "${wrong.reason.slice(0, 110)}"`);
  await page.click('#start-clear');
  const back = await again();
  check(['proved', 'newer'].includes(back.state) && !(back.facts['Starting block'] || '').startsWith('yours') && (await banner()) === '', 'back to the built-in block', `${back.state}; starting block: ${(back.facts['Starting block'] || '').slice(0, 40)}`);
  // What another file on the same disk could have left in the browser's storage is not read.
  await page.evaluate(() => { try { localStorage.setItem('abxfs-start-1', '0x' + '34'.repeat(32)); } catch { /* no storage for files in this browser */ } });
  await page.reload();
  await settle(page);
  const planted = await read(page);
  check(!(planted.facts['Starting block'] || '').startsWith('yours') && (await banner()) === '', 'a block root left in the browser\'s storage by another file is not used', `starting block: ${(planted.facts['Starting block'] || '').slice(0, 40)}`);
  // Inside another page, the file does not run. The outer page is a second file on disk, as a hostile one would be.
  const dir = await mkdtemp(join(tmpdir(), 'abxfs-frame-'));
  await writeFile(join(dir, 'outer.html'), `<!doctype html><iframe src="${at}" width="600" height="300"></iframe>`);
  const outer = await ctx.newPage();
  await outer.goto(pathToFileURL(join(dir, 'outer.html')).href);
  await outer.waitForTimeout(3000);
  const inner = outer.frames()[1];
  const framed = inner ? await Promise.race([inner.evaluate(() => `${document.querySelector('#verdict')?.textContent || 'no page'} | facts ${document.querySelectorAll('#facts dt').length}`).catch(() => 'the browser did not load it'), new Promise((r) => setTimeout(() => r('the browser did not load it'), 8000))]) : 'the browser did not load it';
  check(/does not run inside another page|the browser did not load it/.test(framed) && !/facts [1-9]/.test(framed), 'the file does not run inside another page', `"${framed.slice(0, 90)}"`);
  await rm(dir, { recursive: true, force: true });
  await ctx.close();
}
check(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300) || 'none');
await browser.close();
console.log(bad ? `${bad} FAILED in ${engine}` : `ok: the one-file check page in ${engine}, opened from disk`);
process.exit(bad ? 1 : 0);
