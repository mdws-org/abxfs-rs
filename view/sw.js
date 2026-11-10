// The from-chain viewer's service worker. It answers every request for this origin's pages and files with bytes
// read from ABX FS on chain, each file checked back to the root before it is served (site/chain.js, copied beside
// this file by tools/build-view.py). The hostname names what is shown (site/target.js). Requests under /_abxfs/
// are the viewer's own files and go to the network.

import { CHAINS, LookupError, ZERO, fromHex, host, quantity, readFile, rpc, walk, word } from './chain.js';
import { parseHost } from './target.js';

const TOKEN_PARAM = '0x6bd39222'; // tokenParam(uint256,bytes32)
const KEY_CID = '61627866732e636964'.padEnd(64, '0'); // "abxfs.cid"
const HEAD_TTL_MS = 60_000;
const STORE = 'abxfs-view-v1';
const OWN = '/_abxfs/';

const target = parseHost(self.location.hostname);
const chain = target && Object.values(CHAINS).find((c) => c.id === target.chainId);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const ctxFor = (url) => ({ chain, url, requests: 0, ethCalls: 0, block: 'latest' });

// Each endpoint is asked for its chain id once per worker life; one that answers for another chain is not used.
const chainOk = new Map();
function onChain(url) {
  if (!chainOk.has(url)) {
    chainOk.set(url, rpc(ctxFor(url), 'eth_chainId', []).then((id) => {
      if (quantity(id, 'the chain id') !== chain.id) throw new LookupError('rpc', `${host(url)} answered for another chain`);
    }));
    chainOk.get(url).catch(() => chainOk.delete(url));
  }
  return chainOk.get(url);
}

// Run a read on the first endpoint that can be reached. A reply that fails a check is not retried elsewhere.
async function onAnyEndpoint(fn) {
  let last;
  for (const url of chain.rpcs) {
    try {
      await onChain(url);
      return await fn(ctxFor(url));
    } catch (e) {
      if (e.kind !== 'rpc') throw e;
      last = e;
    }
  }
  throw last;
}

/* ── which root ──────────────────────────────────────────────────────────── */

// A project's current root is the one value here that no hash can check, so every endpoint is asked and all
// that answer must agree. `sources` names the endpoints that answered.
async function askHead() {
  const data = TOKEN_PARAM + word(BigInt(target.token)) + KEY_CID;
  const answers = await Promise.allSettled(chain.rpcs.map(async (url) => {
    await onChain(url);
    const res = fromHex(await rpc(ctxFor(url), 'eth_call', [{ to: target.org, data }, 'latest']));
    if (res.length < 32) throw new LookupError('check', 'tokenParam returned too little');
    return { url, root: '0x' + Array.from(res.subarray(0, 32), (x) => x.toString(16).padStart(2, '0')).join('') };
  }));
  const got = answers.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  if (!got.length) throw answers[0].reason;
  return got;
}

let head = null; // { root, sources, at }
async function currentRoot() {
  if (target.kind === 'root') return target.root;
  if (head && Date.now() - head.at < HEAD_TTL_MS) return head.root;
  let got;
  try {
    got = await askHead();
    if (new Set(got.map((g) => g.root)).size > 1) {
      // One endpoint can be a block behind right after a publish: ask once more before refusing.
      await new Promise((r) => setTimeout(r, 2500));
      got = await askHead();
    }
  } catch (e) {
    // Offline or every endpoint down: keep showing the version last read, if there is one.
    const kept = head || await loadJson('head');
    if (e.kind === 'rpc' && kept) { head = { ...kept, at: Date.now() - HEAD_TTL_MS + 10_000, stale: true }; return head.root; }
    throw e;
  }
  if (new Set(got.map((g) => g.root)).size > 1) throw new LookupError('check', `the endpoints disagree about this project's current version (${got.map((g) => host(g.url)).join(', ')})`);
  if (got[0].root === ZERO) throw new LookupError('notfound', 'this project has nothing published');
  head = { root: got[0].root, sources: got.map((g) => host(g.url)), at: Date.now() };
  await saveJson('head', head);
  return head.root;
}

/* ── storage ─────────────────────────────────────────────────────────────── */

const store = () => caches.open(STORE);
const key = (name) => `${OWN}store/${name}`;
async function loadJson(name) {
  const hit = await (await store()).match(key(name));
  return hit ? hit.json() : null;
}
async function saveJson(name, value) {
  await (await store()).put(key(name), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
}

/* ── the tree under a root ───────────────────────────────────────────────── */

// root -> Promise<{ kind, files: Map(path -> { cid, info }), dirs: Set(path) }>
const trees = new Map();
function treeOf(root) {
  if (!trees.has(root)) {
    trees.set(root, (async () => {
      let saved = await loadJson(`tree/${root}`);
      if (!saved) {
        const r = await onAnyEndpoint((ctx) => walk(ctx, root));
        saved = r.kind === 'file'
          ? { kind: 'file', files: [['', { cid: root, info: plain(r.info) }]], dirs: [] }
          : {
            kind: 'directory',
            files: r.items.filter((x) => !x.isDir && !x.invalid).map((x) => [x.path, { cid: x.cid, info: plain(x.info) }]),
            dirs: r.items.filter((x) => x.isDir && !x.invalid).map((x) => x.path.slice(0, -1)),
          };
        await saveJson(`tree/${root}`, saved);
      }
      return { kind: saved.kind, files: new Map(saved.files), dirs: new Set(saved.dirs) };
    })());
    trees.get(root).catch(() => trees.delete(root));
  }
  return trees.get(root);
}
const plain = ({ root, rootLevel, chunkCount, size, mime, codec, codecName, outputHash }) => ({ root, rootLevel, chunkCount, size, mime, codec, codecName, outputHash });

/* ── files ───────────────────────────────────────────────────────────────── */

const reading = new Map(); // cid -> Promise<{ body: Uint8Array, from }>
function contentOf(cid, info) {
  if (!reading.has(cid)) {
    reading.set(cid, (async () => {
      const cache = await store();
      const hit = await cache.match(key(`file/${cid}`));
      if (hit) return { body: new Uint8Array(await hit.arrayBuffer()), from: 'this browser (checked when first read)' };
      const body = await onAnyEndpoint((ctx) => readFile(ctx, cid, info));
      await cache.put(key(`file/${cid}`), new Response(body)).catch(() => {}); // a full disk only costs the next read
      return { body, from: 'chain' };
    })());
    reading.get(cid).finally(() => reading.delete(cid));
  }
  return reading.get(cid);
}

// The stored MIME type when it is a plain type, with an optional charset; anything else is served as bytes.
const safeMime = (m) => (/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*(;\s*charset=[\w-]+)?$/i.test(m) ? m : 'application/octet-stream');

function withRange(request, body, headers) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!m || (!m[1] && !m[2])) return new Response(request.method === 'HEAD' ? null : body, { headers });
  const size = body.length;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  headers['content-range'] = `bytes ${start}-${end}/${size}`;
  return new Response(request.method === 'HEAD' ? null : body.subarray(start, end + 1), { status: 206, headers });
}

/* ── answering ───────────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function problem(request, status, title, detail) {
  if (request.mode !== 'navigate') return new Response(`${title}: ${detail}`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="stylesheet" href="${OWN}view.css">` +
    `<main><h1>${esc(title)}</h1><p>${esc(detail)}</p><p><a href="${OWN}info.html">What this viewer read and checked</a></p></main>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

const WHY = {
  rpc: [502, 'Could not reach the chain'],
  check: [502, 'The chain’s answer did not check out'],
  notfound: [404, 'Nothing here'],
  toolarge: [502, 'Too large to show here'],
  unsupported: [502, 'This viewer cannot read it'],
};

const clientRoot = new Map(); // a page keeps the root it was loaded at, so its files come from one version

async function answer(event) {
  const { request } = event;
  const url = new URL(request.url);
  try {
    let root = clientRoot.get(event.clientId);
    if (request.mode === 'navigate' || !root) root = await currentRoot();
    if (request.mode === 'navigate' && event.resultingClientId) clientRoot.set(event.resultingClientId, root);
    const tree = await treeOf(root);
    let path;
    try { path = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return problem(request, 400, 'Not a valid address', url.pathname); }
    if (tree.kind === 'file') path = '';
    else if (path === '' || path.endsWith('/')) path += 'index.html';
    else if (tree.dirs.has(path)) return Response.redirect(`${url.pathname}/${url.search}`, 302);
    const found = tree.files.get(path);
    const entry = found || tree.files.get('404.html');
    if (!entry) return problem(request, 404, 'Not in this project', `There is no ${path} under root ${root}.`);
    const { body, from } = await contentOf(entry.cid, entry.info);
    const headers = {
      'content-type': safeMime(entry.info.mime),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'x-abxfs-root': root,
      'x-abxfs-file': entry.cid,
      'x-abxfs-from': from,
    };
    if (!found) return new Response(request.method === 'HEAD' ? null : body, { status: 404, headers });
    return withRange(request, body, headers);
  } catch (e) {
    const [status, title] = WHY[e.kind] || [500, 'The viewer failed'];
    return problem(request, status, title, e.message || String(e));
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith(OWN)) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') return void event.respondWith(new Response(null, { status: 405 }));
  if (!target || !chain) return; // the start page explains
  event.respondWith(answer(event));
});

// The info page asks what this worker is showing and what it has read.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'abxfs-info' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const out = { target, chain: chain && { name: chain.name, id: chain.id, endpoints: chain.rpcs.map(host) }, head };
    try {
      const root = await currentRoot();
      const tree = await treeOf(root);
      const cache = await store();
      out.root = root;
      out.kind = tree.kind;
      out.head = head;
      out.files = await Promise.all([...tree.files].map(async ([path, f]) => ({
        path, cid: f.cid, size: f.info.size, mime: f.info.mime, codec: f.info.codecName,
        read: Boolean(await cache.match(key(`file/${f.cid}`))),
      })));
    } catch (e) {
      out.error = e.message || String(e);
    }
    event.ports[0].postMessage(out);
  })());
});
