// In-browser ABX FS checker: plan a folder with abxfs-rs (WebAssembly), then ask a chain which of its
// objects exist. Nothing is uploaded anywhere; the files never leave the browser. A chain check sends only ids.
import init, { plan_files_json, plan_files_summary, upload_skip_rules, version } from './pkg/abxfs.js';

// Each chain's endpoints, tried in order; a later one is used when an earlier one cannot be reached.
const CHAINS = {
  base: { id: 8453, name: 'Base', rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  'base-sepolia': { id: 84532, name: 'Base Sepolia', rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'] },
  'arbitrum-one': { id: 42161, name: 'Arbitrum One', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  'arbitrum-sepolia': { id: 421614, name: 'Arbitrum Sepolia', rpcs: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'] },
  ethereum: { id: 1, name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  sepolia: { id: 11155111, name: 'Sepolia', rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://0xrpc.io/sep'] },
};
const CHUNK_STORE = '56317b1f45e4c15310135ea72fa4d768ca902bcc';
const FILE_STORE = '8b6077a1d6953d96687005b9408d56a655b4d155';
const DIRECTORY_STORE = '4273e4e078f47303ca15b11959eeb61f3fc94c11';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const SEL = { directoryExists: '61e699c8', fileExists: '0cec5f62', exists: '38a699a4', aggregate3: '82ad56cb' };
const BATCH = 150;

// What this page plans; bigger folders go to the command line.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 32;
// The planner's own skip rules (set once the WebAssembly module loads): the walk neither reads nor counts what
// the upload would drop.
let skipped = () => false;
const TOO_BIG = 'This folder is larger than this page plans (64 MiB, 5,000 files, 32 directory levels). ' +
  'Use the command line instead: abxfs-rs plan <folder>.';

const $ = (s) => document.querySelector(s);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB');
const host = (url) => new URL(url).host;

class InputError extends Error {}
class ReplyError extends Error {}

let plan = null;
let planSawDirs = false; // whether the plan's source reported directories (a drop) or not (the picker)
let lastInput = null; // the planner's arguments, kept for the full-plan download
let generation = 0; // bumped by every new folder; a check or download applies only to the plan it started from

// Running totals of a walk, refused as soon as one passes a limit; no file is read while counting.
function counter() {
  let files = 0, total = 0;
  return {
    file(path, size) {
      if (++files > MAX_FILES || (total += size) > MAX_BYTES) throw new InputError(TOO_BIG);
      if (path.split('/').length - 1 > MAX_DEPTH) throw new InputError(TOO_BIG);
    },
    dir(path) {
      if (path.split('/').length > MAX_DEPTH) throw new InputError(TOO_BIG);
    },
  };
}

// aggregate3((address target, bool allowFailure, bytes callData)[]) with 36-byte callData each.
function encodeAggregate3(calls) {
  const tuples = calls.map(([target, data]) => {
    const pad = data + '0'.repeat((64 - (data.length % 64)) % 64);
    return target.padStart(64, '0') + word(1) + word(0x60) + word(data.length / 2) + pad;
  });
  let off = 32 * calls.length, heads = '';
  for (const t of tuples) { heads += word(off); off += t.length / 2; }
  return '0x' + SEL.aggregate3 + word(0x20) + word(calls.length) + heads + tuples.join('');
}

// (bool success, bytes returnData)[] -> [true|false|null]: the bool each call returned, null when the call failed.
// Anything short, out of range or not a canonical bool is refused.
function decodeAggregate3(hex, n) {
  if (typeof hex !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(hex)) throw new ReplyError('the reply is not hex bytes');
  const h = hex.slice(2);
  const size = h.length / 2;
  const at = (off) => {
    if (!Number.isSafeInteger(off) || off < 0 || off + 32 > size) throw new ReplyError('the reply runs short');
    const w = h.slice(off * 2, off * 2 + 64);
    if (!/^0{48}/.test(w)) throw new ReplyError('a value in the reply is out of range');
    return parseInt(w.slice(48), 16);
  };
  const bool = (off) => {
    const v = at(off);
    if (v !== 0 && v !== 1) throw new ReplyError('a true or false in the reply is neither 0 nor 1');
    return v === 1;
  };
  const arr = at(0);
  if (at(arr) !== n) throw new ReplyError('the reply holds the wrong number of results');
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = arr + 32 + at(arr + 32 + 32 * i);
    const ok = bool(t);
    const d = t + at(t + 32);
    const dlen = at(d);
    if (dlen > 0 && d + 32 + dlen > size) throw new ReplyError('the reply runs short');
    if (!ok) { out.push(null); continue; }
    if (dlen !== 32) throw new ReplyError('a result in the reply is not one word');
    out.push(bool(d + 32));
  }
  return out;
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

// Ask one endpoint for every call at one block. Errors reaching it or from the node are plain Errors (the next
// endpoint is tried); a reply that does not decode is a ReplyError (it is reported, not retried elsewhere).
async function existenceAt(url, c, calls) {
  const id = await rpc(url, 'eth_chainId', []);
  if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id) || parseInt(id, 16) !== c.id) throw new Error(`it answered for another chain`);
  const block = await rpc(url, 'eth_blockNumber', []);
  if (typeof block !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(block)) throw new ReplyError('the block number is not a number');
  const results = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const part = calls.slice(i, i + BATCH);
    const res = await rpc(url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(part) }, block]);
    for (const r of decodeAggregate3(res, part.length)) results.push(r);
  }
  return { results, block: parseInt(block, 16), url };
}

async function existence(chain, calls) {
  const c = CHAINS[chain];
  const tried = [];
  for (const url of c.rpcs) {
    try {
      return await existenceAt(url, c, calls);
    } catch (e) {
      if (e instanceof ReplyError) throw new ReplyError(`${e.message} (from ${host(url)})`);
      tried.push(`${host(url)} (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
  }
  throw new Error(`could not reach ${c.name}: ${tried.join('; ')}`);
}

// Collect every file under a dropped directory entry, with paths relative to `prefix`, and every directory path
// (a dropped folder, unlike the picker, shows empty directories, which the CLI plans). Only sizes are looked at.
async function walkEntry(entry, prefix, out, dirs, count) {
  if (skipped(entry.name)) return;
  const path = prefix + entry.name;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    count.file(path, file.size);
    out.push({ path, file });
  } else if (entry.isDirectory) {
    count.dir(path);
    dirs.push(path);
    await walkChildren(entry, path + '/', out, dirs, count);
  }
}

async function walkChildren(dirEntry, prefix, out, dirs, count) {
  const reader = dirEntry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, prefix, out, dirs, count);
  }
}

async function fromDrop(entries) {
  const folders = entries.filter((e) => e.isDirectory);
  if (folders.length > 1) throw new InputError(`This drop holds ${folders.length} top-level folders. Drop one folder at a time.`);
  const items = [], dirs = [], count = counter();
  // One folder: its contents, relative to it, as the CLI plans its upload root. Loose files: each at the top.
  if (folders.length === 1 && entries.length === 1) await walkChildren(folders[0], '', items, dirs, count);
  else for (const e of entries) await walkEntry(e, '', items, dirs, count);
  return { items, dirs, sawDirs: true };
}

function fromPicker(fileList) {
  const count = counter();
  const items = [];
  for (const file of fileList) {
    // The picker names files under the chosen folder; drop that folder's own name.
    const full = file.webkitRelativePath || file.name;
    const path = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full;
    if (path.split('/').some(skipped)) continue;
    count.file(path, file.size);
    items.push({ path, file });
  }
  return { items, dirs: [], sawDirs: false };
}

async function planFiles({ items, dirs, sawDirs }) {
  const paths = items.map((x) => x.path);
  const sizes = items.map((x) => x.file.size);
  const data = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let at = 0;
  for (const x of items) {
    const buf = new Uint8Array(await x.file.arrayBuffer());
    if (buf.length !== x.file.size) throw new InputError(`"${x.path}" changed size while it was read`);
    data.set(buf, at);
    at += buf.length;
  }
  const t0 = performance.now();
  const input = [paths, Float64Array.from(sizes), data, true, false, dirs];
  const summary = JSON.parse(plan_files_summary(...input));
  return { summary, input, ms: performance.now() - t0, picked: items.length, sawDirs };
}

function showPlan({ summary, ms, picked, sawDirs }) {
  $('#dirs-note').hidden = sawDirs;
  $('#onchain-head').textContent = '';
  $('#root').textContent = summary.rootCid;
  const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  $('#plan-facts').textContent =
    `${count(summary.files.length, 'file', 'files')} (of ${picked.toLocaleString('en-US')} picked) · ` +
    `${count(summary.directories.length, 'directory', 'directories')} · ${count(summary.uniqueChunks, 'chunk', 'chunks')} · ` +
    `${bytes(summary.storedBytes)} stored · planned in ${ms.toFixed(0)} ms`;
  const rows = document.createDocumentFragment();
  for (const f of summary.files) {
    const tr = document.createElement('tr');
    for (const [i, v] of [f.path, bytes(f.logicalSize), f.mimeType, short(f.cid), ''].entries()) {
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 1) td.className = 'n';
      if (i === 3) td.title = f.cid;
      tr.append(td);
    }
    rows.append(tr);
  }
  $('#files tbody').replaceChildren(rows);
  $('#result').hidden = false;
  $('#chain-result').textContent = '';
}

async function handle(inputPromise) {
  const g = ++generation;
  plan = null;
  lastInput = null;
  $('#result').hidden = true;
  $('#chain-result').textContent = '';
  $('#status').textContent = 'Planning…';
  try {
    const input = await inputPromise;
    if (g !== generation) return;
    if (!input.items.length && !input.dirs.length) throw new InputError('no files in that folder');
    const planned = await planFiles(input);
    if (g !== generation) return;
    plan = planned.summary;
    planSawDirs = planned.sawDirs;
    lastInput = planned.input;
    showPlan(planned);
    $('#status').textContent = '';
  } catch (e) {
    if (g !== generation) return;
    $('#status').textContent = 'Could not plan this folder: ' + (e.message || e);
  }
}

async function check() {
  if (!plan) return;
  const g = generation, p = plan, sawDirs = planSawDirs;
  const chain = $('#chain').value;
  if (!Object.hasOwn(CHAINS, chain)) return;
  const name = CHAINS[chain].name;
  const chunkIds = [...new Set(p.files.flatMap((f) => f.chunkIds))];
  const calls = [
    [DIRECTORY_STORE, SEL.directoryExists + p.rootCid.slice(2)],
    ...p.files.map((f) => [FILE_STORE, SEL.fileExists + f.cid.slice(2)]),
    ...chunkIds.map((id) => [CHUNK_STORE, SEL.exists + id.slice(2)]),
  ];
  $('#chain-result').textContent = `Asking ${name}…`;
  try {
    const { results, block, url } = await existence(chain, calls);
    if (g !== generation) return;
    if (results.some((r) => r === null)) throw new Error(`some checks failed at ${host(url)}; try again`);
    const fileHits = results.slice(1, 1 + p.files.length);
    const files = fileHits.filter(Boolean).length;
    const chunks = results.slice(1 + p.files.length).filter(Boolean).length;
    [...$('#files tbody').rows].forEach((tr, i) => { tr.lastChild.textContent = fileHits[i] ? 'Stored' : 'New'; });
    $('#onchain-head').textContent = `On ${name}`;
    const n = block.toLocaleString('en-US');
    $('#chain-result').textContent = (results[0]
      ? `Root stored on ${name} at block ${n}: this exact tree exists in the store, which is shared; it does not ` +
        `show which project, if any, uses it or who uploaded it.`
      : `Root not stored on ${name} at block ${n}. File entries whose CIDs exist: ${files} of ${p.files.length}. ` +
        `Unique chunk ids that exist: ${chunks} of ${chunkIds.length}.`) +
      ` Asked ${host(url)}. Planned with FastLZ on and hidden files off, as the CLI defaults` +
      (sawDirs ? '.' : ', from the folder as the picker reported it (empty directories not seen).');
  } catch (e) {
    if (g !== generation) return;
    $('#chain-result').textContent = e instanceof ReplyError
      ? `The chain's answer did not check out: ${e.message}.`
      : 'Check failed: ' + (e.message || e);
  }
}

function download() {
  if (!lastInput || !plan) return;
  const g = generation, input = lastInput, root = plan.rootCid;
  try {
    const json = plan_files_json(...input);
    if (g !== generation) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `abxfs-plan-${root.slice(2, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    if (g === generation) $('#chain-result').textContent = 'Could not make the plan file: ' + (e.message || e);
  }
}

await init();
{
  const rules = JSON.parse(upload_skip_rules());
  const ignore = new Set(rules.ignore), allow = new Set(rules.allow);
  skipped = (name) => ignore.has(name) || (name.startsWith('.') && !allow.has(name));
}
$('#tool-version').textContent = version();
$('#folder').addEventListener('change', (e) => {
  const files = [...e.target.files];
  handle((async () => fromPicker(files))());
});
$('#download').addEventListener('click', download);
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean);
  handle(fromDrop(entries));
});
$('#check').addEventListener('click', check);
