// Look up an ABX FS root on chain: decide whether it is a directory or a file, walk a directory's entry-node tree,
// and read each file's info. Directory CIDs, entry node ids and file CIDs are recomputed here from what the chain
// returns; file contents and chunk trees are not read. Read-only: eth_chainId, eth_blockNumber and eth_call only.
import { keccak256 } from './keccak-lookup.js';

// Each chain's endpoints, tried in order; a later one is used when an earlier one cannot be reached.
const CHAINS = {
  base: { id: 8453, name: 'Base', rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  'arbitrum-one': { id: 42161, name: 'Arbitrum One', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  ethereum: { id: 1, name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  'base-sepolia': { id: 84532, name: 'Base Sepolia', rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'] },
  'arbitrum-sepolia': { id: 421614, name: 'Arbitrum Sepolia', rpcs: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'] },
  sepolia: { id: 11155111, name: 'Sepolia', rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://0xrpc.io/sep'] },
};
const FILE_STORE = '8b6077a1d6953d96687005b9408d56a655b4d155';
const DIRECTORY_STORE = '4273e4e078f47303ca15b11959eeb61f3fc94c11';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

const IN_FLIGHT = 6;
const GROUP_CALLS = 256;
const GROUP_RET = 384 * 1024;
const GROUP_GAS = 25_000_000;
const MAX_DEPTH = 1024;
const NODE_MAX_LEVEL = 3;
// What one lookup may cost and show: listed entries, eth_calls, bytes of one reply, table rows.
const MAX_ITEMS = 50_000;
const MAX_ETH_CALLS = 3_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 2_000;

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
};
const AGGREGATE3 = sel('aggregate3((address,bool,bytes)[])');

class LookupError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const $ = (s) => document.querySelector(s);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const host = (url) => new URL(url).host;
const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB');
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

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

async function rpc(ctx, method, params) {
  ctx.requests++;
  const at = host(ctx.url);
  return limited(async () => {
    let r;
    try {
      r = await fetch(ctx.url, {
        method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new LookupError('rpc', `could not reach ${at} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
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
const nameText = new TextDecoder('utf-8', { fatal: false });
const strictText = new TextDecoder('utf-8', { fatal: true });
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

// Whether each other chain holds this root (directoryExists or fileExists at its latest block): 'present',
// 'absent', or 'unknown' when no endpoint of that chain gave a clean answer.
async function elsewhere(root, except) {
  const names = Object.keys(CHAINS).filter((n) => n !== except);
  const states = await Promise.all(names.map(async (n) => {
    for (const url of CHAINS[n].rpcs) {
      const ctx = { chain: CHAINS[n], url, requests: 0, ethCalls: 0, block: 'latest' };
      try {
        if (quantity(await rpc(ctx, 'eth_chainId', []), 'the chain id') !== ctx.chain.id) continue;
        const outs = await runViews(ctx, [view('directoryExists', root), view('fileExists', root)]);
        const flags = outs.map((o, i) => reader(ok(o, i ? 'fileExists' : 'directoryExists')).bool(0));
        return flags.some(Boolean) ? 'present' : 'absent';
      } catch { /* the next endpoint, then unknown */ }
    }
    return 'unknown';
  }));
  return names.map((n, i) => ({ key: n, state: states[i] }));
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (text instanceof Node) td.append(text); else td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function rootLink(cid, chain, label) {
  const a = document.createElement('a');
  a.href = `?root=${cid}&chain=${chain}#lookup`;
  a.textContent = label ?? short(cid);
  a.title = cid;
  a.dataset.root = cid;
  a.dataset.chain = chain;
  return a;
}

function typeText(info) {
  return info.codecName ? `${info.mime}, ${info.codecName}` : info.mime;
}

function sizeCell(n) {
  const td = cell(bytes(n), 'n');
  td.title = n.toLocaleString('en-US') + ' bytes';
  td.dataset.size = n;
  return td;
}

function showDirectory(r, chainKey) {
  const files = r.items.filter((x) => !x.isDir);
  const total = files.reduce((a, f) => a + (f.info ? f.info.size : 0), 0);
  const empties = r.items.filter((x) => x.isDir && x.empty).length;
  $('#lk-facts').textContent = `Directory · ${count(files.length, 'file', 'files')} · ` +
    `${count(r.items.length - files.length, 'subdirectory', 'subdirectories')}` + (empties ? ` (${empties} empty)` : '') +
    ` · ${bytes(total)} by stored size`;
  $('#lk-checked').textContent =
    `Checked in this browser: ${count(r.dirs, 'directory CID', 'directory CIDs')} against the root nodes the chain ` +
    `returned, ${count(r.nodes, 'entry node id', 'entry node ids')} against the node bytes, and ` +
    `${count(files.length, 'file CID', 'file CIDs')} against the file info the chain returned. ` +
    `As reported by the chain, not checked here: sizes, chunk trees and file contents. ` +
    `abxfs-rs read checks those too.`;
  const rows = document.createDocumentFragment();
  for (const x of r.items.slice(0, MAX_ROWS)) {
    const tr = document.createElement('tr');
    tr.append(cell(x.path, 'lk-path'));
    if (x.invalid) tr.append(cell('', 'n'), cell(x.isDir ? 'directory, name not allowed' : 'file, name not allowed'));
    else if (x.isDir) tr.append(cell('', 'n'), cell(x.empty ? 'directory, empty' : 'directory'));
    else tr.append(sizeCell(x.info.size), cell(typeText(x.info)));
    tr.append(cell(rootLink(x.cid, chainKey), 'mono'));
    if (x.isDir) tr.className = 'lk-dir';
    rows.append(tr);
  }
  if (r.items.length > MAX_ROWS) {
    const tr = document.createElement('tr');
    const td = cell(`${count(r.items.length - MAX_ROWS, 'more entry', 'more entries')} not shown. abxfs-rs read lists them all.`);
    td.colSpan = 4;
    tr.append(td);
    rows.append(tr);
  }
  $('#lk-files thead').hidden = false;
  $('#lk-files tbody').replaceChildren(rows);
}

function showFile(info, root) {
  $('#lk-facts').textContent = `File · ${bytes(info.size)} stored size · ${info.mime}`;
  $('#lk-checked').textContent =
    'Checked in this browser: the file CID against the file info the chain returned. ' +
    'As reported by the chain, not checked here: the size, the chunk tree and the contents. abxfs-rs read checks those too.';
  const rows = [
    ['Stored size', sizeCell(info.size)],
    ['Type', cell(info.mime)],
    ['Encoding', cell(info.codecName || 'none')],
    ['Chunks', cell(info.chunkCount.toLocaleString('en-US'))],
    ['Chunk tree root', cell(info.root === ZERO ? 'none (empty file)' : info.root, 'mono lk-hash')],
    ['File CID', cell(root, 'mono lk-hash')],
  ].map(([k, td]) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    td.classList.remove('n');
    tr.append(th, td);
    return tr;
  });
  $('#lk-files thead').hidden = true;
  $('#lk-files tbody').replaceChildren(...rows);
}

let busy = false;

// Look up `root` on one endpoint, at the block it reports.
async function lookupAt(chain, url, root) {
  const ctx = { chain, url, requests: 0, ethCalls: 0, block: null };
  const [id, block] = await Promise.all([rpc(ctx, 'eth_chainId', []), rpc(ctx, 'eth_blockNumber', [])]);
  const idn = quantity(id, 'the chain id');
  if (idn !== chain.id) throw new LookupError('rpc', `${host(url)} answered for chain ${idn}`);
  ctx.blockNumber = quantity(block, 'the block number');
  ctx.block = block;
  try {
    return { ctx, r: await walk(ctx, root) };
  } catch (e) {
    e.ctx = ctx;
    throw e;
  }
}

async function lookup() {
  if (busy) return;
  const raw = $('#lk-root').value.trim();
  const chainKey = $('#lk-chain').value;
  const status = $('#lk-status');
  $('#lk-result').hidden = true;
  if (!Object.hasOwn(CHAINS, chainKey)) {
    status.textContent = 'Pick one of the listed chains.';
    return;
  }
  const chain = CHAINS[chainKey];
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    status.textContent = 'That is not a root: a root is 0x followed by 64 hexadecimal characters.';
    return;
  }
  const root = raw.toLowerCase();
  $('#lk-root').value = root;
  const url = new URL(location.href);
  url.searchParams.set('root', root);
  url.searchParams.set('chain', chainKey);
  url.hash = 'lookup';
  history.replaceState(null, '', url);
  busy = true;
  $('#lk-go').disabled = true;
  status.textContent = `Asking ${chain.name}…`;
  const t0 = performance.now();
  try {
    let done = null, lastRpc = null;
    for (const endpoint of chain.rpcs) {
      try {
        done = await lookupAt(chain, endpoint, root);
        break;
      } catch (e) {
        if (e.kind !== 'rpc') throw e;
        lastRpc = e;
      }
    }
    if (!done) throw lastRpc;
    const { ctx, r } = done;
    const ms = performance.now() - t0;
    $('#lk-shown').textContent = root;
    if (r.kind === 'file') showFile(r.info, root); else showDirectory(r, chainKey);
    $('#lk-where').textContent = `${chain.name}, block ${ctx.blockNumber.toLocaleString('en-US')}, asked ${host(ctx.url)}. ` +
      `Read in ${(ms / 1000).toFixed(1)} s with ${count(ctx.ethCalls, 'eth_call', 'eth_calls')} over ${count(r.rounds, 'round', 'rounds')}.`;
    $('#lk-result').hidden = false;
    $('#lk-result').dataset.ms = Math.round(ms);
    status.textContent = '';
  } catch (e) {
    if (e.kind === 'notfound') {
      const head = `Not found on ${chain.name}: no directory or file has this root at block ` +
        `${e.ctx.blockNumber.toLocaleString('en-US')} (asked ${host(e.ctx.url)}). `;
      status.textContent = head + 'Checking the other chains…';
      const states = await elsewhere(root, chainKey);
      const found = states.filter((x) => x.state === 'present').map((x) => x.key);
      const unknown = states.filter((x) => x.state === 'unknown').map((x) => CHAINS[x.key].name);
      const join = (list) => list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
      status.replaceChildren(head);
      if (found.length) {
        status.append('It exists on ');
        found.forEach((n, i) => {
          if (i) status.append(i === found.length - 1 ? ' and ' : ', ');
          status.append(rootLink(root, n, CHAINS[n].name));
        });
        status.append('.');
      } else if (!unknown.length) status.append('It is not on any of the other five chains either.');
      else status.append('It is not on the other chains that answered.');
      if (unknown.length) status.append(` Could not check ${join(unknown)}.`);
    } else if (e.kind === 'rpc') {
      status.textContent = `Could not read ${chain.name}: ${e.message}. Try again, or pick another chain.`;
    } else if (e.kind === 'toolarge') {
      status.textContent = `This root is too large to inspect here: ${e.message}. Use abxfs-rs read instead.`;
    } else {
      status.textContent = `The chain's answer did not check out: ${e.message || e}.`;
    }
  } finally {
    busy = false;
    $('#lk-go').disabled = false;
  }
}

function fromQuery() {
  const q = new URLSearchParams(location.search);
  const root = q.get('root'), chain = q.get('chain');
  if (chain && Object.hasOwn(CHAINS, chain)) $('#lk-chain').value = chain;
  if (root) {
    $('#lk-root').value = root;
    lookup();
  }
}

$('#lk-form').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
document.querySelector('#lookup').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-root]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !Object.hasOwn(CHAINS, a.dataset.chain)) return;
  e.preventDefault();
  $('#lk-root').value = a.dataset.root;
  $('#lk-chain').value = a.dataset.chain;
  $('#lookup').scrollIntoView({ block: 'start' });
  lookup();
});
fromQuery();
