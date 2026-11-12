// A reader for BAMFS, the file store ABX FS grew out of, in both of its generations. Projects published before
// ABX FS keep their root in the token parameter "bamfs.cid", and their files in these older store contracts.
//
// Every reply is checked back to the root, as in chain.js. `H` is keccak-256.
//
//   second generation (FileStoreV2, DirectoryStoreV2): trees of nodes
//     directory CID = H(0x12 . root node id)        entry node id = H(0x22 . blob)
//     file CID      = H(0x11 . root node id . H(mime) . compression . outputHash)     chunk node id = H(0x21 . blob)
//   first generation (FileStore, DirectoryStore): flat lists
//     directory CID = H(0x02 . H(entry hashes))     entry hash = H(H(name) . child CID . isDirectory)
//     file CID      = H(0x01 . H(chunk hashes) . H(mime) . compression . outputHash)
//   both: chunk hash = H(backend address . stored bytes); outputHash = H(the file's bytes) when it is compressed.
//
// Which generation a root belongs to is settled by which directory store knows it, and then by the hashes.

import { keccak256 } from './keccak-lookup.js';
import { LookupError, fromHex, rpc, toHex } from './chain.js';

const enc = new TextEncoder();
const sel = (sig) => toHex(keccak256(enc.encode(sig))).slice(0, 8);
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const H = (...parts) => '0x' + toHex(keccak256(concat(...parts)));
const refuse = (message) => { throw new LookupError('check', message); };
const ZERO = '0x' + '0'.repeat(64);

// The same addresses on every chain BAMFS is deployed to.
const CONTENT_STORE = 'd4a0ffa88a58ee7bb7e802e7079ee90c8da52250', BACKEND = fromHex('0x91520cdaaab44267e99d08fea7730d7a7c60e9c2');
const STORES = {
  2: { files: '13036662e483335ff9c6f30e8852a4694e9a2154', dirs: 'b9411b8fc6fa3cce85efb6dd3ffa11f83a54ef72' },
  1: { files: 'aa79ce91da95367fd79bf5d718b055d31eb9cfd3', dirs: '16fa2ecac2b898fb91dc17bae843c7d0e6d8531f' },
};
const MAX_ENTRIES = 4096, MAX_NODES = 4096, MAX_CHUNKS = 16_384, MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_DEPTH = 32;

const eth = async (ctx, to, signature, args = '') => {
  if (++ctx.ethCalls > 6000) throw new LookupError('toolarge', 'it needs more than 6,000 reads');
  return fromHex(await rpc(ctx, 'eth_call', [{ to: '0x' + to, data: '0x' + sel(signature) + args }, ctx.block]));
};

// ABI words of a reply.
function abi(buf) {
  const need = (at, n) => { if (at < 0 || at + n > buf.length) refuse('a reply is shorter than its contents'); };
  const uint = (at) => { need(at, 32); let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(buf[at + i]); if (v > 0xffffffffffffn) refuse('a number in a reply is too large'); return Number(v); };
  return {
    uint, h256: (at) => { need(at, 32); return '0x' + toHex(buf.subarray(at, at + 32)); },
    bool: (at) => { const v = uint(at); if (v > 1) refuse('a true or false in a reply is neither'); return v === 1; },
    bytes: (at) => { const n = uint(at); need(at + 32, n); return buf.subarray(at + 32, at + 32 + n); },
  };
}
const text = (bytes, what) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { refuse(`${what} is not UTF-8`); } };
const be = (b, at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[at + i]; return v; };

// A name that can be one part of a path. Others are listed but cannot be opened.
const usable = (name) => name !== '' && name !== '.' && name !== '..' && !/[\/\\\u0000]/.test(name);

/* ── second generation ───────────────────────────────────────────────────── */

// One node of either store, its blob checked against its id. `prefix` is 0x21 for chunk nodes, 0x22 for entries.
async function node(ctx, store, id, prefix, seen) {
  if (seen.count++ > MAX_NODES) throw new LookupError('toolarge', `it has more than ${MAX_NODES} nodes`);
  const r = abi(await eth(ctx, store, 'getNode(bytes32)', id.slice(2)));
  const blob = r.bytes(r.uint(0));
  if (H(Uint8Array.of(prefix), blob) !== id) refuse(`node ${id}: its contents do not hash to its id`);
  if (!blob.length) refuse(`node ${id} is empty`);
  return blob;
}
// The leaves under a node, in order: level 0 is a leaf; a branch names 2 to 128 children one level down.
async function leaves(ctx, store, id, prefix, childBytes, level, seen, out) {
  const blob = await node(ctx, store, id, prefix, seen);
  if (level !== undefined && blob[0] !== level) refuse(`node ${id} is at level ${blob[0]}, its parent says ${level}`);
  if (blob[0] === 0) { out.push(blob); return; }
  if (blob[0] > 3 || blob.length < 3) refuse(`node ${id} has a level no tree has`);
  const k = be(blob, 1, 2);
  if (k < 2 || k > 128 || blob.length !== 3 + childBytes * k) refuse(`branch ${id} does not hold the children it counts`);
  for (let i = 0; i < k; i++) await leaves(ctx, store, '0x' + toHex(blob.subarray(3 + childBytes * i, 35 + childBytes * i)), prefix, childBytes, blob[0] - 1, seen, out);
}
function entriesOf(leaf) { // uint8 0, uint16 n, uint16 offset[n], records: uint8 nameLen, name, uint8 isDirectory, bytes32 cid
  if (leaf.length < 3) refuse('an entry leaf is too short');
  const n = be(leaf, 1, 2), area = 3 + 2 * n, out = [];
  if (n < 1 || area > leaf.length) refuse('an entry leaf does not hold the entries it counts');
  let at = area;
  for (let i = 0; i < n; i++) {
    if (area + be(leaf, 3 + 2 * i, 2) !== at) refuse('an entry leaf\'s offsets do not match its records');
    if (at >= leaf.length) refuse('an entry leaf ends inside a record');
    const len = leaf[at];
    if (at + 1 + len + 33 > leaf.length) refuse('an entry leaf ends inside a record');
    const flag = leaf[at + 1 + len];
    if (flag > 1) refuse('an entry is neither a file nor a directory');
    out.push({ name: text(leaf.subarray(at + 1, at + 1 + len), 'an entry name'), isDir: flag === 1, cid: '0x' + toHex(leaf.subarray(at + 2 + len, at + 34 + len)) });
    at += 34 + len;
  }
  if (at !== leaf.length) refuse('an entry leaf has bytes after its records');
  return out;
}
async function list2(ctx, cid, seen) {
  const root = abi(await eth(ctx, STORES[2].dirs, 'rootOf(bytes32)', cid.slice(2))).h256(0);
  if (H(Uint8Array.of(0x12), fromHex(root)) !== cid) refuse(`directory ${cid}: its root node does not hash to its CID`);
  const blobs = [];
  await leaves(ctx, STORES[2].dirs, root, 0x22, 36, undefined, seen, blobs);
  return blobs.flatMap(entriesOf);
}
async function info2(ctx, cid) {
  const r = abi(await eth(ctx, STORES[2].files, 'getFileInfo(bytes32)', cid.slice(2)));
  const t = r.uint(0), mimeBytes = r.bytes(t + r.uint(t + 128));
  const info = { generation: 2, root: r.h256(t), size: r.uint(t + 96), mime: text(mimeBytes, 'a file type'), compression: r.uint(t + 160), outputHash: r.h256(t + 192) };
  if (info.compression > 255) refuse('a compression byte is larger than a byte');
  if (H(Uint8Array.of(0x11), fromHex(info.root), keccak256(mimeBytes), Uint8Array.of(info.compression), fromHex(info.outputHash)) !== cid) refuse(`file ${cid}: its record does not hash to its CID`);
  return info;
}
async function chunks2(ctx, info) {
  const blobs = [], out = [];
  await leaves(ctx, STORES[2].files, info.root, 0x21, 42, undefined, { count: 0 }, blobs);
  for (const leaf of blobs) {
    if (leaf.length < 35 || (leaf.length - 1) % 34) refuse('a chunk leaf does not hold whole chunks');
    for (let at = 1; at < leaf.length; at += 34) out.push({ id: '0x' + toHex(leaf.subarray(at, at + 32)), size: be(leaf, at + 32, 2) });
  }
  return out;
}

/* ── first generation ────────────────────────────────────────────────────── */

async function list1(ctx, cid) {
  const r = abi(await eth(ctx, STORES[1].dirs, 'listDirectory(bytes32)', cid.slice(2)));
  const base = r.uint(0), n = r.uint(base), out = [], hashes = [];
  if (n > MAX_ENTRIES) throw new LookupError('toolarge', `a directory has more than ${MAX_ENTRIES} entries`);
  for (let i = 0; i < n; i++) {
    const t = base + 32 + r.uint(base + 32 + 32 * i);
    const nameBytes = r.bytes(t + r.uint(t)), child = r.h256(t + 32), isDir = r.bool(t + 64);
    hashes.push(keccak256(concat(keccak256(nameBytes), fromHex(child), Uint8Array.of(isDir ? 1 : 0))));
    out.push({ name: text(nameBytes, 'an entry name'), isDir, cid: child });
  }
  if (H(Uint8Array.of(0x02), keccak256(concat(...hashes))) !== cid) refuse(`directory ${cid}: its entries do not hash to its CID`);
  return out;
}
async function info1(ctx, cid) {
  const r = abi(await eth(ctx, STORES[1].files, 'getFile(bytes32)', cid.slice(2)));
  const t = r.uint(0), list = t + r.uint(t), n = r.uint(list), mimeBytes = r.bytes(t + r.uint(t + 32));
  if (n > MAX_CHUNKS) throw new LookupError('toolarge', `a file has more than ${MAX_CHUNKS} chunks`);
  const ids = Array.from({ length: n }, (_, i) => r.h256(list + 32 + 32 * i));
  const info = { generation: 1, chunks: ids.map((id) => ({ id })), mime: text(mimeBytes, 'a file type'), compression: r.uint(t + 64), outputHash: r.h256(t + 96), size: 0 };
  if (info.compression > 255) refuse('a compression byte is larger than a byte');
  if (H(Uint8Array.of(0x01), keccak256(concat(...ids.map(fromHex))), keccak256(mimeBytes), Uint8Array.of(info.compression), fromHex(info.outputHash)) !== cid) refuse(`file ${cid}: its record does not hash to its CID`);
  return info;
}

/* ── both ────────────────────────────────────────────────────────────────── */

const exists = async (ctx, store, signature, cid) => abi(await eth(ctx, store, signature, cid.slice(2))).bool(0);
// Which generation's directory store, or file store, knows this root.
async function kindOf(ctx, root) {
  for (const g of [2, 1]) {
    if (await exists(ctx, STORES[g].dirs, 'directoryExists(bytes32)', root)) return { generation: g, isDir: true };
    if (await exists(ctx, STORES[g].files, 'fileExists(bytes32)', root)) return { generation: g, isDir: false };
  }
  throw new LookupError('notfound', 'no BAMFS store holds this root');
}
const CODEC_NAMES = { 0: '', 1: 'gzip', 6: 'fastlz' };
function shown(info) { // the fields the viewer lists
  const algorithm = info.compression & 0x7f;
  return { ...info, codecName: info.compression ? `${CODEC_NAMES[algorithm] ?? `codec ${algorithm}`}${info.compression & 0x80 ? ', per chunk' : ''}` : '' };
}

// The tree under a root, in chain.js's shape: { kind: 'file', info } or { kind: 'directory', items: [...] }.
async function walk(ctx, root) {
  ctx.ethCalls ||= 0;
  const top = await kindOf(ctx, root);
  const fileInfo = (cid) => (top.generation === 2 ? info2(ctx, cid) : info1(ctx, cid)).then(shown);
  if (!top.isDir) return { kind: 'file', info: await fileInfo(root) };
  const items = [], seen = { count: 0 }, visited = new Set();
  const descend = async (cid, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new LookupError('toolarge', `directories are nested more than ${MAX_DEPTH} deep`);
    if (visited.has(cid)) refuse(`directory ${cid} is inside itself`);
    visited.add(cid);
    const entries = top.generation === 2 ? await list2(ctx, cid, seen) : await list1(ctx, cid);
    const names = new Set();
    for (const e of entries) {
      if (names.has(e.name)) refuse(`two entries in ${prefix || 'the root'} are named ${e.name}`);
      names.add(e.name);
      if (items.length >= MAX_ENTRIES) throw new LookupError('toolarge', `it has more than ${MAX_ENTRIES} entries`);
      if (!usable(e.name)) { items.push({ path: prefix + e.name, cid: e.cid, isDir: e.isDir, invalid: true, info: null }); continue; }
      if (e.isDir) { items.push({ path: prefix + e.name + '/', cid: e.cid, isDir: true }); await descend(e.cid, prefix + e.name + '/', depth + 1); } else items.push({ path: prefix + e.name, cid: e.cid, isDir: false, info: await fileInfo(e.cid) });
    }
    visited.delete(cid);
  };
  await descend(root, '', 0);
  return { kind: 'directory', items };
}

// FastLZ level 1, to the end of the stream.
function inflate(d) {
  let out = new Uint8Array(Math.max(1024, d.length * 4)), o = 0;
  const room = (n) => { if (o + n > MAX_FILE_BYTES) throw new LookupError('toolarge', `it inflates to more than ${MAX_FILE_BYTES / 1048576} MiB`); if (o + n > out.length) { const bigger = new Uint8Array(Math.max(out.length * 2, o + n)); bigger.set(out.subarray(0, o)); out = bigger; } };
  for (let i = 0; i < d.length;) {
    const c = d[i], t = c >> 5;
    if (t === 0) {
      const run = c + 1;
      if (i + 1 + run > d.length) refuse('a FastLZ stream ends inside a literal run');
      room(run); out.set(d.subarray(i + 1, i + 1 + run), o); o += run; i += 1 + run;
    } else {
      const long = t === 7 ? 1 : 0;
      if (i + 1 + long >= d.length) refuse('a FastLZ stream ends inside a back-reference');
      const len = long ? 9 + d[i + 1] : 2 + t, back = ((c & 31) << 8) + d[i + 1 + long] + 1;
      if (back > o) refuse('a FastLZ stream refers to bytes before its start');
      room(len);
      for (let k = 0, from = o - back; k < len; k++) out[o++] = out[from + k];
      i += 2 + long;
    }
  }
  return out.subarray(0, o);
}
async function gunzip(stored) {
  const parts = [];
  let n = 0;
  try {
    for (const rd = new Blob([stored]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(); ;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > MAX_FILE_BYTES) { rd.cancel().catch(() => {}); throw new LookupError('toolarge', `it decodes to more than ${MAX_FILE_BYTES / 1048576} MiB`); }
      parts.push(value);
    }
  } catch (e) { if (e instanceof LookupError) throw e; refuse('the stored bytes are not a valid gzip stream'); }
  return concat(...parts);
}
const decode = (algorithm, bytes) => (algorithm === 6 ? inflate(bytes) : algorithm === 1 ? gunzip(bytes) : (() => { throw new LookupError('unsupported', `this viewer cannot decode BAMFS compression ${algorithm}`); })());

// A file's bytes, each chunk checked against its hash and the whole against the file's output hash.
async function readFile(ctx, cid, info) {
  ctx.ethCalls ||= 0;
  const list = info.generation === 2 ? await chunks2(ctx, info) : info.chunks;
  if (list.length > MAX_CHUNKS) throw new LookupError('toolarge', `the file has more than ${MAX_CHUNKS} chunks`);
  const stored = [];
  let total = 0;
  for (const c of list) {
    const r = abi(await eth(ctx, CONTENT_STORE, 'read(bytes32)', c.id.slice(2)));
    const payload = r.bytes(r.uint(0));
    if (H(BACKEND, payload) !== c.id) refuse(`chunk ${c.id}: its bytes do not hash to its id`);
    if (c.size !== undefined && payload.length !== c.size) refuse(`chunk ${c.id} is ${payload.length} bytes, its leaf says ${c.size}`);
    total += payload.length;
    if (total > MAX_FILE_BYTES) throw new LookupError('toolarge', `the file stores more than ${MAX_FILE_BYTES / 1048576} MiB`);
    stored.push(Uint8Array.from(payload));
  }
  const algorithm = info.compression & 0x7f;
  let body;
  if (!info.compression) {
    if (info.outputHash !== ZERO) refuse(`file ${cid} is not compressed but records an output hash`);
    body = concat(...stored);
  } else {
    body = info.compression & 0x80 ? concat(...await Promise.all(stored.map((s) => decode(algorithm, s)))) : await decode(algorithm, concat(...stored));
    if (H(body) !== info.outputHash) refuse(`file ${cid}: its decoded bytes do not hash to its output hash`);
  }
  return body;
}

export { STORES, inflate, readFile, walk };
