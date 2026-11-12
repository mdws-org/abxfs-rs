// From a proved execution block hash to one storage word, trusting no server.
//
//   executionHeader   a block header as an endpoint gives it, re-encoded and hashed; it must hash to the block hash
//                     the light client proved, and then its state root can be believed
//   accountAt         an account's Merkle-Patricia proof against that state root: its storage root and code hash
//   storageAt         a storage slot's proof against that storage root
//
// The RLP decoder accepts only the canonical encoding, a proof must be used up exactly, and a proof of absence is
// told apart from a broken proof: absence returns null (or zero for a slot), anything else is refused.

import { keccak256 } from './keccak-lookup.js';

class ProofError extends Error {
  constructor(message) { super(message); this.kind = 'check'; }
}
const refuse = (message) => { throw new ProofError(message); };

const HEX = /^0x([0-9a-f]{2})*$/i;
function bytes(hex, what, length) {
  if (typeof hex !== 'string' || !HEX.test(hex) || (length !== undefined && hex.length !== 2 + 2 * length)) refuse(`${what} is not ${length === undefined ? 'hex' : length + ' bytes of hex'}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 + 2 * i, 2), 16);
  return out;
}
const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- RLP ----
// Decodes one item that must fill `u` exactly. A byte string decodes to a Uint8Array, a list to an Array.
const RLP_DEPTH = 4; // a trie node is a list of strings, or holds one embedded node; an account is a list in a string
function rlpDecode(u) {
  const [item, end] = rlpItem(u, 0, 0);
  if (end !== u.length) refuse('RLP: bytes after the item');
  return item;
}
function rlpLength(u, at, n) { // a big-endian length of n bytes, with no leading zero, over 55
  if (at + n > u.length) refuse('RLP: length runs past the end');
  if (u[at] === 0) refuse('RLP: length has a leading zero');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + u[at + i];
  if (len < 56) refuse('RLP: long form used for a short length');
  if (len > u.length) refuse('RLP: length runs past the end');
  return len;
}
function rlpItem(u, at, depth) {
  if (depth > RLP_DEPTH) refuse('RLP: lists nested too deep');
  if (at >= u.length) refuse('RLP: item starts past the end');
  const b = u[at];
  if (b < 0x80) return [u.subarray(at, at + 1), at + 1];
  let start, len, list = b >= 0xc0;
  const short = list ? 0xc0 : 0x80;
  if (b <= short + 55) { start = at + 1; len = b - short; }
  else { const n = b - short - 55; len = rlpLength(u, at + 1, n); start = at + 1 + n; }
  const end = start + len;
  if (end > u.length) refuse('RLP: item runs past the end');
  if (!list) {
    if (len === 1 && u[start] < 0x80) refuse('RLP: a single small byte encoded as a string');
    return [u.subarray(start, end), end];
  }
  const items = [];
  for (let p = start; p < end;) { const [item, next] = rlpItem(u, p, depth + 1); if (next > end) refuse('RLP: list item runs past its list'); items.push(item); p = next; }
  return [items, end];
}
function rlpEncode(item) {
  const head = (short, len) => {
    if (len < 56) return Uint8Array.of(short + len);
    const be = [];
    for (let n = len; n; n = Math.floor(n / 256)) be.unshift(n % 256);
    return Uint8Array.of(short + 55 + be.length, ...be);
  };
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return join([head(0x80, item.length), item]);
  }
  const body = join(item.map(rlpEncode));
  return join([head(0xc0, body.length), body]);
}
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---- Merkle-Patricia proofs ----
// `key` is the 32-byte hashed key. `proof` is the list of nodes an endpoint returned, root first. Returns the
// value stored at the key, or null when the proof shows nothing is stored there.
function verifyProof(root, key, proof, what) {
  if (!Array.isArray(proof) || proof.length > 64) refuse(`${what}: not a proof`);
  if (proof.some((n) => n.length > 2048)) refuse(`${what}: a proof node is larger than any trie node`);
  const nibbles = [];
  for (const b of key) nibbles.push(b >> 4, b & 15);
  let used = 0, at = 0;
  // A parent names a child by its 32-byte hash, or holds the child itself when the child's encoding is shorter.
  let want = root, node = null;
  for (let depth = 0; depth < 70; depth++) {
    if (!node) {
      if (used >= proof.length) refuse(`${what}: the proof stops before the key is reached`);
      const raw = proof[used++];
      if (!equal(keccak256(raw), want)) refuse(`${what}: proof node ${used} does not hash to what its parent names`);
      node = rlpDecode(raw);
    }
    if (!Array.isArray(node)) refuse(`${what}: a proof node is not a list`);
    let child;
    if (node.length === 17) {
      if (at === 64) refuse(`${what}: a branch at the end of the key`);
      child = node[nibbles[at++]];
    } else if (node.length === 2) {
      const [path, target] = node;
      if (!(path instanceof Uint8Array) || !path.length) refuse(`${what}: a node has no path`);
      const flag = path[0] >> 4, leaf = flag >= 2;
      if (flag > 3 || (!(flag & 1) && (path[0] & 15))) refuse(`${what}: a node's path is badly prefixed`);
      const part = flag & 1 ? [path[0] & 15] : [];
      for (let i = 1; i < path.length; i++) part.push(path[i] >> 4, path[i] & 15);
      if (!leaf && !part.length) refuse(`${what}: an extension with an empty path`);
      const matches = part.length <= 64 - at && part.every((n, i) => n === nibbles[at + i]);
      if (!matches) { if (used !== proof.length) refuse(`${what}: nodes after the proof ended`); return null; }
      at += part.length;
      if (leaf) {
        if (at !== 64) refuse(`${what}: a leaf before the end of the key`);
        if (!(target instanceof Uint8Array)) refuse(`${what}: a leaf holds a list`);
        if (used !== proof.length) refuse(`${what}: nodes after the proof ended`);
        return target;
      }
      // An extension leads to a node: by its hash, or holding it. It never leads nowhere.
      if (!Array.isArray(target) && target.length !== 32) refuse(`${what}: an extension that names no node`);
      child = target;
    } else refuse(`${what}: a node with ${node.length} items`);

    if (Array.isArray(child)) node = child; // the child itself, embedded
    else if (child.length === 0) { if (used !== proof.length) refuse(`${what}: nodes after the proof ended`); return null; }
    else if (child.length === 32) { want = child; node = null; }
    else refuse(`${what}: a child reference of ${child.length} bytes`);
  }
  refuse(`${what}: the proof is too deep`);
}

const EMPTY_TRIE = toHex(keccak256(Uint8Array.of(0x80)));
const EMPTY_CODE = toHex(keccak256(new Uint8Array(0)));
function quantityBytes(u, what, max = 32) { // an RLP integer: no leading zero, at most `max` bytes
  if (!(u instanceof Uint8Array) || u.length > max || (u.length && u[0] === 0)) refuse(`${what} is not a canonical integer`);
  return u;
}

// An account at a state root. Returns { storageRoot, codeHash } as hex, or null if the proof
// shows the account does not exist.
const MAX_NODES = 64;
const nodesOf = (list, what) => {
  if (!Array.isArray(list) || list.length > MAX_NODES) refuse(`${what} is not a proof`);
  return list.map((n) => (typeof n === 'string' && n.length <= 2 + 2 * 2048 ? bytes(n, `${what} node`) : refuse(`${what}: a node is larger than any trie node`)));
};
function accountAt(stateRoot, address, accountProof) {
  const leaf = verifyProof(bytes(stateRoot, 'state root', 32), keccak256(bytes(address, 'address', 20)), nodesOf(accountProof, 'account proof'), 'account proof');
  if (leaf === null) return null;
  const fields = rlpDecode(leaf);
  if (!Array.isArray(fields) || fields.length !== 4 || fields[2].length !== 32 || fields[3].length !== 32) refuse('the account is not four fields');
  quantityBytes(fields[0], 'the account nonce', 8);
  quantityBytes(fields[1], 'the account balance');
  return { storageRoot: toHex(fields[2]), codeHash: toHex(fields[3]) };
}

// One storage word at a storage root, as 32 bytes of hex. A slot nothing was written to is zero.
function storageAt(storageRoot, slot, storageProof) {
  const root = bytes(storageRoot, 'storage root', 32);
  const nodes = nodesOf(storageProof, 'storage proof');
  if (toHex(root) === EMPTY_TRIE) { if (nodes.length) refuse('a proof was given for an empty storage'); return '0x' + '0'.repeat(64); }
  const leaf = verifyProof(root, keccak256(bytes(slot, 'slot', 32)), nodes, 'storage proof');
  if (leaf === null) return '0x' + '0'.repeat(64);
  const value = quantityBytes(rlpDecode(leaf), 'the stored word');
  if (!value.length) refuse('a zero word is stored, which the trie never holds');
  return '0x' + toHex(value).slice(2).padStart(64, '0');
}

// ---- execution block header ----
// The header's fields in encoding order. A field an endpoint does not report ends the list; every later field
// must then be missing too. `quantity` fields are integers, the rest fixed-size byte strings.
const HEADER = [
  ['parentHash', 32], ['sha3Uncles', 32], ['miner', 20], ['stateRoot', 32], ['transactionsRoot', 32], ['receiptsRoot', 32], ['logsBloom', 256],
  ['difficulty', 'quantity'], ['number', 'quantity'], ['gasLimit', 'quantity'], ['gasUsed', 'quantity'], ['timestamp', 'quantity'],
  ['extraData', 'bytes'], ['mixHash', 32], ['nonce', 8],
  ['baseFeePerGas', 'quantity'], ['withdrawalsRoot', 32], ['blobGasUsed', 'quantity'], ['excessBlobGas', 'quantity'], ['parentBeaconBlockRoot', 32],
  ['requestsHash', 32], ['blockAccessListHash', 32], ['slotNumber', 'quantity'],
];
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
// `block` is the reply to eth_getBlockByHash. Returns { stateRoot, number, timestamp } once the header hashes to
// `blockHash`; a header with a field this list does not know hashes to something else and is refused.
function executionHeader(blockHash, block) {
  if (!block || typeof block !== 'object') refuse('the endpoint has no such block');
  const fields = [];
  let ended = false;
  for (const [name, type] of HEADER) {
    const v = block[name];
    if (v === undefined || v === null) { ended = true; continue; }
    if (ended) refuse(`the header has ${name} but lacks a field before it`);
    if (type === 'quantity') {
      if (typeof v !== 'string' || !QUANTITY.test(v)) refuse(`the header's ${name} is not a number`);
      const h = v.slice(2);
      fields.push(v === '0x0' ? new Uint8Array(0) : bytes('0x' + (h.length % 2 ? '0' + h : h), name));
    } else {
      if (type === 'bytes' && (typeof v !== 'string' || v.length > 2 + 2 * 32)) refuse(`the header's ${name} is longer than 32 bytes`);
      fields.push(bytes(v, `the header's ${name}`, type === 'bytes' ? undefined : type));
    }
  }
  const got = toHex(keccak256(rlpEncode(fields)));
  if (got !== blockHash.toLowerCase()) refuse(`the header the endpoint gave hashes to ${got}, not the proved block ${blockHash}`);
  const number = parseInt(block.number, 16), timestamp = parseInt(block.timestamp, 16);
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) refuse('the header\'s number or timestamp is too large');
  return { stateRoot: block.stateRoot.toLowerCase(), number, timestamp };
}

export { EMPTY_CODE, EMPTY_TRIE, ProofError, accountAt, executionHeader, rlpDecode, rlpEncode, storageAt, verifyProof };
