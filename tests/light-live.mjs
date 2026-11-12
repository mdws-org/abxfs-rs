// The light client against live beacon nodes: from a finalized block root that two independent nodes report,
// to a finalized execution block hash, which an execution endpoint must know as a block.
// usage: node tests/light-live.mjs <mainnet|sepolia> [checkpoint root]
import { NETWORKS, sync } from '../site/light.js';

const SETS = {
  mainnet: { id: 1, beacon: ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'], rpc: 'https://ethereum-rpc.publicnode.com' },
  sepolia: { id: 11155111, beacon: ['https://lodestar-sepolia.chainsafe.io', 'https://ethereum-sepolia-beacon-api.publicnode.com'], rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
};
const [which = 'mainnet', given] = process.argv.slice(2);
const set = SETS[which], net = NETWORKS[set.id];
const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };

let checkpoint = given;
if (!checkpoint) {
  const roots = await Promise.all(set.beacon.map((b) => json(`${b}/eth/v1/beacon/headers/finalized`).then((j) => j.data.root)));
  if (new Set(roots).size !== 1) throw new Error(`the two beacon nodes report different finalized roots: ${roots.join(' ')}`);
  checkpoint = roots[0];
}
let requests = 0;
const t0 = Date.now();
const got = await sync({ net, checkpoint, get: (path) => { requests++; return json(set.beacon[0] + path); } });
console.log(`${net.name}: checkpoint ${checkpoint} (slot ${got.checkpointSlot}), ${got.periods} period(s) followed, ${requests} requests, ${Date.now() - t0} ms`);
console.log(`finalized slot ${got.finalizedSlot}, signed at slot ${got.signatureSlot} by ${got.participants} of 512; execution block ${got.executionBlockHash}`);
const block = (await (await fetch(set.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params: [got.executionBlockHash, false] }) })).json()).result;
if (!block) { console.log('FAIL: the execution endpoint does not know that block'); process.exit(1); }
console.log(`ok: the execution endpoint has it as block ${parseInt(block.number, 16)}, state root ${block.stateRoot}`);
