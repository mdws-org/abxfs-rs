// The light client against recorded beacon replies (tests/fixtures/light/*.json, written by light-record.mjs),
// offline. First each recording is replayed as it was and must give the recorded result. Then one lie at a time
// is planted in the replies or the clock, and every one must be refused.
//
// usage: node tests/light-replay.mjs [path to light.js]
//   The optional path runs the same cases against another copy of the client; tests/light-mutants.mjs uses it
//   to show that these cases fail when a check is removed from the client.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const { NETWORKS, sync } = await import(process.argv[2] || '../site/light.js');
const dir = join(here, 'fixtures/light');
const BOOT = '/eth/v1/beacon/light_client/bootstrap/', FIN = '/eth/v1/beacon/light_client/finality_update', UPD = '/eth/v1/beacon/light_client/updates';

// Flip one hex digit of a 0x string.
const flip = (hex, at = 10) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
const DAY = 86_400_000;

// name, which recordings it applies to, and a function that edits (replies, clock) in place.
const LIES = [
  ['signature: one digit changed', 'any', (r) => { const s = r[FIN].data.sync_aggregate; s.sync_committee_signature = flip(s.sync_committee_signature, 40); }],
  ['signature: replaced by the point at infinity', 'any', (r) => { r[FIN].data.sync_aggregate.sync_committee_signature = '0xc0' + '00'.repeat(95); }],
  ['participation: one member added or removed', 'any', (r) => { const s = r[FIN].data.sync_aggregate; s.sync_committee_bits = flip(s.sync_committee_bits, 5); }],
  ['participation: under two thirds, with a signature nobody checked', 'any', (r) => { r[FIN].data.sync_aggregate.sync_committee_bits = '0x' + 'ff'.repeat(40) + '00'.repeat(24); }],
  ['signed header: state root changed', 'any', (r) => { const b = r[FIN].data.attested_header.beacon; b.state_root = flip(b.state_root); }],
  ['signed header: slot changed', 'any', (r) => { const b = r[FIN].data.attested_header.beacon; b.slot = String(Number(b.slot) - 1); }],
  ['signature slot: not after the signed header', 'any', (r) => { r[FIN].data.signature_slot = r[FIN].data.attested_header.beacon.slot; }],
  ['signature slot: moved into the next fork version or period', 'any', (r) => { r[FIN].data.signature_slot = String(Number(r[FIN].data.signature_slot) + 8192); }],
  ['finalized header: state root changed', 'any', (r) => { const b = r[FIN].data.finalized_header.beacon; b.state_root = flip(b.state_root); }],
  ['finalized header: body root changed', 'any', (r) => { const b = r[FIN].data.finalized_header.beacon; b.body_root = flip(b.body_root); }],
  ['finality branch: one node changed', 'any', (r) => { const f = r[FIN].data.finality_branch; f[f.length - 1] = flip(f[f.length - 1]); }],
  ['finality branch: one node dropped', 'any', (r) => { r[FIN].data.finality_branch.pop(); }],
  ['finalized header swapped for the signed header', 'any', (r) => { r[FIN].data.finalized_header = structuredClone(r[FIN].data.attested_header); }],
  ['execution branch: one node changed', 'any', (r) => { const x = r[FIN].data.finalized_header.execution_branch; x[0] = flip(x[0]); }],
  ['execution block hash changed (Gloas form)', 'gloas', (r) => { const h = r[FIN].data.finalized_header; h.execution_block_hash = flip(h.execution_block_hash); }],
  ['execution block hash changed (payload form)', 'payload', (r) => { const e = r[FIN].data.finalized_header.execution; e.block_hash = flip(e.block_hash); }],
  ['execution state root changed (payload form)', 'payload', (r) => { const e = r[FIN].data.finalized_header.execution; e.state_root = flip(e.state_root); }],
  ['execution block number changed (payload form)', 'payload', (r) => { const e = r[FIN].data.finalized_header.execution; e.block_number = String(Number(e.block_number) + 1); }],
  ['execution extra data lengthened (payload form)', 'payload', (r) => { r[FIN].data.finalized_header.execution.extra_data += '00'; }],
  ['bootstrap: another block', 'any', (r, c, k) => { const b = r[k.boot].data.header.beacon; b.proposer_index = String(Number(b.proposer_index) + 1); }],
  ['bootstrap: one committee key changed', 'any', (r, c, k) => { const p = r[k.boot].data.current_sync_committee.pubkeys; p[7] = flip(p[7], 30); }],
  ['bootstrap: two committee keys swapped', 'any', (r, c, k) => { const p = r[k.boot].data.current_sync_committee.pubkeys; [p[1], p[2]] = [p[2], p[1]]; }],
  ['bootstrap: committee branch changed', 'any', (r, c, k) => { const x = r[k.boot].data.current_sync_committee_branch; x[1] = flip(x[1]); }],
  ['bootstrap: aggregate key changed', 'any', (r, c, k) => { const s = r[k.boot].data.current_sync_committee; s.aggregate_pubkey = s.pubkeys[0]; }],
  ['next committee: one key changed', 'handover', (r, c, k) => { const p = r[k.upd][0].data.next_sync_committee.pubkeys; p[100] = flip(p[100], 30); }],
  ['next committee: replaced by the current one', 'handover', (r, c, k) => { r[k.upd][0].data.next_sync_committee = structuredClone(r[k.boot].data.current_sync_committee); }],
  ['next committee branch: one node changed', 'handover', (r, c, k) => { const x = r[k.upd][0].data.next_sync_committee_branch; x[2] = flip(x[2]); }],
  ['period update: signature changed', 'handover', (r, c, k) => { const s = r[k.upd][0].data.sync_aggregate; s.sync_committee_signature = flip(s.sync_committee_signature, 60); }],
  ['period update: left out', 'handover', (r, c, k) => { r[k.upd] = []; }],
  ['period update: the finality update offered in its place', 'handover', (r, c, k) => { r[k.upd] = [{ version: r[FIN].version, data: structuredClone(r[FIN].data) }]; }],
  ['clock: the shipped block is 15 days old', 'any', (r, c) => { c.now += 15 * DAY; }],
  ['clock: the newest finalized block is two hours old', 'any', (r, c) => { c.now += 2 * 3_600_000; }],
  ['clock: this device is two hours slow', 'any', (r, c) => { c.now -= 2 * 3_600_000; }],
  ['network: replies from another chain\'s rules', 'any', (r, c) => { c.network = c.network === 1 ? 11155111 : 1; }],
];

const run = (fx, replies, clock) => sync({
  net: NETWORKS[clock.network], checkpoint: fx.checkpoint, now: () => clock.now,
  // A path that was not recorded is a server with nothing to give.
  get: async (path) => (path in replies ? structuredClone(replies[path]) : null),
});

let failed = 0, refused = 0;
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const keys = { boot: Object.keys(fx.replies).find((p) => p.startsWith(BOOT)), upd: Object.keys(fx.replies).find((p) => p.startsWith(UPD)) };
  const tags = new Set(['any', keys.upd ? 'handover' : 'same-period', fx.replies[FIN].data.finalized_header.execution_block_hash ? 'gloas' : 'payload']);

  // As recorded.
  try {
    const got = await run(fx, fx.replies, { now: fx.now, network: fx.network });
    const same = JSON.stringify(got) === JSON.stringify(fx.expect);
    console.log(`${same ? 'ok  ' : 'FAIL'} ${file}: as recorded, finalized slot ${got.finalizedSlot}, ${got.executionBlockHash}`);
    if (!same) failed++;
  } catch (e) { console.log(`FAIL ${file}: as recorded, but refused: ${e.message}`); failed++; }

  for (const [name, tag, plant] of LIES) {
    if (!tags.has(tag)) continue;
    const replies = structuredClone(fx.replies), clock = { now: fx.now, network: fx.network };
    plant(replies, clock, keys);
    try {
      const got = await run(fx, replies, clock);
      console.log(`FAIL ${file}: ${name}: ACCEPTED, execution block ${got.executionBlockHash}`);
      failed++;
    } catch (e) {
      if (e.constructor.name !== 'LightError') { console.log(`FAIL ${file}: ${name}: crashed instead of refusing: ${e.message}`); failed++; continue; }
      refused++;
      if (process.env.VERBOSE) console.log(`ok   ${file}: ${name}: ${e.message}`);
    }
  }
}
console.log(failed ? `${failed} FAILED` : `ok: every recording replays to its recorded result; ${refused} planted lies, all refused`);
process.exit(failed ? 1 : 0);
