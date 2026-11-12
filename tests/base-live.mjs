// Base, live: the claims Base has on Ethereum, proved from the built-in block root, and a project's root at each.
// usage: node tests/base-live.mjs [org] [token]
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock } from '../site/proved.js';
import { baseClaims, baseTokenParam } from '../site/base.js';
const [org = '0xab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6', token = '0'] = process.argv.slice(2);
const t0 = Date.now();
const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
const claims = await baseClaims({ fin, urls: PROOF_ENDPOINTS[1] });
const now = Date.now() / 1000;
console.log(`Ethereum block ${claims.l1Block.number} (finalized); ${Date.now() - t0} ms`);
const show = (name, g) => console.log(`${name}: game ${g.proxy}, L2 block ${g.l2Block}, created ${((now - g.createdAt) / 3600).toFixed(1)} h ago, status ${g.status}, proofs ${g.proofCount}, claim ${g.rootClaim}`);
show('anchor', claims.anchor);
if (claims.latest) show('latest', claims.latest); else console.log('latest: none that counts');
let bad = 0;
for (const [name, claim] of [['anchor', claims.anchor], ['latest', claims.latest]]) {
  if (!claim) continue;
  const t = Date.now();
  const got = await baseTokenParam({ claim, org, token });
  if (!got.known) { console.log(`${name}: ${got.why}`); continue; }
  const data = '0x6bd39222' + BigInt(token).toString(16).padStart(64, '0') + '61627866732e636964'.padEnd(64, '0');
  const direct = (await (await fetch('https://base-mainnet.public.blastapi.io', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: org, data }, { blockHash: got.block.hash }] }) })).json()).result;
  const same = direct && direct.slice(0, 66) === got.root;
  bad += !same;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name}: root ${got.root} at L2 block ${got.block.number} (${((now - got.block.timestamp) / 3600).toFixed(1)} h old) via ${got.via}; eth_call at that block ${same ? 'agrees' : 'gives ' + (direct || '').slice(0, 66)}; ${Date.now() - t} ms`);
}
process.exit(bad ? 1 : 0);
