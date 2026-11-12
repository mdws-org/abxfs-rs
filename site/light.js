// An Ethereum light client: from a block root shipped with the viewer to the hash of a finalized execution block,
// trusting no server. It follows the consensus-specs light-client sync protocol (Electra/Fulu and Gloas forms);
// function names match the spec's so the two can be read side by side.
//
// What is checked: the bootstrap header hashes to the shipped root; each sync committee is proved into a header's
// state by a Merkle branch; every header used is signed by at least two thirds of the 512-member committee for its
// period (BLS12-381 aggregate signature); periods are followed one by one, none skipped; the finalized header is
// proved into the signed header's state; the execution block hash is proved into the finalized header's body.
// What is trusted: the shipped root, and that fewer than two thirds of each committee since it would sign a lie.
//
// The curve arithmetic and SHA-256 are @noble/curves and @noble/hashes (site/vendor/noble, pinned by SHA256SUMS).

import { sha256 } from './vendor/noble/hashes/sha2.js';
import { bls12_381 } from './vendor/noble/curves/bls12-381.js';

const SLOTS_PER_EPOCH = 32;
const SLOTS_PER_PERIOD = 8192; // EPOCHS_PER_SYNC_COMMITTEE_PERIOD (256) * SLOTS_PER_EPOCH
const SECONDS_PER_SLOT = 12;
const SYNC_COMMITTEE_SIZE = 512;
const DOMAIN_SYNC_COMMITTEE = Uint8Array.of(7, 0, 0, 0);
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';

// Generalized indices (consensus-specs, light-client/sync-protocol.md of each fork).
const GINDEX = {
  electra: { finalizedRoot: 169, currentSyncCommittee: 86, nextSyncCommittee: 87 },
  gloas: { finalizedRoot: 735, currentSyncCommittee: 2945, nextSyncCommittee: 2946 },
};
const EXECUTION_PAYLOAD_GINDEX = 25; // BeaconBlockBody.execution_payload (Capella to Fulu)
const EXECUTION_BLOCK_HASH_GINDEX_DENEB = 812; // BeaconBlockBody.execution_payload.block_hash (Deneb to Fulu)
const EXECUTION_BLOCK_HASH_GINDEX_GLOAS = 2856; // BeaconBlockBody.signed_execution_payload_bid.message.parent_block_hash

// The weak-subjectivity period is 3,532 epochs (15.7 days) at mainnet's stake (specs/electra/weak-subjectivity.md).
// A shipped root older than this bound is refused, so a build that is never refreshed stops claiming proof.
const MAX_CHECKPOINT_AGE_SLOTS = 14 * 7200;
// A finalized header is normally 64 to 96 slots behind the head. Past this, finality has stalled or the server
// is withholding, and nothing is claimed.
const MAX_FINALIZED_AGE_SLOTS = 256;
const MAX_PERIODS = 20; // 14 days is 13 periods; a server cannot make the client verify more

// Genesis and fork schedule per network, read from two independent beacon nodes on 2026-11-11. `gloas: null`
// means the fork has no date there yet; a header at or past an unknown fork fails its branch checks.
const NETWORKS = {
  1: {
    name: 'Ethereum', genesisTime: 1606824023,
    genesisValidatorsRoot: '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95',
    forks: [['electra', 364032, '0x05000000'], ['fulu', 411392, '0x06000000']], gloas: null,
  },
  11155111: {
    name: 'Sepolia', genesisTime: 1655733600,
    genesisValidatorsRoot: '0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078',
    forks: [['electra', 222464, '0x90000074'], ['fulu', 272640, '0x90000075'], ['gloas', 353024, '0x90000076']], gloas: 353024,
  },
};

class LightError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const refuse = (message) => { throw new LightError('check', message); };

// ---- bytes ----
const HEX = /^0x([0-9a-f]{2})*$/i;
function bytes(hex, length, what) {
  if (typeof hex !== 'string' || !HEX.test(hex) || (length !== undefined && hex.length !== 2 + 2 * length)) refuse(`${what} is not ${length ?? 'hex'} bytes`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 + 2 * i, 2), 16);
  return out;
}
const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
function uint(s, what) {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(s)) refuse(`${what} is not a number`);
  return Number(s);
}
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ZERO = new Uint8Array(32);
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const hash = (a, b) => sha256(concat(a, b));

// ---- SSZ hash_tree_root, for the few types a light client meets ----
const ZERO_HASHES = [ZERO];
for (let i = 1; i < 16; i++) ZERO_HASHES.push(hash(ZERO_HASHES[i - 1], ZERO_HASHES[i - 1]));
// merkleize: `chunks` are 32-byte leaves, padded with zero leaves to `limit` (a power of two).
function merkleize(chunks, limit) {
  let depth = 0;
  while ((1 << depth) < limit) depth++;
  if (chunks.length > limit) refuse('too many chunks');
  let layer = chunks;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(hash(layer[i], i + 1 < layer.length ? layer[i + 1] : ZERO_HASHES[d]));
    layer = next.length ? next : [ZERO_HASHES[d + 1]];
  }
  return layer[0] ?? ZERO_HASHES[depth];
}
function uintChunk(n, size = 8) { // little-endian, right-padded to 32 bytes
  const out = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 0; i < size; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function chunksOf(u) { // pack bytes into 32-byte chunks, the last right-padded
  const out = [];
  for (let i = 0; i < u.length; i += 32) { const c = new Uint8Array(32); c.set(u.subarray(i, i + 32)); out.push(c); }
  return out;
}

function beaconBlockHeaderRoot(h) {
  return merkleize([uintChunk(h.slot), uintChunk(h.proposerIndex), h.parentRoot, h.stateRoot, h.bodyRoot], 8);
}
// deneb.ExecutionPayloadHeader, unchanged through Fulu: 17 fields.
function executionPayloadHeaderRoot(e) {
  const extra = merkleize(chunksOf(e.extraData), 1);
  return merkleize([
    e.parentHash, chunksOf(e.feeRecipient)[0], e.stateRoot, e.receiptsRoot, merkleize(chunksOf(e.logsBloom), 8), e.prevRandao,
    uintChunk(e.blockNumber), uintChunk(e.gasLimit), uintChunk(e.gasUsed), uintChunk(e.timestamp),
    hash(extra, uintChunk(e.extraData.length)), uintChunk(e.baseFeePerGas, 32), e.blockHash, e.transactionsRoot, e.withdrawalsRoot,
    uintChunk(e.blobGasUsed), uintChunk(e.excessBlobGas),
  ], 32);
}
function syncCommitteeRoot(c) {
  const pubkeyRoot = (pk) => merkleize(chunksOf(pk), 2);
  return hash(merkleize(c.pubkeys.map(pubkeyRoot), SYNC_COMMITTEE_SIZE), pubkeyRoot(c.aggregatePubkey));
}

// ---- Merkle branches ----
function is_valid_merkle_branch(leaf, branch, depth, index, root) {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = (Math.floor(index / 2 ** i) % 2) ? hash(branch[i], value) : hash(value, branch[i]);
  return equal(value, root);
}
// A branch may be longer than its index needs (a client upgraded across a fork pads it); the extra leading
// entries must be zero.
function is_valid_normalized_merkle_branch(leaf, branch, gindex, root) {
  const depth = Math.floor(Math.log2(gindex)), index = gindex - 2 ** depth;
  const extra = branch.length - depth;
  if (extra < 0) return false;
  for (let i = 0; i < extra; i++) if (!equal(branch[i], ZERO)) return false;
  return is_valid_merkle_branch(leaf, branch.slice(extra), depth, index, root);
}

// ---- forks ----
const epochAt = (slot) => Math.floor(slot / SLOTS_PER_EPOCH);
const periodAt = (slot) => Math.floor(slot / SLOTS_PER_PERIOD);
function formAt(net, slot) { // which set of generalized indices a header at `slot` uses
  const epoch = epochAt(slot);
  if (net.gloas !== null && epoch >= net.gloas) return 'gloas';
  if (epoch >= net.forks[0][1]) return 'electra';
  refuse(`slot ${slot} is before the oldest fork this client reads`);
}
function compute_fork_version(net, epoch) {
  for (let i = net.forks.length - 1; i >= 0; i--) if (epoch >= net.forks[i][1]) return bytes(net.forks[i][2], 4, 'fork version');
  refuse(`epoch ${epoch} is before the oldest fork this client reads`);
}
function compute_domain(net, forkVersion) {
  const versionChunk = new Uint8Array(32);
  versionChunk.set(forkVersion);
  const forkDataRoot = hash(versionChunk, bytes(net.genesisValidatorsRoot, 32, 'genesis validators root'));
  return concat(DOMAIN_SYNC_COMMITTEE, forkDataRoot.subarray(0, 28));
}
const compute_signing_root = (objectRoot, domain) => hash(objectRoot, domain);

// ---- parsing the beacon API's JSON ----
const branchOf = (list, what) => {
  if (!Array.isArray(list) || list.length > 16) refuse(`${what} is not a branch`);
  return list.map((x) => bytes(x, 32, what));
};
function parseHeader(h, what) {
  if (!h || !h.beacon) refuse(`${what} has no beacon header`);
  const b = h.beacon;
  const out = {
    beacon: {
      slot: uint(b.slot, `${what} slot`), proposerIndex: uint(b.proposer_index, `${what} proposer index`),
      parentRoot: bytes(b.parent_root, 32, `${what} parent root`), stateRoot: bytes(b.state_root, 32, `${what} state root`),
      bodyRoot: bytes(b.body_root, 32, `${what} body root`),
    },
    executionBranch: branchOf(h.execution_branch, `${what} execution branch`),
  };
  if (h.execution_block_hash !== undefined) out.executionBlockHash = bytes(h.execution_block_hash, 32, `${what} execution block hash`);
  else {
    const e = h.execution || refuse(`${what} has no execution data`);
    const base = BigInt(typeof e.base_fee_per_gas === 'string' && /^[0-9]{1,78}$/.test(e.base_fee_per_gas) ? e.base_fee_per_gas : refuse(`${what} base fee is not a number`));
    out.execution = {
      parentHash: bytes(e.parent_hash, 32, 'parent hash'), feeRecipient: bytes(e.fee_recipient, 20, 'fee recipient'),
      stateRoot: bytes(e.state_root, 32, 'state root'), receiptsRoot: bytes(e.receipts_root, 32, 'receipts root'),
      logsBloom: bytes(e.logs_bloom, 256, 'logs bloom'), prevRandao: bytes(e.prev_randao, 32, 'prev randao'),
      blockNumber: uint(e.block_number, 'block number'), gasLimit: uint(e.gas_limit, 'gas limit'), gasUsed: uint(e.gas_used, 'gas used'),
      timestamp: uint(e.timestamp, 'timestamp'), extraData: bytes(e.extra_data, undefined, 'extra data'), baseFeePerGas: base,
      blockHash: bytes(e.block_hash, 32, 'block hash'), transactionsRoot: bytes(e.transactions_root, 32, 'transactions root'),
      withdrawalsRoot: bytes(e.withdrawals_root, 32, 'withdrawals root'),
      blobGasUsed: uint(e.blob_gas_used, 'blob gas used'), excessBlobGas: uint(e.excess_blob_gas, 'excess blob gas'),
    };
    if (out.execution.extraData.length > 32) refuse('extra data is longer than 32 bytes');
  }
  return out;
}
function parseSyncCommittee(c, what) {
  if (!c || !Array.isArray(c.pubkeys) || c.pubkeys.length !== SYNC_COMMITTEE_SIZE) refuse(`${what} does not have ${SYNC_COMMITTEE_SIZE} keys`);
  return { pubkeys: c.pubkeys.map((p) => bytes(p, 48, `${what} key`)), aggregatePubkey: bytes(c.aggregate_pubkey, 48, `${what} aggregate key`) };
}

// ---- the checks ----
// Returns the header's execution block hash once it is proved into the beacon body. In the Gloas form the hash
// is the leaf itself (and, from the Gloas fork on, names the parent block's payload); before that the whole
// execution payload header is hashed and proved, and its block_hash field is read.
function is_valid_light_client_header(net, header) {
  const slot = header.beacon.slot;
  if (header.executionBlockHash) {
    const gindex = formAt(net, slot) === 'gloas' ? EXECUTION_BLOCK_HASH_GINDEX_GLOAS : EXECUTION_BLOCK_HASH_GINDEX_DENEB;
    if (!is_valid_normalized_merkle_branch(header.executionBlockHash, header.executionBranch, gindex, header.beacon.bodyRoot)) refuse(`the execution block hash at slot ${slot} is not in the beacon body`);
    return header.executionBlockHash;
  }
  if (formAt(net, slot) === 'gloas') refuse(`the header at slot ${slot} has the form of an older fork`);
  if (!is_valid_normalized_merkle_branch(executionPayloadHeaderRoot(header.execution), header.executionBranch, EXECUTION_PAYLOAD_GINDEX, header.beacon.bodyRoot)) refuse(`the execution payload at slot ${slot} is not in the beacon body`);
  return header.execution.blockHash;
}

// A committee's keys as curve points, decoded once. The keys are bound to a proved committee root, and the chain
// validated each one when its validator deposited, so they are not subgroup-checked again here.
const points = new WeakMap();
function pointsOf(committee) {
  if (!points.has(committee)) points.set(committee, committee.pubkeys.map((pk) => bls12_381.G1.Point.fromBytes(pk)));
  return points.get(committee);
}
function eth_fast_aggregate_verify(committee, bits, signingRoot, signature) {
  const all = pointsOf(committee);
  let aggregate = bls12_381.G1.Point.ZERO;
  for (let i = 0; i < SYNC_COMMITTEE_SIZE; i++) if ((bits[i >> 3] >> (i & 7)) & 1) aggregate = aggregate.add(all[i]);
  if (aggregate.is0()) return false;
  let sig;
  try {
    sig = bls12_381.longSignatures.Signature.fromBytes(signature);
    sig.assertValidity();
  } catch { return false; }
  return bls12_381.longSignatures.verify(sig, bls12_381.longSignatures.hash(signingRoot, DST), aggregate);
}

// One update, checked against the committee of its signature's period. `want` says which parts must be present.
// Returns { attested, finalized?, nextSyncCommittee?, participants }.
function validate_light_client_update(net, committee, raw, want) {
  const attested = parseHeader(raw.attested_header, 'attested header');
  const signatureSlot = uint(raw.signature_slot, 'signature slot');
  const bits = bytes(raw.sync_aggregate?.sync_committee_bits, SYNC_COMMITTEE_SIZE / 8, 'sync committee bits');
  const signature = bytes(raw.sync_aggregate?.sync_committee_signature, 96, 'sync committee signature');
  let participants = 0;
  for (const b of bits) for (let x = b; x; x &= x - 1) participants++;
  if (participants * 3 < SYNC_COMMITTEE_SIZE * 2) refuse(`only ${participants} of ${SYNC_COMMITTEE_SIZE} committee members signed the header at slot ${attested.beacon.slot}`);
  if (signatureSlot <= attested.beacon.slot) refuse('the signature is not after the header it signs');
  is_valid_light_client_header(net, attested);
  const form = GINDEX[formAt(net, attested.beacon.slot)];
  const out = { attested, signatureSlot, participants };

  if (want.finalized) {
    const finalized = parseHeader(raw.finalized_header, 'finalized header');
    if (finalized.beacon.slot > attested.beacon.slot) refuse('the finalized header is after the header that names it');
    out.executionBlockHash = is_valid_light_client_header(net, finalized);
    if (!is_valid_normalized_merkle_branch(beaconBlockHeaderRoot(finalized.beacon), branchOf(raw.finality_branch, 'finality branch'), form.finalizedRoot, attested.beacon.stateRoot)) refuse(`the finalized header at slot ${finalized.beacon.slot} is not in the signed state`);
    out.finalized = finalized;
  }
  if (want.nextSyncCommittee) {
    if (periodAt(signatureSlot) !== periodAt(attested.beacon.slot)) refuse('the update that names the next committee is signed in another period');
    const next = parseSyncCommittee(raw.next_sync_committee, 'next sync committee');
    if (!is_valid_normalized_merkle_branch(syncCommitteeRoot(next), branchOf(raw.next_sync_committee_branch, 'next sync committee branch'), form.nextSyncCommittee, attested.beacon.stateRoot)) refuse(`the next sync committee is not in the signed state at slot ${attested.beacon.slot}`);
    out.nextSyncCommittee = next;
  }

  // The fork version is the one in force at the slot before the signature (the committee signs the parent block).
  const domain = compute_domain(net, compute_fork_version(net, epochAt(Math.max(signatureSlot, 1) - 1)));
  const signingRoot = compute_signing_root(beaconBlockHeaderRoot(attested.beacon), domain);
  if (!eth_fast_aggregate_verify(committee, bits, signingRoot, signature)) refuse(`the sync committee signature over the header at slot ${attested.beacon.slot} does not verify`);
  return out;
}

// From the shipped block root to a finalized execution block hash.
//   net         a NETWORKS entry
//   checkpoint  the shipped block root, 0x-hex
//   get(path)   fetches a beacon API path and returns the parsed JSON; the server behind it is not trusted
//   now()       milliseconds; the reader's clock decides what is fresh
// Returns { executionBlockHash, finalizedSlot, attestedSlot, signatureSlot, participants, periods, checkpointSlot }.
async function sync({ net, checkpoint, get, now = Date.now }) {
  const wallSlot = Math.floor((now() / 1000 - net.genesisTime) / SECONDS_PER_SLOT);
  const root = bytes(checkpoint, 32, 'the shipped block root');

  const boot = (await get(`/eth/v1/beacon/light_client/bootstrap/${checkpoint}`))?.data || refuse('the bootstrap reply is empty');
  const header = parseHeader(boot.header, 'bootstrap header');
  if (!equal(beaconBlockHeaderRoot(header.beacon), root)) refuse('the bootstrap header is not the shipped block');
  const shippedBlockHash = is_valid_light_client_header(net, header);
  const first = parseSyncCommittee(boot.current_sync_committee, 'bootstrap sync committee');
  const bootForm = GINDEX[formAt(net, header.beacon.slot)];
  if (!is_valid_normalized_merkle_branch(syncCommitteeRoot(first), branchOf(boot.current_sync_committee_branch, 'bootstrap sync committee branch'), bootForm.currentSyncCommittee, header.beacon.stateRoot)) refuse('the bootstrap sync committee is not in the shipped block\'s state');
  const checkpointSlot = header.beacon.slot;
  if (wallSlot - checkpointSlot > MAX_CHECKPOINT_AGE_SLOTS) throw new LightError('stale', `this viewer's starting block is ${Math.floor((wallSlot - checkpointSlot) / 7200)} days old, past the ${MAX_CHECKPOINT_AGE_SLOTS / 7200} days it may be trusted for`);
  if (checkpointSlot > wallSlot) refuse('the shipped block is in the future by this device\'s clock');

  // One committee per period, each named by an update the one before it signed.
  const committees = new Map([[periodAt(checkpointSlot), first]]);
  let period = periodAt(checkpointSlot);
  const target = periodAt(wallSlot);
  if (target - period > MAX_PERIODS) refuse('too many sync committee periods to follow');
  while (period < target) {
    const count = Math.min(target - period, 8);
    const list = await get(`/eth/v1/beacon/light_client/updates?start_period=${period}&count=${count}`);
    if (!Array.isArray(list) || !list.length || list.length > count) refuse(`no sync committee update for period ${period}`);
    for (const item of list) {
      const raw = item?.data || refuse('an update is empty');
      const u = validate_light_client_update(net, committees.get(period), raw, { nextSyncCommittee: true });
      if (periodAt(u.attested.beacon.slot) !== period) refuse(`asked for period ${period}, got an update from another`);
      committees.set(++period, u.nextSyncCommittee);
    }
  }

  const raw = (await get('/eth/v1/beacon/light_client/finality_update'))?.data || refuse('the finality update is empty');
  const committee = committees.get(periodAt(uint(raw.signature_slot, 'signature slot'))) || refuse('the finality update is signed in a period this client has no committee for');
  const u = validate_light_client_update(net, committee, raw, { finalized: true });
  if (u.signatureSlot > wallSlot + 1) refuse('the finality update is signed in the future by this device\'s clock');
  // Just after finality moves on, a server may still offer the finalized block before the shipped one. The
  // shipped block is the starting point all of this rests on, so it is the newest finalized block known.
  const shipped = u.finalized.beacon.slot < checkpointSlot;
  const finalizedSlot = shipped ? checkpointSlot : u.finalized.beacon.slot;
  if (wallSlot - finalizedSlot > MAX_FINALIZED_AGE_SLOTS) throw new LightError('old', `the newest finalized block offered is ${wallSlot - finalizedSlot} slots old`);
  return {
    executionBlockHash: toHex(shipped ? shippedBlockHash : u.executionBlockHash), finalizedSlot, attestedSlot: u.attested.beacon.slot,
    signatureSlot: u.signatureSlot, participants: u.participants, periods: target - periodAt(checkpointSlot), checkpointSlot,
  };
}

export {
  LightError, MAX_CHECKPOINT_AGE_SLOTS, MAX_FINALIZED_AGE_SLOTS, NETWORKS,
  beaconBlockHeaderRoot, executionPayloadHeaderRoot, syncCommitteeRoot, is_valid_merkle_branch, is_valid_normalized_merkle_branch,
  is_valid_light_client_header, validate_light_client_update, compute_domain, compute_fork_version, sync,
};
