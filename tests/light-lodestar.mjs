// Our light client and Lodestar's, on the same recorded replies and the same planted lies: both must accept the
// recording and refuse each lie. Lodestar is used here only as a second implementation to compare with; it is not
// part of the viewer. Its packages are read from LODESTAR_DIR (a directory with node_modules/@lodestar).
// usage: LODESTAR_DIR=<dir> node tests/light-lodestar.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NETWORKS, sync } from '../site/light.js';

// Lodestar's files are imported by path: its packages are ES modules and do not export every file by name.
const mods = (process.env.LODESTAR_DIR || '/Users/bemeadows/Projects/.lanes/abxfs-p3-spike') + '/node_modules/@lodestar/';
const lib = mods + 'light-client/lib/';
const { validateLightClientBootstrap } = await import(lib + 'spec/validateLightClientBootstrap.js');
const spec = await import(lib + 'spec/validateLightClientUpdate.js');
const { deserializeSyncCommittee } = await import(lib + 'utils/utils.js');
const { sszTypesFor } = await import(mods + 'types/lib/index.js');
const { createBeaconConfig } = await import(mods + 'config/lib/index.js');
const { networksChainConfig } = await import(mods + 'config/lib/networks.js');

const dir = join(new URL('.', import.meta.url).pathname, 'fixtures/light');
const BOOT = '/eth/v1/beacon/light_client/bootstrap/', FIN = '/eth/v1/beacon/light_client/finality_update', UPD = '/eth/v1/beacon/light_client/updates';
const fb = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));
const flip = (hex, i = 10) => hex.slice(0, i) + (hex[i] === '0' ? '1' : '0') + hex.slice(i + 1);
const NAMES = { 1: 'mainnet', 11155111: 'sepolia' };

// Lies in the data itself (the clock rules and the two-thirds rule are ours alone and are not compared).
const LIES = [
  ['signature changed', (r) => { const s = r[FIN].data.sync_aggregate; s.sync_committee_signature = flip(s.sync_committee_signature, 40); }],
  ['participation bit changed', (r) => { const s = r[FIN].data.sync_aggregate; s.sync_committee_bits = flip(s.sync_committee_bits, 5); }],
  ['signed header state root changed', (r) => { const b = r[FIN].data.attested_header.beacon; b.state_root = flip(b.state_root); }],
  ['signed header slot changed', (r) => { const b = r[FIN].data.attested_header.beacon; b.slot = String(Number(b.slot) - 1); }],
  ['signature slot not after the header', (r) => { r[FIN].data.signature_slot = r[FIN].data.attested_header.beacon.slot; }],
  ['finalized header state root changed', (r) => { const b = r[FIN].data.finalized_header.beacon; b.state_root = flip(b.state_root); }],
  ['finalized header body root changed', (r) => { const b = r[FIN].data.finalized_header.beacon; b.body_root = flip(b.body_root); }],
  ['finality branch node changed', (r) => { const f = r[FIN].data.finality_branch; f[f.length - 1] = flip(f[f.length - 1]); }],
  ['execution branch node changed', (r) => { const x = r[FIN].data.finalized_header.execution_branch; x[0] = flip(x[0]); }],
  ['execution state root changed', (r) => { const e = r[FIN].data.finalized_header.execution; if (e) e.state_root = flip(e.state_root); else r[FIN].data.finalized_header.execution_block_hash = flip(r[FIN].data.finalized_header.execution_block_hash); }],
  ['bootstrap is another block', (r, k) => { const b = r[k.boot].data.header.beacon; b.proposer_index = String(Number(b.proposer_index) + 1); }],
  ['bootstrap committee key changed', (r, k) => { const p = r[k.boot].data.current_sync_committee.pubkeys; [p[1], p[2]] = [p[2], p[1]]; }],
  ['bootstrap committee branch changed', (r, k) => { const x = r[k.boot].data.current_sync_committee_branch; x[1] = flip(x[1]); }],
  ['next committee keys swapped', (r, k) => { if (!k.upd) return 'skip'; const p = r[k.upd][0].data.next_sync_committee.pubkeys; [p[3], p[4]] = [p[4], p[3]]; }],
  ['next committee branch changed', (r, k) => { if (!k.upd) return 'skip'; const x = r[k.upd][0].data.next_sync_committee_branch; x[2] = flip(x[2]); }],
  ['period update signature changed', (r, k) => { if (!k.upd) return 'skip'; const s = r[k.upd][0].data.sync_aggregate; s.sync_committee_signature = flip(s.sync_committee_signature, 60); }],
];

async function ours(fx, replies) {
  try { await sync({ net: NETWORKS[fx.network], checkpoint: fx.checkpoint, now: () => fx.now, get: async (p) => (p in replies ? structuredClone(replies[p]) : null) }); return 'accept'; }
  catch (e) { return e.constructor.name === 'LightError' ? 'refuse' : `crash: ${e.message}`; }
}
// Lodestar's checks in the same order: bootstrap, each period update with that period's committee, then the
// finality update with the committee of its signature's period.
function theirs(fx, replies, keys) {
  const config = createBeaconConfig(networksChainConfig[NAMES[fx.network]], fb(NETWORKS[fx.network].genesisValidatorsRoot));
  const store = { config };
  try {
    const b = replies[keys.boot];
    const boot = sszTypesFor(b.version).LightClientBootstrap.fromJson(b.data);
    validateLightClientBootstrap(config, fb(fx.checkpoint), boot);
    let committee = deserializeSyncCommittee(boot.currentSyncCommittee);
    for (const item of keys.upd ? replies[keys.upd] : []) {
      const u = sszTypesFor(item.version).LightClientUpdate.fromJson(item.data);
      spec.validateLightClientUpdate(config, store, u, committee);
      committee = deserializeSyncCommittee(u.nextSyncCommittee);
    }
    const f = replies[FIN];
    const fin = sszTypesFor(f.version).LightClientFinalityUpdate.fromJson(f.data);
    const zero = sszTypesFor(f.version).LightClientUpdate.defaultValue();
    spec.validateLightClientUpdate(config, store, { ...zero, ...fin }, committee);
    return 'accept';
  } catch (e) { return `refuse (${String(e.message).slice(0, 60)})`; }
}

let bad = 0, compared = 0;
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const keys = { boot: Object.keys(fx.replies).find((p) => p.startsWith(BOOT)), upd: Object.keys(fx.replies).find((p) => p.startsWith(UPD)) };
  const honest = theirs(fx, fx.replies, keys);
  if (honest !== 'accept') { console.log(`     ${file}: Lodestar cannot read this recording, so it is not compared (${honest})`); continue; }
  const mine = await ours(fx, fx.replies);
  console.log(`${mine === 'accept' ? 'ok  ' : 'FAIL'} ${file}: as recorded, both accept`);
  bad += mine !== 'accept';
  for (const [name, plant] of LIES) {
    const replies = structuredClone(fx.replies);
    if (plant(replies, keys) === 'skip') continue;
    const a = await ours(fx, replies), b = theirs(fx, replies, keys).split(' ')[0];
    compared++;
    if (a !== 'refuse' || b !== 'refuse') { bad++; console.log(`FAIL ${file}: ${name}: ours ${a}, Lodestar ${b}`); }
  }
}
console.log(bad ? `${bad} FAILED` : `ok: ${compared} lies refused by both clients`);
process.exit(bad ? 1 : 0);
