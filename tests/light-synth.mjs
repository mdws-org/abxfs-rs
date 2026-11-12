// The light client against a made-up chain whose committee keys this test holds. Recorded mainnet replies cannot
// show what happens to a header that is validly signed and breaks exactly one rule; here every such header can be
// built: signed by too few members, signed by keys that cancel out, proved by a padded branch, and so on.
//
// usage: node tests/light-synth.mjs [path to light.js]
import { sha256 } from '../site/vendor/noble/hashes/sha2.js';
import { bls12_381 } from '../site/vendor/noble/curves/bls12-381.js';

const L = await import(process.argv[2] || '../site/light.js');
const G1 = bls12_381.G1.Point, long = bls12_381.longSignatures, ORDER = bls12_381.fields.Fr.ORDER;
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';
const hex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const h2 = (a, b) => sha256(cat(a, b));
let seed = 1;
const rand32 = () => sha256(Uint8Array.of(seed++, seed >> 8, 7));

// A network of our own: Gloas form from the start, so headers carry an execution block hash and a branch.
const net = { name: 'synthetic', genesisTime: 1_700_000_000, genesisValidatorsRoot: hex(rand32()), forks: [['electra', 0, '0x0a000001'], ['gloas', 0, '0x0a000002']], gloas: 0 };
const GI = { finalized: 735, current: 2945, next: 2946, blockHash: 2856 };

// A tree that holds `leaf` at `gindex`, with made-up siblings: returns the branch and the root it leads to.
function plant(leaf, gindex) {
  const depth = Math.floor(Math.log2(gindex));
  const branch = [];
  let value = leaf, index = gindex - 2 ** depth;
  for (let i = 0; i < depth; i++) {
    const sib = rand32();
    branch.push(sib);
    value = index % 2 ? h2(sib, value) : h2(value, sib);
    index = Math.floor(index / 2);
  }
  return { branch, root: value };
}

// A committee: 512 keys we know. `secrets` are scalars; the aggregate of a set of signers is one scalar sum.
function committee(secrets) {
  const pts = secrets.map((s) => G1.BASE.multiply(s));
  const sum = pts.reduce((a, p) => a.add(p), G1.ZERO);
  // The point at infinity in compressed form is 0xc0 followed by zeros.
  const c = { pubkeys: pts.map((p) => p.toBytes()), aggregatePubkey: sum.is0() ? Uint8Array.of(0xc0, ...new Uint8Array(47)) : sum.toBytes() };
  return { secrets, c, json: { pubkeys: c.pubkeys.map(hex), aggregate_pubkey: hex(c.aggregatePubkey) }, root: L.syncCommitteeRoot(c) };
}
const plain = (base) => committee(Array.from({ length: 512 }, (_, i) => BigInt(base + i)));

// A header at `slot` whose state holds `stateLeaf` at `stateGindex` (if given) and whose body holds a block hash.
function header(slot, stateLeaf, stateGindex) {
  const blockHash = rand32(), body = plant(blockHash, GI.blockHash);
  const state = stateLeaf ? plant(stateLeaf, stateGindex) : { branch: [], root: rand32() };
  const beacon = { slot, proposerIndex: 3, parentRoot: rand32(), stateRoot: state.root, bodyRoot: body.root };
  return {
    beacon, blockHash, stateBranch: state.branch, root: L.beaconBlockHeaderRoot(beacon),
    json: {
      beacon: { slot: String(slot), proposer_index: '3', parent_root: hex(beacon.parentRoot), state_root: hex(beacon.stateRoot), body_root: hex(beacon.bodyRoot) },
      execution_block_hash: hex(blockHash), execution_branch: body.branch.map(hex),
    },
  };
}
// The sync aggregate of `signers` (indices) of committee `com` over header `h`, signed at `signatureSlot`.
function sign(com, h, signatureSlot, signers) {
  const domain = L.compute_domain(net, L.compute_fork_version(net, Math.floor((signatureSlot - 1) / 32)));
  const message = long.hash(h2(h.root, domain), DST);
  const sum = signers.reduce((a, i) => (a + com.secrets[i]) % ORDER, 0n);
  const bits = new Uint8Array(64);
  for (const i of signers) bits[i >> 3] |= 1 << (i & 7);
  const sig = sum === 0n ? Uint8Array.of(0xc0, ...new Uint8Array(95)) : long.Signature.toBytes(message.multiply(sum));
  return { sync_committee_bits: hex(bits), sync_committee_signature: hex(sig) };
}
const first = (n) => Array.from({ length: n }, (_, i) => i);

// The chain: a shipped block in period 3, one hand-over to period 4, and a finality update in period 4.
const P = 8192;
function chain({ signers = first(512), periodSigners = first(512), com0 = plain(1000), com1 = plain(5000), padBootstrap, padFinality, skipPeriod, lateBoot } = {}) {
  // `lateBoot`: the shipped block is in period 4, after the block the finality update names.
  const boot = lateBoot ? header(4 * P + 352, com1.root, GI.current) : header(3 * P + 100, com0.root, GI.current);
  const turn = header(3 * P + 4000, com1.root, GI.next);
  const fin = header(4 * P + 320);
  const att = header(4 * P + 400, fin.root, GI.finalized);
  const pad = (branch, with_) => (with_ ? [with_, ...branch] : branch).map(hex);
  const replies = {
    [`/eth/v1/beacon/light_client/bootstrap/${hex(boot.root)}`]: { data: { header: boot.json, current_sync_committee: (lateBoot ? com1 : com0).json, current_sync_committee_branch: pad(boot.stateBranch, padBootstrap) } },
    '/eth/v1/beacon/light_client/updates?start_period=3&count=1': skipPeriod ? [] : [{ data: {
      attested_header: turn.json, next_sync_committee: com1.json, next_sync_committee_branch: turn.stateBranch.map(hex),
      sync_aggregate: sign(com0, turn, turn.beacon.slot + 1, periodSigners), signature_slot: String(turn.beacon.slot + 1),
    } }],
    '/eth/v1/beacon/light_client/finality_update': { data: {
      attested_header: att.json, finalized_header: fin.json, finality_branch: pad(att.stateBranch, padFinality),
      sync_aggregate: sign(com1, att, att.beacon.slot + 1, signers), signature_slot: String(att.beacon.slot + 1),
    } },
  };
  return { replies, checkpoint: hex(boot.root), now: (net.genesisTime + (att.beacon.slot + 3) * 12) * 1000, want: hex((lateBoot ? boot : fin).blockHash) };
}
const run = (c, now = c.now) => L.sync({ net, checkpoint: c.checkpoint, now: () => now, get: async (path) => c.replies[path] ?? null });

// Keys that cancel: member 2k+1 holds the negation of member 2k's secret, so all 512 together sum to nothing.
const cancelling = () => committee(Array.from({ length: 512 }, (_, i) => (i % 2 ? ORDER - BigInt(9000 + i - 1) : BigInt(9000 + i))));
const ZERO = new Uint8Array(32);

// [name, the chain, what must happen: 'accept', or the kind of refusal]
const CASES = [
  ['an honest chain with a hand-over', () => chain(), 'accept'],
  ['exactly two thirds sign (342 of 512)', () => chain({ signers: first(342) }), 'accept'],
  ['one fewer than two thirds signs (341), validly', () => chain({ signers: first(341) }), 'check'],
  ['the hand-over is signed by 341, validly', () => chain({ periodSigners: first(341) }), 'check'],
  ['all 512 sign, but their keys cancel to nothing and the signature is the point at infinity', () => chain({ com1: cancelling() }), 'check'],
  ['a branch padded with a zero entry, as a client upgraded across a fork sends it', () => chain({ padFinality: ZERO, padBootstrap: ZERO }), 'accept'],
  ['a finality branch padded with a non-zero entry', () => chain({ padFinality: rand32() }), 'check'],
  ['a bootstrap branch padded with a non-zero entry', () => chain({ padBootstrap: rand32() }), 'check'],
  ['the server still offers the finalized block before the shipped one: the shipped block is used', () => chain({ lateBoot: true }), 'accept'],
  ['the hand-over update is withheld', () => chain({ skipPeriod: true }), 'check'],
  ['the shipped block is more than 14 days old', () => chain(), 'stale', (c) => c.now + 13.6 * 86_400_000],
  ['the newest finalized block is 257 slots old', () => chain(), 'old', (c) => c.now + (257 - 83) * 12_000],
  ['the newest finalized block is 250 slots old', () => chain(), 'accept', (c) => c.now + (250 - 83) * 12_000],
];

let failed = 0;
for (const [name, build, want, clock] of CASES) {
  const c = build();
  let got;
  try { const r = await run(c, clock ? clock(c) : c.now); got = r.executionBlockHash === c.want ? 'accept' : `accepted the wrong block ${r.executionBlockHash}`; }
  catch (e) { got = e.constructor.name === 'LightError' ? e.kind : `crash: ${e.message}`; }
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${ok ? got : `wanted ${want}, got ${got}`}`);
}
console.log(failed ? `${failed} FAILED` : `ok: ${CASES.length} synthetic cases`);
process.exit(failed ? 1 : 0);
