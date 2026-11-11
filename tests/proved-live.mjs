// A project's root, proved from a finalized block root that two beacon nodes report, compared with what several
// execution endpoints return for tokenParam(token, "abxfs.cid") at the same block.
// usage: node tests/proved-live.mjs [org] [token]
import { provedTokenParam, COLLECTION_CODE_HASH, PROOF_ENDPOINTS } from '../site/proved.js';
const [org = '0xe8978b5d18980fa16494fb83167c84cbbe9a6816', token = '0'] = process.argv.slice(2);
const BEACON = ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'];
const RPCS = PROOF_ENDPOINTS[1];
const COMPARE = 'https://eth-mainnet.public.blastapi.io';
const json = async (u) => (await fetch(u)).json();
const call = (url) => async (method, params) => { const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(`${new URL(url).host} ${method}: ${JSON.stringify(r.error)}`); return r.result; };
const roots = await Promise.all(BEACON.map((b) => json(`${b}/eth/v1/beacon/headers/finalized`).then((j) => j.data.root)));
if (new Set(roots).size !== 1) throw new Error('the beacon nodes disagree on the finalized root');
console.log(`collection code hash ${COLLECTION_CODE_HASH}`);
let failed = 0, served = 0;
for (const url of RPCS) {
  const t0 = Date.now();
  let got;
  try { got = await provedTokenParam({ chainId: 1, checkpoint: roots[0], beacon: (p) => json(BEACON[0] + p), rpc: call(url), org, token }); }
  catch (e) { console.log(`     ${new URL(url).host}: no usable proof (${e.message.slice(0, 90)})`); continue; }
  served++;
  if (!got.known) { console.log(`${new URL(url).host}: ${got.why}`); continue; }
  const data = '0x6bd39222' + BigInt(token).toString(16).padStart(64, '0') + '61627866732e636964'.padEnd(64, '0');
  // The comparison comes from one fixed endpoint: some proof endpoints refuse eth_call.
  const direct = await call(COMPARE)('eth_call', [{ to: org, data }, '0x' + got.block.number.toString(16)]);
  const same = direct.slice(0, 66) === got.root && BigInt('0x' + direct.slice(130, 194)) === (got.isSet ? 1n : 0n);
  if (!same) failed++;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${new URL(url).host}: proved ${got.root} isSet ${got.isSet} at block ${got.block.number} (finalized slot ${got.finalizedSlot}, ${Math.round((Date.now() / 1000 - got.block.timestamp) / 60)} min old), eth_call ${same ? 'agrees' : 'gives ' + direct.slice(0, 66)}; ${Date.now() - t0} ms`);
}
const none = await provedTokenParam({ chainId: 1, checkpoint: roots[0], beacon: (p) => json(BEACON[0] + p), rpc: call(RPCS[0]), org: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', token });
console.log(`${none.known ? 'FAIL' : 'ok  '} a contract that is not an ABX collection: ${none.known ? 'was read' : none.why}`);
if (none.known) failed++;
console.log(`${served} of ${RPCS.length} endpoints served a proof that checked`);
if (served < 2) failed++;
process.exit(failed ? 1 : 0);
