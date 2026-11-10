// Look up an ABX FS root on chain: decide whether it is a directory or a file, walk a directory's entry-node tree,
// and read each file's info. The reads and checks are in chain.js; file contents and chunk trees are not read here.
import { CHAINS, LookupError, ZERO, host, ok, quantity, reader, rpc, runViews, view, walk } from './chain.js';
import { viewUrl } from './target.js';

const MAX_ROWS = 2_000;
const $ = (s) => document.querySelector(s);
const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB');
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

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
    const open = viewUrl({ kind: 'root', chainId: chain.id, root });
    $('#lk-open').hidden = !open;
    if (open) $('#lk-open-link').href = open;
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
