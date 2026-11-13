// The check page's starting block and nodes, in a browser against live chains: a block reached on one visit
// is where the next starts; a reader's own consensus and execution nodes are checked before use and asked
// first; a consensus server that reports an unknown Ethereum fork gives a state of its own.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... PLAYWRIGHT_DIR=... node tests/check-start.mjs [port]
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
// VIEW_HOST names a live host to test instead of the local build: https://check.<VIEW_HOST>/
const page0 = process.env.VIEW_HOST ? `https://check.${process.env.VIEW_HOST}/` : `http://check.localhost:${port}/`;
const at = `${page0}#1-e8978b5d18980fa16494fb83167c84cbbe9a6816-0`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const settle = (page) => page.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 240_000 }).catch(() => {});
const again = async (page) => { await page.waitForFunction(() => document.querySelector('#verdict').dataset.state === 'working', null, { timeout: 5000 }).catch(() => {}); await settle(page); };
const read = (page) => page.evaluate(() => ({ state: document.querySelector('#verdict').dataset.state, text: document.querySelector('#verdict').textContent, reason: document.querySelector('#reason').textContent,
  start: [...document.querySelectorAll('#facts dt')].find((d) => d.textContent === 'Starting block')?.nextElementSibling.textContent || '', served: [...document.querySelectorAll('#facts dt')].find((d) => d.textContent === 'Proof served by')?.nextElementSibling.textContent || '',
  note: document.querySelector('#node-note').textContent, remembered: localStorage.getItem('abxfs-remembered-1') }));
let bad = 0;
const check = (ok, name, detail) => { bad += !ok; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };

const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(at);
await settle(page);
let r = await read(page);
let kept = null; try { kept = JSON.parse(r.remembered); } catch { /* none */ }
check(['proved', 'newer'].includes(r.state) && kept && /^0x[0-9a-f]{64}$/.test(kept.root) && Number.isSafeInteger(kept.slot), 'a first visit proves, and remembers the finalized block it reached', `${r.state}; remembered slot ${kept && kept.slot}`);
await page.reload();
await settle(page);
r = await read(page);
check(['proved', 'newer'].includes(r.state) && /earlier visit/.test(r.start), 'the next visit starts from the remembered block', `${r.state}; starting block: ${r.start.slice(0, 90)}`);

// The reader's own nodes.
const use = async (kind, url) => { await page.fill(`#node-${kind}`, url); await page.click(`#node-${kind}-save`); await page.waitForFunction(() => !/^Checking/.test(document.querySelector('#node-note').textContent), null, { timeout: 30_000 }).catch(() => {}); };
await use('consensus', 'https://lodestar-sepolia.chainsafe.io');
r = await read(page);
check(/genesis is another chain/.test(r.note), 'a consensus node for another chain is refused', `"${r.note}"`);
await use('consensus', 'https://example.com');
r = await read(page);
check(/could not be read|not a consensus node/.test(r.note), 'something that is not a consensus node is refused', `"${r.note.slice(0, 100)}"`);
await use('consensus', 'http://192.168.1.5:5052');
r = await read(page);
check(/https address/.test(r.note), 'a node at plain http off this machine is refused before it is asked', `"${r.note.slice(0, 80)}"`);
await use('execution', 'https://ethereum-rpc.publicnode.com');
r = await read(page);
check(/does not serve proofs at the finalized block/.test(r.note), 'an execution node that keeps too little state is refused', `"${r.note.slice(0, 110)}"`);
await use('execution', 'https://eth-mainnet.public.blastapi.io');
await again(page);
await use('consensus', 'https://ethereum-beacon-api.publicnode.com');
await again(page);
r = await read(page);
check(['proved', 'newer'].includes(r.state) && /consensus and execution nodes are asked first/.test(r.note) && /eth-mainnet\.public\.blastapi\.io/.test(r.served), 'with both nodes given, they are asked first and the proof is served by the execution node', `${r.state}; "${r.note}"; served by ${r.served.slice(0, 50)}`);
await use('consensus', '');
await again(page);
await use('execution', '');
await again(page);
r = await read(page);
check(r.note === '' && ['proved', 'newer'].includes(r.state), 'the nodes can be removed again', `${r.state}; note "${r.note}"`);

// An Ethereum fork this viewer does not read.
const forked = await browser.newContext();
await forked.route('**/eth/v1/beacon/states/head/fork', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { previous_version: '0x06000000', current_version: '0x07000000', epoch: '500000' } }) }));
const fp = await forked.newPage();
await fp.goto(at);
await settle(fp);
r = await read(fp);
check(r.state === 'outdated' && /fork this viewer does not read/.test(r.text) && /0x07000000/.test(r.reason), 'an unknown fork is said, with the version', `${r.state}: "${r.text}" (${r.reason.slice(0, 90)})`);
const baseFork = await fp.evaluate(() => 0);
await fp.goto(`${page0}#8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0`);
await fp.reload();
await settle(fp);
r = await read(fp);
check(r.state === 'outdated' && /fork/.test(r.text), 'and on a rollup, whose proof goes through Ethereum', `${r.state}: "${r.text}"`);
await browser.close();
console.log(bad ? `${bad} FAILED` : 'ok: starting block and nodes');
process.exit(bad ? 1 : 0);
