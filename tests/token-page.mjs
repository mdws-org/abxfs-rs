// Token pages in a browser, against live chains: the page the viewer serves for a contract with no ABX FS root
// must be exactly what the contract's tokenURI holds, as read here from another endpoint; and the check page
// must say it is agreed, not proved.
// usage: tools/build-view.py && tools/view-serve.py &   then   CHROME_PATH=... node tests/token-page.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readTokenUri, abiString } from '../site/token.js';
const require = createRequire(process.env.PLAYWRIGHT_DIR || '/Users/bemeadows/Projects/.lanes/abx-experiment/cli/node_modules/');
const { chromium } = require('playwright-core');
const port = process.argv[2] || '8853';
const RPC = { 1: ['https://eth.drpc.org', 'https://rpc.mevblocker.io'], 8453: ['https://base.drpc.org', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io'] };
const sha = (b) => createHash('sha256').update(b).digest('hex');
// [name, chain, contract, token, what is expected]
const CASES = [
  ['an on-chain script page (Desert Syntax)', 8453, 'c4b6048ee69d445dcb63795b89121b40f085738a', '0', 'text/html'],
  ['an SVG image token (z\'s wobbley sketches)', 1, 'ff75c6d3d76fea5fa19f9a14422a87ee88717b5f', '0', 'image/svg+xml'],
  ['a PNG image token', 8453, '68ad94208485ae803b5924eb73c241976f48dfd6', '0', 'image/png'],
  ['a token whose metadata is at a resolver (FLOCK)', 8453, '1b28656ee5403d658298a7a41ba2c1944a0d9746', '0', 'offchain'],
  ['a token whose image is on Arweave', 8453, '2fc9645a31ade7fbeff9b30178fb66f2783292c9', '0', 'offchain'],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
let bad = 0;
for (const [name, chain, org, token, want] of CASES) {
  // The reference: tokenURI from one endpoint, decoded here.
  let ref;
  for (const url of RPC[chain]) {
    try {
      const res = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + org, data: '0xc87b56dd' + BigInt(token).toString(16).padStart(64, '0') }, 'latest'] }) })).json();
      ref = readTokenUri(abiString(res.result));
      break;
    } catch { /* the next endpoint */ }
  }
  if (!ref) throw new Error(`no endpoint gave a reference tokenURI for ${org}`);
  const label = `${chain}-${org}-${token}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://${label}.localhost:${port}/`);
  // The start page registers the worker and reloads; then the worker answers.
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 60_000 }).catch(() => {});
  // The start page reloads itself once the worker controls it. Ask from the viewer's own info page, which stays put.
  await page.waitForTimeout(2500);
  await page.goto(`http://${label}.localhost:${port}/_abxfs/info.html`);
  const got = await page.evaluate(async () => { const r = await fetch('/', { cache: 'no-store' }); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), agreed: r.headers.get('x-abxfs-agreed'), bytes: Array.from(b) }; });
  const other = await page.evaluate(async () => (await fetch('/anything-else', { cache: 'no-store' })).status);
  const check = await ctx.newPage();
  await check.goto(`http://check.localhost:${port}/#${label}`);
  await check.waitForFunction(() => { const v = document.querySelector('#verdict'); return v && v.dataset.state !== 'working'; }, null, { timeout: 90_000 }).catch(() => {});
  const verdict = await check.evaluate(() => ({ state: document.querySelector('#verdict').dataset.state, text: document.querySelector('#verdict').textContent }));
  let ok, detail;
  if (want === 'offchain') {
    ok = ref.kind === 'offchain' && got.status === 404 && verdict.state === 'offchain';
    detail = `served ${got.status}; check page: ${verdict.state} "${verdict.text}"`;
  } else {
    const same = ref.kind === 'page' && sha(Buffer.from(got.bytes)) === sha(Buffer.from(ref.bytes));
    ok = same && got.status === 200 && (got.type || '').startsWith(want) && other === 404 && verdict.state === 'agreed' && Boolean(got.agreed);
    detail = `${got.bytes.length} bytes as ${got.type}, ${same ? 'equal to the reference' : 'DIFFERENT from the reference'}; another path ${other}; check page: ${verdict.state}; agreed by ${got.agreed}`;
  }
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} tokens`);
process.exit(bad ? 1 : 0);
