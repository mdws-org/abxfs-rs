// Record the beacon replies of one light-client run, so tests/light-replay.mjs can replay them offline.
// usage: node tests/light-record.mjs <mainnet|sepolia> <checkpoint root> <out.json>
import { NETWORKS, sync } from '../site/light.js';
import { writeFile } from 'node:fs/promises';
const BEACON = { mainnet: [1, 'https://lodestar-mainnet.chainsafe.io'], sepolia: [11155111, 'https://lodestar-sepolia.chainsafe.io'] };
const [which, checkpoint, out] = process.argv.slice(2);
const [id, base] = BEACON[which];
const replies = {}, now = Date.now();
const got = await sync({ net: NETWORKS[id], checkpoint, now: () => now, get: async (path) => (replies[path] = await (await fetch(base + path)).json()) });
await writeFile(out, JSON.stringify({ network: id, checkpoint, now, expect: got, replies }));
console.log(`recorded ${Object.keys(replies).length} replies: finalized slot ${got.finalizedSlot}, execution block ${got.executionBlockHash}`);
