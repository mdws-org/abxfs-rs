// ABX FS chain reads shared by the lookup section and the from-chain viewer: JSON-RPC, Multicall3 batches, the
// directory walk, and file contents. Every id is recomputed here from the bytes the chain returns. No DOM.
// Read-only: eth_chainId, eth_blockNumber, eth_call and eth_getCode only.
import { keccak256 } from './keccak-lookup.js';

// Each chain's endpoints, tried in order; a later one is used when an earlier one cannot be reached.
const CHAINS = {
  base: { id: 8453, name: 'Base', rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'] },
  'arbitrum-one': { id: 42161, name: 'Arbitrum One', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'] },
  ethereum: { id: 1, name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  'base-sepolia': { id: 84532, name: 'Base Sepolia', rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'] },
  robinhood: { id: 4663, name: 'Robinhood Chain', rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'] },
  'arbitrum-sepolia': { id: 421614, name: 'Arbitrum Sepolia', rpcs: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com', 'https://arbitrum-sepolia.drpc.org'] },
  sepolia: { id: 11155111, name: 'Sepolia', rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://0xrpc.io/sep'] },
};
const FILE_STORE = '8b6077a1d6953d96687005b9408d56a655b4d155';
const DIRECTORY_STORE = '4273e4e078f47303ca15b11959eeb61f3fc94c11';
const CHUNK_STORE = '56317b1f45e4c15310135ea72fa4d768ca902bcc';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
// The two canonical SSTORE2 backends, same address on every chain. A chunk's stored input is its pointer
// contract's code after the leading STOP byte; the FastLZ backend's input is inflated to get the data.
const RAW_BACKEND = '3c3ae36f5d8aff2dd60c37ca9103d93803c4c844';
const FASTLZ_BACKEND = '80a4ec4a4f98358022a5a060f7cb467188fb68e1';

const IN_FLIGHT = 6;
const GROUP_CALLS = 256;
const GROUP_RET = 384 * 1024;
const GROUP_GAS = 25_000_000;
const MAX_DEPTH = 1024;
const NODE_MAX_LEVEL = 3;
// What one walk or file read may cost: listed entries, eth_calls, bytes of one reply, bytes of one file.
const MAX_ITEMS = 50_000;
const MAX_ETH_CALLS = 3_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_CHUNKS = 16_384;

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const HEX_BYTES = /^0x([0-9a-f]{2})*$/i;
const fromHex = (h) => {
  if (typeof h !== 'string' || !HEX_BYTES.test(h)) throw new LookupError('check', 'the reply is not hex bytes');
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
};
// A JSON-RPC quantity (no leading zeros) that fits in a safe integer.
const quantity = (q, what) => {
  if (typeof q !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]{0,12})$/i.test(q)) throw new LookupError('check', `${what} is not a valid number`);
  return parseInt(q, 16);
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const ZERO = '0x' + '0'.repeat(64);
const hash = (...parts) => '0x' + toHex(keccak256(concat(...parts)));
const directoryCid = (root) => hash(Uint8Array.of(0x32), fromHex(root));
const EMPTY_DIRECTORY = directoryCid(ZERO);
const sel = (sig) => toHex(keccak256(enc.encode(sig))).slice(0, 8);

// [target, selector, return bytes estimate, gas estimate]
const VIEWS = {
  directoryExists: [DIRECTORY_STORE, sel('directoryExists(bytes32)'), 32, 60_000],
  fileExists: [FILE_STORE, sel('fileExists(bytes32)'), 32, 60_000],
  rootOf: [DIRECTORY_STORE, sel('rootOf(bytes32)'), 32, 60_000],
  getFileInfo: [FILE_STORE, sel('getFileInfo(bytes32)'), 512, 180_000],
  dirNode: [DIRECTORY_STORE, sel('getNode(bytes32)'), 24_575 + 192, 400_000],
  fileNode: [FILE_STORE, sel('getNode(bytes32)'), 24_575 + 192, 400_000],
  recordOf: [CHUNK_STORE, sel('recordOf(bytes32)'), 128, 60_000],
};
const AGGREGATE3 = sel('aggregate3((address,bool,bytes)[])');

class LookupError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const host = (url) => new URL(url).host;
// At most IN_FLIGHT HTTP requests open at once, across everything this section sends.
let open = 0;
const waiting = [];
async function limited(fn) {
  if (open >= IN_FLIGHT) await new Promise((r) => waiting.push(r));
  open++;
  try { return await fn(); } finally { open--; waiting.shift()?.(); }
}

// The response body as text, refused past MAX_REPLY_BYTES without reading the rest.
async function cappedText(r) {
  const declared = Number(r.headers.get('content-length'));
  if (declared > MAX_REPLY_BYTES) return null;
  if (!r.body) return r.text();
  const rd = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > MAX_REPLY_BYTES) { rd.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return new TextDecoder().decode(concat(...parts));
}

// A context may carry `store`, a place for replies that a finished, checked read depended on:
// `store.get(key)` returns a stored reply or null. A stored reply is used like a fresh one and passes through
// the same checks, so nothing read from the store is trusted. Fresh replies are collected in `ctx.fresh` for the
// caller to keep once the whole read has checked out; `ctx.skipStored` reads past the store.
async function rpc(ctx, method, params) {
  const key = ctx.store ? `${ctx.chain.id} ${method} ${JSON.stringify(params)}` : null;
  if (key && !ctx.skipStored) {
    const hit = await ctx.store.get(key);
    if (typeof hit === 'string') { ctx.storedHits = (ctx.storedHits || 0) + 1; return hit; }
  }
  const result = await ask(ctx, method, params);
  if (key && typeof result === 'string') (ctx.fresh ||= []).push([key, result]);
  return result;
}

async function ask(ctx, method, params) {
  ctx.requests++;
  const at = host(ctx.url);
  return limited(async () => {
    let r;
    // A public endpoint that answers 429 is asked again, twice, after a growing pause.
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(ctx.url, {
          method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        throw new LookupError('rpc', `could not reach ${at} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      }
      if (r.status !== 429 || attempt === 2) break;
      await new Promise((go) => setTimeout(go, 700 * 2 ** attempt));
    }
    if (!r.ok) throw new LookupError('rpc', `${at} answered HTTP ${r.status}`);
    const text = await cappedText(r).catch(() => undefined);
    if (text === null) throw new LookupError('rpc', `${at} sent a reply larger than ${MAX_REPLY_BYTES / 1048576} MiB`);
    let j = null;
    try { j = JSON.parse(text); } catch { /* reported below */ }
    if (!j || typeof j !== 'object') throw new LookupError('rpc', `${at} sent a reply that is not JSON`);
    if (j.error) throw new LookupError('rpc', `${at}: ${j.error.message || 'RPC error'}`);
    return j.result;
  });
}

function encodeAggregate3(calls) {
  const tuples = calls.map(({ to, data }) => {
    const pad = data + '0'.repeat((64 - (data.length % 64)) % 64);
    return to.padStart(64, '0') + word(1) + word(0x60) + word(data.length / 2) + pad;
  });
  let off = 32 * calls.length, heads = '';
  for (const t of tuples) { heads += word(off); off += t.length / 2; }
  return '0x' + AGGREGATE3 + word(0x20) + word(calls.length) + heads + tuples.join('');
}

// A bounds-checked reader over ABI-encoded data.
function reader(buf) {
  const need = (at, n) => { if (at < 0 || at + n > buf.length) throw new LookupError('check', 'ABI data runs short'); };
  const uint = (at) => {
    need(at, 32);
    for (let i = 0; i < 24; i++) if (buf[at + i]) throw new LookupError('check', 'ABI word too large');
    let v = 0;
    for (let i = 24; i < 32; i++) v = v * 256 + buf[at + i];
    if (!Number.isSafeInteger(v)) throw new LookupError('check', 'ABI word too large');
    return v;
  };
  return {
    uint,
    bool: (at) => {
      const v = uint(at);
      if (v !== 0 && v !== 1) throw new LookupError('check', 'a true or false in the reply is neither 0 nor 1');
      return v === 1;
    },
    h256: (at) => { need(at, 32); return '0x' + toHex(buf.subarray(at, at + 32)); },
    bytesAt: (at) => { const n = uint(at); need(at + 32, n); return buf.subarray(at + 32, at + 32 + n); },
  };
}

class CountMismatch extends LookupError {
  constructor() { super('check', 'Multicall3 returned the wrong number of results'); }
}

function decodeAggregate3(hex, n) {
  const d = reader(fromHex(hex));
  const arr = d.uint(0);
  if (d.uint(arr) !== n) throw new CountMismatch();
  const heads = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = heads + d.uint(heads + 32 * i);
    out.push({ ok: d.bool(t), data: d.bytesAt(t + d.uint(t + 32)) });
  }
  return out;
}

// Greedy groups of view indices within the call, return-size and gas budgets.
function pack(views) {
  const groups = [];
  let cur = [], ret = 0, gas = 0;
  views.forEach((v, i) => {
    if (cur.length && (cur.length >= GROUP_CALLS || ret + v.ret > GROUP_RET || gas + v.gas > GROUP_GAS)) {
      groups.push(cur);
      cur = []; ret = 0; gas = 0;
    }
    cur.push(i); ret += v.ret; gas += v.gas;
  });
  if (cur.length) groups.push(cur);
  return groups;
}

// Run views through Multicall3 at the pinned block. A group the node refuses is split; a group answered with
// nothing or with the wrong number of results is split once; an empty revert inside a group (possibly the group
// running out of gas) is retried alone.
async function runViews(ctx, views) {
  const outs = new Array(views.length);
  const halves = (g, split) => {
    const mid = g.length >> 1;
    return Promise.all([runGroup(g.slice(0, mid), split), runGroup(g.slice(mid), split)]);
  };
  const runGroup = async (g, split = false) => {
    if (++ctx.ethCalls > MAX_ETH_CALLS) throw new LookupError('toolarge', `it needs more than ${MAX_ETH_CALLS.toLocaleString('en-US')} eth_calls`);
    let hex;
    try {
      hex = await rpc(ctx, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(g.map((i) => views[i])) }, ctx.block]);
    } catch (e) {
      if (g.length === 1 || e.kind !== 'rpc') throw e;
      return halves(g, split);
    }
    let res;
    try {
      if (hex === '0x') throw new LookupError('rpc', `Multicall3 returned nothing on ${ctx.chain.name}`);
      res = decodeAggregate3(hex, g.length);
    } catch (e) {
      if ((hex === '0x' || e instanceof CountMismatch) && g.length > 1 && !split) return halves(g, true);
      throw e;
    }
    const retry = [];
    g.forEach((i, k) => {
      if (!res[k].ok && res[k].data.length === 0 && g.length > 1) retry.push(i);
      else outs[i] = res[k];
    });
    await Promise.all(retry.map((i) => runGroup([i], split)));
  };
  await Promise.all(pack(views).map(runGroup));
  return outs;
}

function view(name, id) {
  const [to, s, ret, gas] = VIEWS[name];
  return { to, data: s + id.slice(2), ret, gas, name, id };
}

function ok(out, what) {
  if (!out.ok) throw new LookupError('check', `${what} reverted`);
  return out.data;
}

const be = (b, at, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[at + i]; return v; };
const h256At = (b, at) => '0x' + toHex(b.subarray(at, at + 32));
// ignoreBOM keeps a leading U+FEFF in the text, so two different names never decode to the same one.
const nameText = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const strictText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// The protocol's name rules: non-empty, no "/" or "\\", not "." or "..", valid UTF-8. Anything else is shown
// escaped and never joined into a path.
function entryName(b) {
  let t;
  try { t = strictText.decode(b); } catch { return { name: JSON.stringify(nameText.decode(b)), valid: false }; }
  const valid = t.length > 0 && t !== '.' && t !== '..' && !/[\/\\]/.test(t) && !/[\u0000-\u001f\u007f]/.test(t);
  return { name: valid ? t : JSON.stringify(t), valid };
}

// getNode -> (bytes blob, uint8 level, uint32 count, uint48 size)
function decodeNode(data) {
  const d = reader(data);
  return { blob: d.bytesAt(d.uint(0)), level: d.uint(32), count: d.uint(64), size: d.uint(96) };
}

function parseDirNode(id, blob, n) {
  const fail = (m) => { throw new LookupError('check', `directory node ${id}: ${m}`); };
  if (blob.length < 3) fail('blob too short');
  const k = be(blob, 1, 2);
  if (blob[0] > 0) {
    if (k < 1 || blob.length !== 3 + 36 * k) fail(`branch of ${k} children has ${blob.length} bytes`);
    const children = [];
    let prev = 0;
    for (let i = 0; i < k; i++) {
      const at = 3 + 36 * i, cum = be(blob, at + 32, 4);
      if (cum <= prev) fail('branch counts do not increase');
      children.push({ id: h256At(blob, at), cum });
      prev = cum;
    }
    if (prev !== n) fail(`getNode count ${n}, blob totals ${prev}`);
    return { level: blob[0], count: n, children };
  }
  const records = 3 + 2 * k;
  if (blob.length < records || k !== n) fail(`entry leaf of ${k} entries (getNode count ${n}) has ${blob.length} bytes`);
  const entries = [];
  let at = records;
  for (let i = 0; i < k; i++) {
    if (records + be(blob, 3 + 2 * i, 2) !== at) fail(`entry ${i} offset does not follow the previous record`);
    if (at >= blob.length) fail(`entry ${i} runs past the blob`);
    const len = blob[at], end = at + 1 + len + 1 + 32;
    if (end > blob.length || len === 0) fail(`entry ${i} is malformed`);
    const flag = blob[at + 1 + len];
    if (flag > 1) fail(`entry ${i} directory flag is ${flag}`);
    const { name, valid } = entryName(blob.subarray(at + 1, at + 1 + len));
    entries.push({ name, valid, raw: toHex(blob.subarray(at + 1, at + 1 + len)), isDir: flag === 1, cid: h256At(blob, at + 2 + len) });
    at = end;
  }
  if (at !== blob.length) fail('bytes after the last entry');
  return { level: 0, count: n, entries };
}

// getFileInfo -> one tuple (bytes32 root, uint8 rootLevel, uint256 chunkCount, uint256 size, string mime, bytes32 codec, bytes32 outputHash)
function decodeFileInfo(cid, data) {
  const d = reader(data);
  const t = d.uint(0);
  const mimeBytes = d.bytesAt(t + d.uint(t + 128));
  const info = {
    root: d.h256(t), rootLevel: d.uint(t + 32), chunkCount: d.uint(t + 64), size: d.uint(t + 96),
    mimeBytes, mime: nameText.decode(mimeBytes), codec: d.h256(t + 160), outputHash: d.h256(t + 192),
  };
  const end = fromHex(info.codec).indexOf(0);
  info.codecName = info.codec === ZERO ? '' : String.fromCharCode(...fromHex(info.codec).subarray(0, end < 0 ? 32 : end));
  const got = hash(Uint8Array.of(0x31), fromHex(info.root), keccak256(mimeBytes), fromHex(info.codec), fromHex(info.outputHash));
  if (got !== cid) throw new LookupError('check', `file ${cid}: getFileInfo describes file CID ${got}`);
  if (info.root === ZERO && (info.chunkCount || info.size)) throw new LookupError('check', `file ${cid}: empty root but nonzero size`);
  // The rules createFile enforces: a codec and an output hash come together, and the empty file has neither.
  if ((info.codec === ZERO) !== (info.outputHash === ZERO) || (info.root === ZERO && info.codec !== ZERO)) throw new LookupError('check', `file ${cid}: its codec and output hash do not go together`);
  return info;
}

async function walk(ctx, root) {
  const first = await runViews(ctx, ['directoryExists', 'fileExists', 'rootOf', 'getFileInfo'].map((n) => view(n, root)));
  const flag = (o, what) => reader(ok(o, what)).bool(0);
  const isDir = flag(first[0], 'directoryExists'), isFile = flag(first[1], 'fileExists');
  if (isDir && isFile) throw new LookupError('check', 'this root is both a directory and a file');
  if (!isDir && !isFile) throw new LookupError('notfound', 'not found');
  if (isFile) return { kind: 'file', info: decodeFileInfo(root, ok(first[3], 'getFileInfo')), rounds: 1 };

  const dirRoot = new Map(), dirNodes = new Map(), infos = new Map(), wantLevel = new Map();
  const seenDirs = new Set([root]), seenNodes = new Set(), seenFiles = new Set();
  let emptyDirs = 0; // empty directory CIDs are a known constant, not read from chain
  let qRoot = [], qNode = [], qInfo = [];
  const takeRoot = (cid, out) => {
    const r = reader(ok(out, `rootOf ${cid}`)).h256(0);
    if (directoryCid(r) !== cid) throw new LookupError('check', `directory ${cid}: rootOf returned ${r}, whose directory CID is ${directoryCid(r)}`);
    dirRoot.set(cid, r);
    if (r !== ZERO && !seenNodes.has(r)) { seenNodes.add(r); qNode.push(r); }
  };
  takeRoot(root, first[2]);
  let rounds = 1;
  while (qRoot.length || qNode.length || qInfo.length) {
    rounds++;
    const views = [...qRoot.map((c) => view('rootOf', c)), ...qNode.map((c) => view('dirNode', c)), ...qInfo.map((c) => view('getFileInfo', c))];
    qRoot = []; qNode = []; qInfo = [];
    const outs = await runViews(ctx, views);
    views.forEach((v, i) => {
      if (v.name === 'rootOf') return takeRoot(v.id, outs[i]);
      if (v.name === 'getFileInfo') return void infos.set(v.id, decodeFileInfo(v.id, ok(outs[i], `getFileInfo ${v.id}`)));
      const { blob, level, count: n, size } = decodeNode(ok(outs[i], `getNode ${v.id}`));
      const got = hash(Uint8Array.of(0x42), blob);
      if (got !== v.id) throw new LookupError('check', `directory node ${v.id}: getNode returned a blob whose id is ${got}`);
      if (blob[0] !== level || level > NODE_MAX_LEVEL || size !== 0) throw new LookupError('check', `directory node ${v.id}: level or size disagrees with the blob`);
      if (wantLevel.has(v.id) && wantLevel.get(v.id) !== level) throw new LookupError('check', `directory node ${v.id}: level ${level}, its parent says ${wantLevel.get(v.id)}`);
      const node = parseDirNode(v.id, blob, n);
      dirNodes.set(v.id, node);
      for (const c of node.children || []) {
        if (wantLevel.has(c.id) && wantLevel.get(c.id) !== level - 1) throw new LookupError('check', `directory node ${c.id} is linked at two levels`);
        wantLevel.set(c.id, level - 1);
        if (!seenNodes.has(c.id)) { seenNodes.add(c.id); qNode.push(c.id); }
      }
      for (const e of node.entries || []) {
        if (e.isDir && !seenDirs.has(e.cid)) {
          seenDirs.add(e.cid);
          if (e.cid === EMPTY_DIRECTORY) { dirRoot.set(e.cid, ZERO); emptyDirs++; }
          else qRoot.push(e.cid);
        } else if (!e.isDir && !seenFiles.has(e.cid)) { seenFiles.add(e.cid); qInfo.push(e.cid); }
      }
    });
  }

  const tooLarge = () => new LookupError('toolarge', `it lists more than ${MAX_ITEMS.toLocaleString('en-US')} entries`);
  const collect = (id, depth) => {
    const node = dirNodes.get(id);
    if (!node || depth > NODE_MAX_LEVEL) throw new LookupError('check', `directory node ${id} was not read`);
    if (node.count > MAX_ITEMS) throw tooLarge();
    if (node.entries) return node.entries;
    const out = [];
    let prev = 0;
    for (const c of node.children) {
      const sub = collect(c.id, depth + 1);
      if (sub.length !== c.cum - prev) throw new LookupError('check', `directory node ${id}: child ${c.id} holds ${sub.length} entries, the branch says ${c.cum - prev}`);
      prev = c.cum;
      for (const e of sub) out.push(e);
    }
    return out;
  };
  const entriesOf = new Map();
  const dirEntries = (cid) => {
    if (!entriesOf.has(cid)) {
      const r = dirRoot.get(cid);
      const entries = r === ZERO ? [] : collect(r, 0);
      if (new Set(entries.map((e) => e.raw)).size !== entries.length) throw new LookupError('check', `directory ${cid} lists a name twice`);
      entriesOf.set(cid, entries);
    }
    return entriesOf.get(cid);
  };
  const items = [];
  const ancestors = new Set();
  const list = (cid, prefix, depth) => {
    if (depth >= MAX_DEPTH) throw new LookupError('check', `directories nest deeper than ${MAX_DEPTH} levels`);
    if (ancestors.has(cid)) throw new LookupError('check', `directory ${cid} contains itself`);
    ancestors.add(cid);
    for (const e of dirEntries(cid)) {
      if (items.length >= MAX_ITEMS) throw tooLarge();
      if (!e.valid) {
        items.push({ path: prefix + e.name, cid: e.cid, isDir: e.isDir, invalid: true, info: e.isDir ? null : infos.get(e.cid) });
        continue;
      }
      const path = prefix + e.name;
      if (e.isDir) {
        items.push({ path: path + '/', cid: e.cid, isDir: true, empty: dirRoot.get(e.cid) === ZERO });
        list(e.cid, path + '/', depth + 1);
      } else items.push({ path, cid: e.cid, isDir: false, info: infos.get(e.cid) });
    }
    ancestors.delete(cid);
  };
  list(root, '', 0);
  return { kind: 'directory', items, dirs: dirRoot.size - emptyDirs, nodes: dirNodes.size, rounds };
}

/* ── file contents ───────────────────────────────────────────────────────── */

function parseFileNode(id, blob, n, size) {
  const fail = (m) => { throw new LookupError('check', `file node ${id}: ${m}`); };
  if (blob[0] > 0) {
    if (blob.length < 3) fail('blob too short');
    const k = be(blob, 1, 2);
    if (k < 1 || blob.length !== 3 + 42 * k) fail(`branch of ${k} children has ${blob.length} bytes`);
    const children = [];
    let prevC = 0, prevB = 0;
    for (let i = 0; i < k; i++) {
      const at = 3 + 42 * i, cum = be(blob, at + 32, 4), cumBytes = be(blob, at + 36, 6);
      if (cum <= prevC || cumBytes < prevB) fail('branch totals do not increase');
      children.push({ id: h256At(blob, at), cum, cumBytes });
      prevC = cum; prevB = cumBytes;
    }
    if (prevC !== n || prevB !== size) fail(`getNode says ${n} chunks / ${size} bytes, blob totals ${prevC} / ${prevB}`);
    return { children };
  }
  if (blob.length === 1 || (blob.length - 1) % 38 !== 0) fail(`chunk leaf of ${blob.length} bytes`);
  const chunks = [];
  let total = 0;
  for (let at = 1; at < blob.length; at += 38) {
    const bytes = be(blob, at + 32, 6);
    if (bytes === 0) fail('lists an empty chunk');
    chunks.push({ id: h256At(blob, at), size: bytes });
    total += bytes;
  }
  if (chunks.length !== n || total !== size) fail(`getNode says ${n} chunks / ${size} bytes, leaf holds ${chunks.length} / ${total}`);
  return { chunks };
}

// Inflate a Solady LibZip FastLZ stream into exactly `size` bytes.
function flzDecompress(d, size) {
  const out = new Uint8Array(size);
  const n = d.length;
  let i = 0, o = 0;
  const fail = (m) => { throw new LookupError('check', `FastLZ stream ${m}`); };
  while (i < n) {
    const c = d[i], t = c >> 5;
    if (t === 0) {
      const runs = c + 1;
      if (i + 1 + runs > n) fail('ends inside a literal run');
      if (o + runs > size) fail('inflates past the recorded size');
      out.set(d.subarray(i + 1, i + 1 + runs), o);
      o += runs;
      i += 2 + c;
    } else {
      const g = t === 7 ? 1 : 0;
      if (i + 1 + g >= n) fail('ends inside a back-reference');
      const len = g ? 9 + d[i + 1] : 2 + t;
      const back = ((c & 0x1f) << 8) + d[i + 1 + g] + 1;
      if (back > o) fail('refers to bytes before the start');
      if (o + len > size) fail('inflates past the recorded size');
      for (let k = 0, from = o - back; k < len; k++) out[o++] = out[from + k];
      i += 2 + g;
    }
  }
  if (o !== size) fail(`inflates to ${o} bytes, the record says ${size}`);
  return out;
}

// recordOf -> (address backend, uint48 size, bytes32 pointer, bytes32 dataHash)
function decodeRecord(id, data) {
  const d = reader(data);
  const backend = d.h256(0), pointer = d.h256(64);
  if (!/^0x0{24}/.test(backend)) throw new LookupError('check', `chunk ${id}: the backend is not an address`);
  const r = { backend: backend.slice(26), size: d.uint(32), pointer, dataHash: d.h256(96) };
  if (/^0+$/.test(r.backend)) throw new LookupError('check', `chunk ${id} is not on chain`);
  if (r.backend !== RAW_BACKEND && r.backend !== FASTLZ_BACKEND) throw new LookupError('unsupported', `chunk ${id} is stored through backend 0x${r.backend}, which is not read here`);
  if (!/^0x0{24}/.test(pointer)) throw new LookupError('unsupported', `chunk ${id}: its pointer is not a contract address`);
  return r;
}

const u48 = (n) => { if (!(n >= 0 && n < 2 ** 48)) throw new LookupError('check', 'a size does not fit in 48 bits'); const b = new Uint8Array(6); for (let i = 5, v = n; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } return b; };

// The data of one chunk, from its pointer contract's code, checked against its record and its id.
async function readChunk(ctx, id, r) {
  const code = fromHex(await rpc(ctx, 'eth_getCode', ['0x' + r.pointer.slice(26), ctx.block]));
  if (code.length < 2 || code[0] !== 0) throw new LookupError('check', `chunk ${id}: its pointer holds no stored data`);
  const input = code.subarray(1);
  const data = r.backend === FASTLZ_BACKEND ? flzDecompress(input, r.size) : input;
  if (data.length !== r.size) throw new LookupError('check', `chunk ${id}: ${data.length} bytes, its record says ${r.size}`);
  const dataHash = keccak256(data);
  if ('0x' + toHex(dataHash) !== r.dataHash) throw new LookupError('check', `chunk ${id}: the bytes do not hash to the record's data hash`);
  const got = hash(Uint8Array.of(0x30), fromHex('0x' + r.backend), keccak256(input), dataHash, u48(r.size));
  if (got !== id) throw new LookupError('check', `chunk ${id}: the bytes read give chunk id ${got}`);
  return data;
}

const CODECS = { gzip: 'gzip', deflate: 'deflate', br: 'brotli', zstd: 'zstd' };

async function decodeContent(name, stored) {
  let stream;
  try {
    stream = new Blob([stored]).stream().pipeThrough(new DecompressionStream(CODECS[name] ?? name));
  } catch {
    throw new LookupError('unsupported', `this browser cannot decode "${name}" files`);
  }
  const parts = [];
  let n = 0;
  try {
    for (const rd = stream.getReader(); ;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > MAX_FILE_BYTES) { rd.cancel().catch(() => {}); throw new LookupError('toolarge', `it decodes to more than ${MAX_FILE_BYTES / 1048576} MiB`); }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof LookupError) throw e;
    throw new LookupError('check', `the stored bytes are not a valid ${name} stream`);
  }
  return concat(...parts);
}

// A file's content, read from chain and checked back to its CID: the chunk-node tree from the file's root,
// every chunk against its record and its id, the totals against the file info, and a codec's output against
// outputHash. `info` is what decodeFileInfo returned for `cid` (itself checked against the CID).
async function readFile(ctx, cid, info) {
  if (info.root === ZERO) return new Uint8Array(0);
  if (info.size > MAX_FILE_BYTES) throw new LookupError('toolarge', `the file stores more than ${MAX_FILE_BYTES / 1048576} MiB`);
  if (info.chunkCount > MAX_FILE_CHUNKS) throw new LookupError('toolarge', `the file has more than ${MAX_FILE_CHUNKS.toLocaleString('en-US')} chunks`);
  // What each node must be, set by its parent before it is read (the file info, for the root). A node's own
  // totals are bound to its blob, so the size and chunk limits above hold before any subtree is expanded.
  const nodes = new Map(), want = new Map([[info.root, { level: info.rootLevel, count: info.chunkCount, size: info.size }]]);
  for (let q = [info.root]; q.length;) {
    const outs = await runViews(ctx, q.map((id) => view('fileNode', id)));
    const next = [];
    q.forEach((id, i) => {
      const { blob, level, count: n, size } = decodeNode(ok(outs[i], `getNode ${id}`));
      const got = hash(Uint8Array.of(0x41), blob);
      if (got !== id) throw new LookupError('check', `file node ${id}: getNode returned a blob whose id is ${got}`);
      const w = want.get(id);
      if (blob[0] !== level || level > NODE_MAX_LEVEL || w.level !== level) throw new LookupError('check', `file node ${id}: level ${level} disagrees with the blob or its parent`);
      const node = parseFileNode(id, blob, n, size);
      if (n !== w.count || size !== w.size) throw new LookupError('check', `file node ${id}: holds ${n} chunks / ${size} bytes, its parent says ${w.count} / ${w.size}`);
      nodes.set(id, node);
      let prevC = 0, prevB = 0;
      for (const c of node.children || []) {
        const child = { level: level - 1, count: c.cum - prevC, size: c.cumBytes - prevB };
        prevC = c.cum; prevB = c.cumBytes;
        const seen = want.get(c.id);
        if (seen && (seen.level !== child.level || seen.count !== child.count || seen.size !== child.size)) throw new LookupError('check', `file node ${c.id} is linked with two different totals`);
        if (!seen) { want.set(c.id, child); next.push(c.id); }
      }
    });
    q = next;
  }
  const collect = (id) => {
    const node = nodes.get(id);
    if (node.chunks) return node.chunks;
    const out = [];
    let prevC = 0, prevB = 0;
    for (const c of node.children) {
      const sub = collect(c.id);
      const bytes = sub.reduce((a, x) => a + x.size, 0);
      if (sub.length !== c.cum - prevC || bytes !== c.cumBytes - prevB) throw new LookupError('check', `file node ${id}: child ${c.id} holds ${sub.length} chunks / ${bytes} bytes, the branch says ${c.cum - prevC} / ${c.cumBytes - prevB}`);
      prevC = c.cum; prevB = c.cumBytes;
      for (const x of sub) out.push(x);
    }
    return out;
  };
  const chunks = collect(info.root);
  const total = chunks.reduce((a, x) => a + x.size, 0);
  if (chunks.length !== info.chunkCount || total !== info.size) throw new LookupError('check', `file ${cid}: its tree holds ${chunks.length} chunks / ${total} bytes, the file info says ${info.chunkCount} / ${info.size}`);

  const ids = [...new Set(chunks.map((c) => c.id))];
  const recs = await runViews(ctx, ids.map((id) => view('recordOf', id)));
  const records = new Map(ids.map((id, i) => [id, decodeRecord(id, ok(recs[i], `recordOf ${id}`))]));
  for (const c of chunks) if (records.get(c.id).size !== c.size) throw new LookupError('check', `chunk ${c.id}: its record says ${records.get(c.id).size} bytes, the file's tree says ${c.size}`);
  const datas = new Map(await Promise.all(ids.map(async (id) => [id, await readChunk(ctx, id, records.get(id))])));
  const stored = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { stored.set(datas.get(c.id), at); at += c.size; }
  if (info.codec === ZERO) return stored;
  const content = await decodeContent(info.codecName, stored);
  if ('0x' + toHex(keccak256(content)) !== info.outputHash) throw new LookupError('check', `file ${cid}: the decoded content does not hash to its output hash`);
  return content;
}

export { CHAINS, LookupError, ZERO, fromHex, hash, host, ok, quantity, readFile, reader, rpc, runViews, toHex, view, walk, word };
