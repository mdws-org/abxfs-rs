// Record the Base endpoint's replies for one read of a token parameter at a claim's L2 block, for base-replay.
// usage: node tests/base-record.mjs <out.json>
import { writeFile } from 'node:fs/promises';
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock } from '../site/proved.js';
import { baseClaims, baseTokenParam } from '../site/base.js';
const ORG = '0xab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6', URL_ = 'https://base-mainnet.public.blastapi.io';
const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
const { latest } = await baseClaims({ fin, urls: PROOF_ENDPOINTS[1] });
const real = globalThis.fetch, replies = {};
globalThis.fetch = async (url, init) => { const r = await real(url, init); const text = await r.text(); replies[init.body] = text; return new Response(text, { status: r.status }); };
const expect = await baseTokenParam({ claim: latest, urls: [URL_], org: ORG, token: '0' });
// A contract on Base that is not an ABX collection (WETH), read the same way: it must be reported as unknown.
const OTHER = '0x4200000000000000000000000000000000000006';
const other = await baseTokenParam({ claim: latest, urls: [URL_], org: OTHER, token: '0' });
await writeFile(process.argv[2], JSON.stringify({ claim: latest, org: ORG, other: OTHER, otherKnown: other.known, url: URL_, expect, replies }));
console.log(`recorded ${Object.keys(replies).length} replies: root ${expect.root} at L2 block ${expect.block.number}`);
