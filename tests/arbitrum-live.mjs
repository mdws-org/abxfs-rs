// Arbitrum One and Robinhood Chain, live: the newest confirmed assertion on Ethereum, proved from the built-in
// block root, the rollup block it commits to, and a project's root at that block.
// usage: node tests/arbitrum-live.mjs
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock } from '../site/proved.js';
import { ROLLUPS, confirmed, rollupTokenParam } from '../site/arbitrum.js';
const PROJECTS = { 42161: '0x4338cd826b34ccf3bd6b09c3c8d1a1794eb1400a', 4663: '0x9e488d245f20fecb0210399b725ae0f0e9f5292b' };
const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
const now = Date.now() / 1000;
let bad = 0;
for (const id of Object.keys(ROLLUPS).map(Number)) {
  const t = Date.now();
  let claim;
  try { claim = await confirmed({ fin, urls: PROOF_ENDPOINTS[1], chainId: id }); } catch (e) { bad++; console.log(`FAIL ${ROLLUPS[id].name}: ${e.message}`); continue; }
  console.log(`ok   ${claim.name}: confirmed assertion ${claim.assertion.slice(0, 14)}… created at Ethereum block ${claim.createdAtBlock}, commits to rollup block ${claim.blockHash}; ${Date.now() - t} ms`);
  try {
    const got = await rollupTokenParam({ claim, chainId: id, org: PROJECTS[id], token: '0' });
    console.log(`     ${got.known ? `root ${got.root} isSet ${got.isSet}` : got.why} at rollup block ${got.block.number} (${((now - got.block.timestamp) / 86400).toFixed(2)} days old) via ${got.via}`);
  } catch (e) { console.log(`     no proof at that block: ${e.message.slice(0, 120)}`); }
}
process.exit(bad ? 1 : 0);
