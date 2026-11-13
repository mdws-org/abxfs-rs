// Page cases beyond a plain drop: a folder of only empty directories, a two-folder drop, a skipped folder that
// must not be read, the size limit, a truncated Multicall3 reply, and a root lookup.
// usage: node tests/page-cases.mjs <page url> <expected dirs-only root> <shot dir>
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
const [url, dirsOnlyRoot, shots] = process.argv.slice(2);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const results = {};
let bad = 0;
const expect = (name, ok, got) => { results[name] = { ok, got }; bad += !ok; };

async function fresh() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#tool-version').textContent.length > 0);
  return page;
}

// Drop a synthetic entry list. A tree node is {name, dir:[...]} or {name, text}; {name, poison:true} throws if read.
async function dropTree(page, top) {
  await page.evaluate((top) => {
    window.__read = [];
    const entry = (n) => n.dir
      ? { isFile: false, isDirectory: true, name: n.name, createReader() { let done = false; return { readEntries(res) { res(done ? [] : (done = true, n.dir.map(entry))); } }; } }
      : { isFile: true, isDirectory: false, name: n.name, file(res) { window.__read.push(n.name); res(new File([n.text || ''], n.name)); } };
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { items: top.map((t) => ({ webkitGetAsEntry: () => entry(t) })) };
    document.querySelector('#drop').dispatchEvent(ev);
  }, top);
  await page.waitForFunction(() => !document.querySelector('#result').hidden || /Could not/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
  return { status: await page.textContent('#status'), root: await page.evaluate(() => document.querySelector('#result').hidden ? null : document.querySelector('#root').textContent) };
}

{ // only empty directories
  const page = await fresh();
  const r = await dropTree(page, [{ name: 'dirsonly', dir: [{ name: 'a', dir: [{ name: 'b', dir: [] }] }, { name: 'c', dir: [] }] }]);
  expect('dirs-only root equals the CLI dry run', r.root === dirsOnlyRoot, r);
  await page.screenshot({ path: `${shots}/dirsonly.png`, fullPage: true });
  await page.close();
}
{ // two top-level folders
  const page = await fresh();
  const r = await dropTree(page, [{ name: 'one', dir: [{ name: 'x.txt', text: 'hi' }] }, { name: 'two', dir: [{ name: 'y.txt', text: 'yo' }] }]);
  expect('two top-level folders refused', r.root === null && /2 top-level folders/.test(r.status), r);
  await page.close();
}
{ // node_modules and .git are neither read nor counted
  const page = await fresh();
  const r = await dropTree(page, [{ name: 'site', dir: [
    { name: 'index.html', text: '<p>hi</p>' },
    { name: 'node_modules', dir: [{ name: 'big.js', text: 'x' }] },
    { name: '.git', dir: [{ name: 'HEAD', text: 'ref' }] },
  ] }]);
  const read = await page.evaluate(() => window.__read);
  expect('ignored folders not read', r.root !== null && read.join() === 'index.html', { ...r, read });
  await page.close();
}
{ // more than 5,000 files is refused before planning
  const page = await fresh();
  const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.txt`, text: '' }));
  const r = await dropTree(page, [{ name: 'many', dir: many }]);
  expect('5,001 files refused with a pointer to the command line', r.root === null && /command line/.test(r.status), r.status);
  await page.close();
}
{ // a Multicall3 reply whose last boolean is cut short must be an error, never "New"
  const page = await fresh();
  await page.route(/^https:\/\//, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    if (body.method === 'eth_chainId') return reply('0x2105');
    if (body.method === 'eth_blockNumber') return reply('0x10');
    // aggregate3 reply for n calls, each (true, abi bytes(bool false)), then the final word cut in half.
    const n = parseInt(body.params[0].data.slice(2 + 8 + 64, 2 + 8 + 128), 16);
    const w = (v) => BigInt(v).toString(16).padStart(64, '0');
    let heads = '', tails = '';
    for (let i = 0; i < n; i++) { heads += w(32 * n + 128 * i); tails += w(1) + w(64) + w(32) + w(0); }
    return reply('0x' + (w(32) + w(n) + heads + tails).slice(0, -32));
  });
  const r = await dropTree(page, [{ name: 'site', dir: [{ name: 'index.html', text: '<p>hi</p>' }] }]);
  await page.selectOption('#chain', 'base');
  await page.click('#check');
  await page.waitForFunction(() => /Root stored|Root not stored|failed|did not check out/.test(document.querySelector('#chain-result').textContent), null, { timeout: 30000 });
  const verdict = await page.textContent('#chain-result');
  const column = await page.evaluate(() => [...document.querySelectorAll('#files tbody tr')].map((tr) => tr.lastChild.textContent));
  expect('truncated reply is an error, not New', /did not check out/.test(verdict) && !column.includes('New'), { root: r.root, verdict, column });
  await page.close();
}
{ // look up a nested Base Sepolia root
  const page = await fresh();
  await page.goto(url + '?root=0xc63421c7cdd9644ade5fcf2ea1605b40b603486dabdf12433165f2e8d0a21944&chain=base-sepolia#lookup', { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#lk-result').hidden || /not|Could/.test(document.querySelector('#lk-status').textContent), null, { timeout: 60000 });
  const facts = await page.textContent('#lk-facts');
  const where = await page.textContent('#lk-where');
  const files = await page.evaluate(() => [...document.querySelectorAll('#lk-files tbody tr:not(.lk-dir)')].length);
  expect('lookup lists 6 files', /6 files/.test(facts) && files === 6 && page.errors.length === 0, { facts, where, files, status: await page.textContent('#lk-status'), errors: page.errors });
  await page.screenshot({ path: `${shots}/lookup.png`, fullPage: true });
  await page.close();
}
await browser.close();
for (const [k, v] of Object.entries(results)) console.log(v.ok ? 'ok  ' : 'FAIL', k, JSON.stringify(v.got).slice(0, 300));
process.exit(bad ? 1 : 0);
