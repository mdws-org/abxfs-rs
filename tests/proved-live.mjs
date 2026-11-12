// A project's root, proved from the shipped block root, through each listed proof endpoint in turn, compared
// with what the endpoints return for tokenParam at the same block, and judged.
// usage: node tests/proved-live.mjs [org] [token]
import { COLLECTION_CODE_HASH, PROOF_ENDPOINTS, finalizedBlock, provedTokenParam, tokenParamAt } from '../site/proved.js';
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { judge } from '../site/verdict.js';
const [org = '0xe8978b5d18980fa16494fb83167c84cbbe9a6816', token = '0'] = process.argv.slice(2);
console.log(`collection code hash ${COLLECTION_CODE_HASH}; shipped root at slot ${CHECKPOINTS[1].slot} (${CHECKPOINTS[1].date})`);
let failed = 0, served = 0;
const t0 = Date.now();
const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
console.log(`light client: finalized slot ${fin.finalizedSlot}, execution block ${fin.executionBlockHash}, ${fin.participants} of 512 signed; ${Date.now() - t0} ms`);
let proved;
for (const url of PROOF_ENDPOINTS[1]) {
  try {
    const got = await provedTokenParam({ fin, urls: [url], org, token });
    served++; proved ||= got;
    console.log(`ok   ${new URL(url).host}: ${got.known ? `proved ${got.root} isSet ${got.isSet} at block ${got.block.number}` : got.why}`);
    if (proved.known && got.root !== proved.root) { failed++; console.log('FAIL two endpoints gave proofs of different roots'); }
  } catch (e) { console.log(`     ${new URL(url).host}: no usable proof (${e.message.slice(0, 90)})`); }
}
const atFinalized = await tokenParamAt({ urls: PROOF_ENDPOINTS[1].slice(0, 5), org, token, block: proved.block.number });
console.log(`eth_call at block ${proved.block.number}: ${atFinalized.map(([h, r]) => `${h} ${r.slice(0, 12)}…`).join(', ')}`);
const verdict = judge({ proved, atFinalized, agreedHead: { root: proved.root } });
console.log(`${verdict.state === 'proved' ? 'ok  ' : 'FAIL'} verdict: ${verdict.state} (${verdict.reason})`);
if (verdict.state !== 'proved') failed++;
const none = await provedTokenParam({ fin, urls: PROOF_ENDPOINTS[1], org: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', token });
console.log(`${none.known ? 'FAIL' : 'ok  '} a contract that is not an ABX collection: ${none.known ? 'was read' : none.why}`);
if (none.known) failed++;
console.log(`${served} of ${PROOF_ENDPOINTS[1].length} endpoints served a proof that checked`);
if (served < 2) failed++;
process.exit(failed ? 1 : 0);
