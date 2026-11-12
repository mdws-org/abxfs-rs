// The from-chain viewer's service worker. It answers every request for this origin's pages and files with bytes
// read from ABX FS on chain, each file checked back to the root before it is served (site/chain.js, copied beside
// this file by tools/build-view.py). The hostname names what is shown (site/target.js). Requests under /_abxfs/
// are the viewer's own files and go to the network.
//
// Nothing kept in the browser is trusted. A project's own scripts share this origin and can write its storage,
// so the only things stored are raw chain replies, and every one of them passes the same checks as a fresh
// reply each time it is used. Checked results live in this worker's memory only.
//
// On a chain this viewer has a light client for, a project's current root is also read by proof at the newest
// finalized block and compared with what the endpoints give at that block. If the two differ, one of them is
// wrong and nothing here can tell which, so the project is not shown. This origin states no verdict of its own:
// a project's scripts could rewrite any words shown here. The verdict is on the check page, on another origin.

import { CHAINS, LookupError, ZERO, fromHex, hash, host, quantity, readFile, rpc, walk, word } from './chain.js';
import { checkUrl, gatewayUrl, parseHost, viewUrl } from './target.js';
import { BUILD, FILES } from './files.js';
import { BEACONS, CHECKPOINTS } from './checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock, provedTokenParam, tokenParamAt } from './proved.js';
import { judge, judgeComputed } from './verdict.js';
import { agreedTokenUri, generatorPage, readTokenUri, repliesAt } from './token.js';
import { computedAt } from './evm-state.js';
import { keccak256 } from './keccak-lookup.js';
import { readFile as bamfsRead, walk as bamfsWalk } from './bamfs.js';

const TOKEN_PARAM = '0x6bd39222'; // tokenParam(uint256,bytes32)
const KEY_CID = '61627866732e636964'.padEnd(64, '0'); // "abxfs.cid"
const KEY_BAMFS = '62616d66732e636964'.padEnd(64, '0'); // "bamfs.cid": a project published to BAMFS, before ABX FS
const HEAD_TTL_MS = 60_000;
// About two minutes of blocks on each chain: how far an endpoint may be from the middle one.
const MAX_LAG_BLOCKS = { 1: 10, 8453: 60, 84532: 60, 42161: 480, 421614: 480, 4663: 1200, 11155111: 10 };
const STORE = 'abxfs-view-v2';
const OWN = '/_abxfs/';
const OWN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const READS_AT_ONCE = 3;
const MEMORY_BYTES = 96 * 1024 * 1024;

const target = parseHost(self.location.hostname);
const chain = target && Object.values(CHAINS).find((c) => c.id === target.chainId);
const enc = new TextEncoder();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('abxfs-view-') && name !== STORE) await caches.delete(name);
  // Copies kept by an earlier build are of no use to this one.
  try {
    const cache = await store();
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith(`${OWN}store/own/`) && !path.startsWith(`${OWN}store/own/${BUILD}/`)) await cache.delete(req);
    }
  } catch { /* nothing to clear */ }
  await self.clients.claim();
  await keepOwnFiles();
})()));

const ctxFor = (url) => ({ chain, url, requests: 0, ethCalls: 0, block: 'latest' });

/* ── which endpoints ─────────────────────────────────────────────────────── */

// A reader can name an endpoint of their own on the info page, such as their own node. It is asked first for
// every read whose reply is checked against the root (the directory tree, the file records, the chunks), so
// those reads need not touch anyone else's server.
//
// It is never asked for a project's current root, and it does not count toward the two endpoints that must
// agree on it. The setting is kept in this origin's storage, which a project's own scripts can also write, and
// an earlier version's script, or a token's previous owner, could plant an endpoint there. Kept out of the one
// unchecked read, a planted endpoint can fail or log a read and nothing more: a failed read moves on to the
// public endpoints.
let custom = null; // the endpoint's URL
function validEndpoint(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) return null;
  if (u.username || u.password || u.hash || u.origin === self.location.origin) return null;
  return u.href;
}
const sameUrl = (a, b) => new URL(a).href === new URL(b).href;
// For checked reads only.
const endpoints = () => (custom ? [custom, ...chain.rpcs.filter((u) => !sameUrl(u, custom))] : chain.rpcs);

/* ── stored replies ──────────────────────────────────────────────────────── */

const store = () => caches.open(STORE);
const replyKey = (key) => `${OWN}store/reply/${hash(enc.encode(key)).slice(2)}`;
const replies = {
  async get(key) {
    const hit = await (await store()).match(replyKey(key));
    return hit ? hit.text() : null;
  },
};
// Keep replies for a later visit. A full disk only costs that visit a re-read.
async function keep(entries) {
  try {
    const cache = await store();
    await Promise.all(entries.map(([k, v]) => cache.put(replyKey(k), new Response(v))));
  } catch { /* not kept */ }
}

const SETTING = `${OWN}store/setting/endpoint`;
const settingLoaded = (async () => {
  try {
    const hit = await (await store()).match(SETTING);
    custom = hit ? validEndpoint(await hit.text()) : null;
  } catch { custom = null; }
})();

/* ── the viewer's own files ──────────────────────────────────────────────── */

// The viewer's pages and scripts come from its host. A copy of each is kept, and served when the host cannot
// be reached, but only if its SHA-256 is the one this worker was built with (files.js): a copy that a
// project's scripts replaced in storage is not served.
const ownKey = (path) => `${OWN}store/own/${BUILD}${path}`;
const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
// The type comes from the file's name, never from a stored copy's headers, which a project's scripts could set.
const OWN_TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
function ownResponse(path, body, from) {
  return new Response(body, { headers: {
    'content-type': OWN_TYPES[path.split('.').pop()] || 'application/octet-stream',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
    'content-security-policy': OWN_CSP, 'x-abxfs-from': from,
  } });
}
async function keptCopy(path) {
  const hit = await (await store()).match(ownKey(path));
  if (!hit) return null;
  const body = await hit.arrayBuffer();
  return await sha256(body) === FILES[path] ? body : null;
}
// The host's current copy of one viewer file, and whether it is the one this worker was built with.
async function fromHost(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`the host answered ${r.status}`);
  const body = await r.arrayBuffer();
  const same = await sha256(body) === FILES[path];
  if (same) await (await store()).put(ownKey(path), new Response(body)).catch(() => {});
  return { body, same };
}

// Fetch every viewer file once and keep the ones that match, so the info page and its styles are there later
// even if the reader never opened them while the host was up.
async function keepOwnFiles() {
  await Promise.all(Object.keys(FILES).map(async (path) => {
    if (!await keptCopy(path)) await fromHost(path).catch(() => {});
  }));
}

// A viewer page or script. The copy that matches this worker's build is served whether or not the host
// answers, so a host cannot change the info page under a worker that is already installed. A file with no
// matching copy comes from the host and is marked when it differs from the build.
async function ownFile(request) {
  const path = new URL(request.url).pathname;
  if (!FILES[path]) return fetch(request);
  const kept = await keptCopy(path);
  if (kept) return ownResponse(path, kept, 'kept copy, matches this build');
  const { body, same } = await fromHost(path);
  return ownResponse(path, body, same ? 'host, matches this build' : 'host, DIFFERS from this build');
}

// Run a read whose every reply is checked (walk, readFile). Stored replies are tried first; if they fail a
// check the same endpoint is asked afresh, and an endpoint whose replies fail is passed over for the next one.
// Only a size limit ends the search early: sizes are bound to the root.
async function checkedRead(fn) {
  let worst = null;
  for (const url of endpoints()) {
    for (const skipStored of [false, true]) {
      const ctx = { ...ctxFor(url), store: replies, skipStored };
      try {
        const out = await fn(ctx);
        if (ctx.fresh && ctx.fresh.length) await keep(ctx.fresh);
        return out;
      } catch (e) {
        // What an interrupted read already fetched is kept too: stored replies are checked on every use.
        if (e.kind === 'rpc' && ctx.fresh && ctx.fresh.length) await keep(ctx.fresh);
        if (!(e instanceof LookupError) || e.kind === 'toolarge') throw e;
        if (!worst || (worst.kind === 'rpc' && e.kind !== 'rpc')) worst = e;
        if (skipStored || !ctx.storedHits || e.kind === 'rpc') break;
      }
    }
  }
  throw worst;
}

/* ── which root ──────────────────────────────────────────────────────────── */

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

// A project's current root is the one value here that no hash can check. Every endpoint is asked for its block
// number; the root is then read from each at the lowest of those blocks, so honest endpoints give one answer.
// At least two must answer and all that answer must agree.
async function askHead() {
  const settled = (list) => list.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  const up = settled(await Promise.allSettled(chain.rpcs.map(async (url) => {
    await onChain(url);
    return { url, block: quantity(await rpc(ctxFor(url), 'eth_blockNumber', []), 'the block number') };
  })));
  // An endpoint whose block is far from the others' is left out: a low one would pull the read back to an
  // older version of the project, a high one is not the chain the others see.
  const sorted = up.map((u) => u.block).sort((x, y) => x - y);
  const middle = sorted[(sorted.length - 1) >> 1];
  const near = up.filter((u) => Math.abs(u.block - middle) <= (MAX_LAG_BLOCKS[chain.id] ?? 10));
  if (near.length < 2) throw new LookupError('rpc', `fewer than two endpoints for ${chain.name} are at the same height, and a project's current version needs two that agree`);
  up.splice(0, up.length, ...near);
  const block = Math.min(...up.map((u) => u.block));
  // One token parameter from every endpoint at that block: at least two must answer, and all must agree.
  // A contract with no token parameters (an image token) reverts. A revert is an answer, and it is recorded as
  // the zero root, "nothing published": the token may still have a page of its own in tokenURI.
  const param = async (key) => {
    const data = TOKEN_PARAM + word(BigInt(target.token)) + key;
    const got = settled(await Promise.allSettled(up.map(async ({ url }) => {
      let reply;
      try { reply = await rpc(ctxFor(url), 'eth_call', [{ to: target.org, data }, '0x' + block.toString(16)]); } catch (e) {
        if (e.kind === 'rpc' && /revert/i.test(e.message || '')) return { url, root: ZERO };
        throw e;
      }
      const res = fromHex(reply);
      if (res.length < 32) throw new LookupError('check', 'tokenParam returned too little');
      return { url, root: '0x' + Array.from(res.subarray(0, 32), (x) => x.toString(16).padStart(2, '0')).join('') };
    })));
    if (got.length < 2) throw new LookupError('rpc', `fewer than two endpoints answered at block ${block}`);
    if (new Set(got.map((g) => g.root)).size > 1) throw new LookupError('check', `the endpoints disagree about this project's current version at block ${block} (${got.map((g) => host(g.url)).join(', ')})`);
    return got;
  };
  let got = await param(KEY_CID), key = KEY_CID;
  // No ABX FS root: the project may have been published to BAMFS, whose root is kept under another name.
  if (got[0].root === ZERO) {
    const older = await param(KEY_BAMFS).catch(() => null);
    if (older && older[0].root !== ZERO) { got = older; key = KEY_BAMFS; }
  }
  return { root: got[0].root, sources: got.map((g) => host(g.url)), block, key };
}

/* ── proof ───────────────────────────────────────────────────────────────── */

const PROOF_TTL_MS = 5 * 60_000; // finality moves about every six and a half minutes
const PROOF_WAIT_MS = 20_000;
const SWITCH_TTL_MS = 60_000;

// The host can turn proving off for every installed viewer by serving { "proof": false } here: a wrong proof
// then stops nobody. It can only take the comparison away, and once this worker has seen it off it stays off
// for the worker's life. A host that cannot be reached leaves proving as it was.
let switchAt = 0, switchOn = true;
async function proofAllowed() {
  if (!switchOn || Date.now() - switchAt < SWITCH_TTL_MS) return switchOn;
  switchAt = Date.now();
  try {
    const r = await fetch(`${OWN}switch.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (r.ok && (await r.json()).proof === false) switchOn = false;
  } catch { /* unreachable: unchanged */ }
  return switchOn;
}

// The root read by proof at the newest finalized block, and what the endpoints give at that block.
let proofMemo = null; // { at, key, value: Promise<{ proved, atFinalized }> }
function prove(key = KEY_CID) {
  if (proofMemo && proofMemo.key === key && Date.now() - proofMemo.at < PROOF_TTL_MS) return proofMemo.value;
  const value = (async () => {
    const urls = PROOF_ENDPOINTS[chain.id];
    const fin = await finalizedBlock({ chainId: chain.id, checkpoint: CHECKPOINTS[chain.id].root, beacons: BEACONS[chain.id] });
    const proved = await provedTokenParam({ fin, urls, org: target.org, token: target.token, key });
    // Asked of the proof endpoints and of the endpoints the current root comes from, by block hash.
    const atFinalized = proved.known ? await tokenParamAt({ urls: [...urls, ...chain.rpcs], org: target.org, token: target.token, blockHash: proved.block.hash, key }) : [];
    return { proved, atFinalized };
  })();
  proofMemo = { at: Date.now(), key, value };
  value.catch(() => { if (proofMemo && proofMemo.value === value) proofMemo = null; });
  return value;
}

// Compare the agreed head with the proof. Throws only on a mismatch; a proof that cannot be had (no light
// client for this chain, proving switched off, a server down, a shipped root past its 14 days) changes nothing
// here, because this origin claims nothing. `deps` lets tests/settle.mjs supply made-up answers.
async function settle(got, deps = { allowed: proofAllowed, prove }) {
  if (!chain || !CHECKPOINTS[chain.id] || !PROOF_ENDPOINTS[chain.id]) return { state: 'agreed', reason: `no light client for ${chain ? chain.name : 'this chain'}` };
  if (!await deps.allowed()) return { state: 'agreed', reason: 'proving is switched off on this host' };
  const decide = (found) => {
    const verdict = { ...judge({ ...found, agreedHead: got }), proved: found.proved, atFinalized: found.atFinalized };
    if (verdict.state !== 'mismatch') return verdict;
    const e = new LookupError('mismatch', verdict.reason);
    e.verdict = verdict;
    e.agreed = got;
    throw e;
  };
  const proving = deps.prove(got.key);
  let found;
  try {
    found = await Promise.race([proving, new Promise((_, no) => setTimeout(() => no(new Error('the proof took too long')), deps.waitMs ?? PROOF_WAIT_MS))]);
  } catch (e) {
    // The page is not held longer than this, but the proof is still wanted: if it arrives and does not match,
    // that is kept, and nothing more is served from this version.
    proving.then((late) => { try { decide(late); } catch (m) { lateMismatch = { at: Date.now(), error: m }; head = null; } }, () => {});
    return { state: 'agreed', reason: `no proof: ${e.message || e}` };
  }
  return decide(found);
}
// A mismatch that arrived after a page had already been answered. It stands for as long as a proof is kept.
let lateMismatch = null;

let head = null; // { root, sources, block, at, stale, verdict }
let asking = null;
function currentRoot() {
  if (target.kind === 'root') return Promise.resolve(target.root);
  if (lateMismatch && Date.now() - lateMismatch.at < PROOF_TTL_MS) return Promise.reject(lateMismatch.error);
  if (head && Date.now() - head.at < HEAD_TTL_MS) return Promise.resolve(head.root);
  asking ||= (async () => {
    try {
      const got = await askHead();
      const verdict = await settle(got);
      if (got.root === ZERO) {
        // No ABX FS root. The token may still have a page of its own, in tokenURI: see tokenAnswer.
        const none = new LookupError('notfound', 'this project has nothing published');
        none.block = got.block;
        throw none;
      }
      head = { ...got, at: Date.now(), stale: false, verdict: { state: verdict.state, reason: verdict.reason } };
    } catch (e) {
      // A mismatch is never papered over with an earlier version.
      if (e.kind === 'mismatch') { head = null; throw e; }
      // The endpoints cannot be reached: keep the version this worker last agreed on, marked as old.
      if (e.kind !== 'rpc' || !head) throw e;
      head = { ...head, at: Date.now() - HEAD_TTL_MS + 10_000, stale: true };
    }
    return head.root;
  })().finally(() => { asking = null; });
  return asking;
}

// A page keeps the root it was loaded at, so its files come from one version. The worker can be stopped and
// started again while a page is open, so the pairing is also written down; a root read back from there is used
// like any other root, through the checked reads.
const clientRoot = new Map();
let lastNavRoot = null;
const pinKey = (id) => `${OWN}store/pin/${id}`;
async function pin(clientId, root) {
  clientRoot.set(clientId, root);
  lastNavRoot = root;
  try {
    const cache = await store();
    await cache.put(pinKey(clientId), new Response(root));
    const live = new Set((await self.clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
    for (const req of await cache.keys()) {
      const m = new URL(req.url).pathname.match(/\/store\/pin\/(.+)$/);
      if (m && m[1] !== clientId && !live.has(m[1])) await cache.delete(req);
    }
  } catch { /* the pairing stays in memory */ }
}
async function pinned(clientId) {
  if (!clientId) return null;
  if (clientRoot.has(clientId)) return clientRoot.get(clientId);
  try {
    const hit = await (await store()).match(pinKey(clientId));
    const root = hit && await hit.text();
    if (root && /^0x[0-9a-f]{64}$/.test(root)) { clientRoot.set(clientId, root); return root; }
  } catch { /* fall through */ }
  return null;
}

/* ── the tree under a root ───────────────────────────────────────────────── */

// root -> Promise<{ kind, files: Map(path -> { cid, info }), dirs: Set(path), unnamed }>
const trees = new Map();
function treeOf(root) {
  if (!trees.has(root)) {
    // A root no ABX FS store knows may be a BAMFS root; the hashes settle which, not the name it was found under.
    const read = checkedRead((ctx) => walk(ctx, root)).catch((e) => { if (e.kind !== 'notfound') throw e; return checkedRead((ctx) => bamfsWalk(ctx, root)); });
    trees.set(root, read.then((r) => {
      if (r.kind === 'file') return { kind: 'file', files: new Map([['', { cid: root, info: r.info }]]), dirs: new Set(), unnamed: 0 };
      const files = new Map(), dirs = new Set();
      for (const x of r.items) {
        if (x.invalid) continue;
        const path = x.isDir ? x.path.slice(0, -1) : x.path;
        if (files.has(path) || dirs.has(path)) throw new LookupError('check', `two entries under this root have the path ${path}`);
        if (x.isDir) dirs.add(path); else files.set(path, { cid: x.cid, info: x.info });
      }
      return { kind: 'directory', files, dirs, unnamed: r.items.filter((x) => x.invalid).length };
    }));
    trees.get(root).catch(() => trees.delete(root));
    if (trees.size > 8) trees.delete(trees.keys().next().value);
  }
  return trees.get(root);
}

/* ── files ───────────────────────────────────────────────────────────────── */

// Checked file contents, kept for this worker's life, oldest dropped past MEMORY_BYTES.
const bodies = new Map();
let bodyBytes = 0;
function remember(cid, body) {
  if (body.length > MEMORY_BYTES / 2) return;
  bodies.set(cid, body);
  bodyBytes += body.length;
  for (const [old, b] of bodies) {
    if (bodyBytes <= MEMORY_BYTES) break;
    bodies.delete(old);
    bodyBytes -= b.length;
  }
}

let readsOpen = 0;
const readsWaiting = [];
async function oneOfFew(fn) {
  if (readsOpen >= READS_AT_ONCE) await new Promise((r) => readsWaiting.push(r));
  readsOpen++;
  try { return await fn(); } finally { readsOpen--; readsWaiting.shift()?.(); }
}

const reading = new Map(); // cid -> Promise<Uint8Array>, so one file is assembled once however many ask
function contentOf(cid, info) {
  if (bodies.has(cid)) return Promise.resolve(bodies.get(cid));
  if (!reading.has(cid)) {
    reading.set(cid, oneOfFew(() => checkedRead((ctx) => (info.generation ? bamfsRead(ctx, cid, info) : readFile(ctx, cid, info)))).then((body) => { remember(cid, body); return body; }));
    reading.get(cid).finally(() => reading.delete(cid)).catch(() => {});
  }
  return reading.get(cid);
}

// The stored MIME type when it is a plain type, with an optional charset; anything else is served as bytes.
const safeMime = (m) => (/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*(;\s*charset=[\w-]+)?$/i.test(m) ? m : 'application/octet-stream');

function withRange(request, body, headers) {
  const head = request.method === 'HEAD';
  const m = head ? null : /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!m || (!m[1] && !m[2])) return new Response(head ? null : body, { headers: { ...headers, 'content-length': String(body.length) } });
  const size = body.length;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(body.subarray(start, end + 1), {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
  });
}

/* ── answering ───────────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function problem(request, status, title, detail) {
  if (request.mode !== 'navigate') {
    return new Response(`${title}: ${detail}`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="stylesheet" href="${OWN}view.css">` +
    `<main><h1>${esc(title)}</h1><p>${esc(detail)}</p>` +
    (gatewayUrl(target) ? `<p><a href="${esc(gatewayUrl(target))}">Open this project on ABX FS's own gateway</a></p>` : '') +
    `<p><a href="${OWN}info.html">What this viewer read and checked, and how to reset it</a></p></main>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': PAGE_CSP } },
  );
}

// The proof and the endpoints give different roots at one block. Both are shown, each openable by its own
// fixed address, where every file is checked against that root and no "current" question arises.
function mismatchPage(request, e) {
  if (request.mode !== 'navigate') return new Response(`The proof and the endpoints disagree: ${e.message}`, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  const { proved, atFinalized } = e.verdict;
  const open = (root) => { const u = viewUrl({ kind: 'root', chainId: target.chainId, root }); return u ? ` <a href="${esc(u)}">Open this version by its fixed address</a>` : ''; };
  const rows = atFinalized.map(([host_, root]) => `<li><span class="mono">${esc(root)}</span> from ${esc(host_)}${root === proved.root ? ' (the same as the proof)' : open(root)}</li>`).join('');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>The proof and the endpoints disagree</title><link rel="stylesheet" href="${OWN}view.css">` +
    `<main><h1>The proof and the endpoints disagree</h1>` +
    `<p>This viewer read the project's current version two ways at block ${proved.block.number.toLocaleString('en-US')} of ${esc(chain.name)}, and got two answers. One of them is wrong, and nothing here can tell which, so the project is not shown.</p>` +
    `<h2>By proof</h2><p><span class="mono">${esc(proved.root)}</span>, proved from Ethereum's sync committee (${proved.participants} of 512 signed) through ${esc(proved.via)}.${open(proved.root)}</p>` +
    `<h2>From the endpoints, at the same block</h2><ul>${rows}</ul>` +
    `<h2>From the endpoints, now</h2><p><span class="mono">${esc(e.agreed.root)}</span> at block ${e.agreed.block.toLocaleString('en-US')}, from ${esc(e.agreed.sources.join(', '))}.</p>` +
    `<p>A version opened by its fixed address is checked file by file against that root, whichever you choose.</p>` +
    (checkUrl(target) ? `<p><a href="${esc(checkUrl(target))}">Run the check again on the check page</a></p>` : '') +
    `<p><a href="${OWN}info.html">What this viewer read and checked, and how to reset it</a></p></main>`,
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP } },
  );
}

/* ── a token's own page ──────────────────────────────────────────────────── */

// For a contract with no ABX FS root, the token's page is what tokenURI returns: an HTML page or an image held
// in the metadata. tokenURI is computed by the contract, so this rests on the endpoints agreeing at one block
// (site/token.js). The check page says what stands behind it.
let tokenMemo = null; // { at, value: Promise<{ read, sources, block, hash }> }
function tokenPage(block) {
  if (tokenMemo && Date.now() - tokenMemo.at < HEAD_TTL_MS) return tokenMemo.value;
  const value = (async () => {
    // tokenURI first: when the contract itself returns a page or an image, that is the token's page.
    let page = null, why = null;
    try {
      const got = await agreedTokenUri({ urls: chain.rpcs, org: target.org, token: target.token, block });
      page = { read: readTokenUri(got.bytes), sources: got.sources, block: got.block, hash: got.hash, call: got.call, reply: got.reply };
    } catch (e) { if (e.kind !== 'rpc') throw e; why = e; }
    if (page && page.read.kind === 'page') return page;
    // Otherwise a code project's page is the document ABX's generator contract builds for it.
    const made = await generatorPage({ chainId: chain.id, urls: chain.rpcs, more: PROOF_ENDPOINTS[chain.id] || [], org: target.org, token: target.token, block }).catch((e) => { if (e.kind !== 'rpc') throw e; return null; });
    if (made && made.kind === 'page') return { read: made, sources: made.sources, block, hash: made.hash, call: made.call, reply: made.reply };
    if (made && made.kind === 'unread') return { read: made, sources: [], block, hash: '' };
    if (page) return made && made.kind === 'offchain' && page.read.kind !== 'offchain' ? { ...page, read: made } : page;
    if (made && made.kind === 'offchain') return { read: made, sources: [], block, hash: '' };
    throw why;
  })();
  tokenMemo = { at: Date.now(), value };
  value.catch(() => { if (tokenMemo && tokenMemo.value === value) tokenMemo = null; });
  return value;
}
// The page is served as the endpoints agree on it, at once. Behind it, where this chain has a light client, the
// contract's call is run here over state read by proof at the finalized block (site/evm-state.js) and compared
// with what the endpoints return at that block. If this viewer and an endpoint give different replies, the next
// load of the page is a warning with both, and a way through: nothing here can tell which side is wrong.
// `deps` lets tests/recheck.mjs supply made-up answers.
let recheckMemo = null; // { hash, value: Promise<verdict>, verdict }
let tokenDiffers = null; // { hash, verdict, found, nonce }
const through = new Set(); // replies the reader chose to open after the warning
async function computeToken(page) {
  const urls = PROOF_ENDPOINTS[chain.id];
  const fin = await finalizedBlock({ chainId: chain.id, checkpoint: CHECKPOINTS[chain.id].root, beacons: BEACONS[chain.id] });
  const computed = await computedAt({ chainId: chain.id, fin, urls, ...page.call });
  const atFinalized = computed.done ? await repliesAt({ urls: [...urls, ...chain.rpcs], ...page.call, blockHash: fin.executionBlockHash }) : [];
  return { computed, atFinalized };
}
async function recheck(page, deps = { allowed: proofAllowed, compute: computeToken }) {
  if (!chain || !CHECKPOINTS[chain.id] || !PROOF_ENDPOINTS[chain.id] || !page.call) return { state: 'agreed', reason: `no light client for ${chain ? chain.name : 'this chain'}` };
  if (!await deps.allowed()) return { state: 'agreed', reason: 'proving is switched off on this host' };
  const found = await deps.compute(page);
  const verdict = judgeComputed({ ...found, headReply: page.reply, headBlock: page.block });
  if (verdict.state === 'differs') tokenDiffers = { hash: page.hash, verdict, found, nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('') };
  return verdict;
}
let keepAlive = () => {}; // set for each request: the worker is kept running while a recheck is under way
function recheckLater(page) {
  if (recheckMemo && recheckMemo.hash === page.hash) return recheckMemo;
  const memo = { hash: page.hash, verdict: null };
  memo.value = recheck(page).catch((e) => ({ state: 'agreed', reason: `the page was not recomputed: ${e.message || e}` })).then((v) => { memo.verdict = v; return v; });
  keepAlive(memo.value);
  recheckMemo = memo;
  return memo;
}
// What stands between a reader and a token page this viewer computes differently: both replies, and a way on.
function differsPage(request, page) {
  const { verdict, found, nonce } = tokenDiffers;
  if (request.mode !== 'navigate') return new Response(`This viewer and an endpoint compute different pages: ${verdict.reason}`, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  const mine = found.computed.success ? `0x${Array.from(keccak256(new TextEncoder().encode(found.computed.output)), (b) => b.toString(16).padStart(2, '0')).join('')}` : 'the call fails';
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>This viewer and an endpoint compute different pages</title><link rel="stylesheet" href="${OWN}view.css">` +
    `<main><h1>This viewer and an endpoint compute different pages</h1>` +
    `<p>This token's page is computed by its contract. The page was read from public endpoints, and this viewer also ran the contract's code itself, over the state of block ${found.computed.block.number.toLocaleString('en-US')} of ${esc(chain.name)} read by proof. The two do not give the same reply. Either an endpoint or this viewer's own code is wrong, and nothing here can tell which.</p>` +
    `<h2>Computed here</h2><p><span class="mono">${esc(mine)}</span></p>` +
    `<h2>From the endpoints</h2><p><span class="mono">${esc(page.hash)}</span> at block ${page.block.toLocaleString('en-US')}, from ${esc(page.sources.join(', '))}. ${esc(verdict.reason.charAt(0).toUpperCase() + verdict.reason.slice(1))}.</p>` +
    `<p><a href="/?abxfs-open=${nonce}">Open the page the endpoints returned</a></p>` +
    (checkUrl(target) ? `<p><a href="${esc(checkUrl(target))}">Run the check again on the check page</a></p>` : '') +
    `<p><a href="${OWN}info.html">What this viewer read and checked, and how to reset it</a></p></main>`,
    { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP } },
  );
}
// What a request for the token's page gets before the page itself: the warning, the way through, or nothing.
// The way through is a link only the warning page holds: its address carries a number made for this warning.
function tokenGate(request, page) {
  if (!tokenDiffers || tokenDiffers.hash !== page.hash || through.has(page.hash)) return null;
  if (new URL(request.url).searchParams.get('abxfs-open') !== tokenDiffers.nonce) return differsPage(request, page);
  through.add(page.hash);
  return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
}
const TEXT_TYPES = new Set(['text/html', 'image/svg+xml']);
async function tokenAnswer(request, block, nothing) {
  let page;
  try { page = await tokenPage(block); } catch (e) {
    // The contract has no tokenURI either, or the endpoints do not agree on it.
    if (e.kind === 'rpc') return problem(request, 404, 'Nothing here', nothing.message);
    return problem(request, 502, 'The chain’s answer did not check out', e.message || String(e));
  }
  const { read } = page;
  if (read.kind === 'unread') return problem(request, 502, 'Could not reach the chain', read.why);
  if (read.kind === 'offchain') return problem(request, 404, 'This token’s artwork is not on chain', `The contract's tokenURI says its ${read.what} is at ${read.where}. This viewer shows only what is read from the chain.`);
  if (read.kind !== 'page') return problem(request, 404, 'Nothing here', `This project has nothing published in ABX FS, and its tokenURI holds nothing this viewer shows: ${read.why}.`);
  let path;
  try { path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, ''); } catch { path = '?'; }
  if (path !== '' && path !== 'index.html') return problem(request, 404, 'Not in this token', 'This token has one page, at the address with nothing after the hostname.');
  const gate = tokenGate(request, page);
  if (gate) return gate;
  const checked = recheckLater(page);
  return withRange(request, read.bytes, {
    'x-abxfs-recomputed': checked.verdict ? checked.verdict.state : 'running',
    'content-type': TEXT_TYPES.has(read.mime) ? `${read.mime}; charset=utf-8` : read.mime,
    'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'origin-agent-cluster': '?1',
    'x-abxfs-reply': page.hash, 'x-abxfs-from': read.field === 'generator' ? 'the generator contract\'s document' : `tokenURI ${read.field}`, 'x-abxfs-agreed': `${page.sources.join(', ')} at block ${page.block}`,
  });
}

const WHY = {
  rpc: [502, 'Could not reach the chain'],
  check: [502, 'The chain’s answer did not check out'],
  notfound: [404, 'Nothing here'],
  toolarge: [502, 'Too large to show here'],
  unsupported: [502, 'This viewer cannot read it'],
};

async function rootFor(event) {
  if (event.request.mode === 'navigate') {
    const root = await currentRoot();
    if (event.resultingClientId) await pin(event.resultingClientId, root);
    else lastNavRoot = root;
    return root;
  }
  return await pinned(event.clientId) || lastNavRoot || currentRoot();
}

async function answer(event) {
  const { request } = event;
  const url = new URL(request.url);
  try {
    const root = await rootFor(event);
    const tree = await treeOf(root);
    let path;
    try { path = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return problem(request, 400, 'Not a valid address', url.pathname); }
    if (tree.kind === 'directory') {
      if (path === '' || path.endsWith('/')) path += 'index.html';
      else if (tree.dirs.has(path)) {
        // Built from the cleaned path, so "//name" can never become a redirect to another host.
        const to = new URL('/' + path.split('/').map(encodeURIComponent).join('/') + '/' + url.search, self.location.origin);
        return new Response(null, { status: 302, headers: { location: to.href, 'cache-control': 'no-store' } });
      }
    }
    const found = tree.files.get(path);
    const entry = found || tree.files.get('404.html');
    if (!entry) return problem(request, 404, 'Not in this project', `There is no ${path || 'such path'} under root ${root}.`);
    const body = await contentOf(entry.cid, entry.info);
    const headers = {
      'content-type': safeMime(entry.info.mime),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'origin-agent-cluster': '?1',
      'x-abxfs-root': root,
      'x-abxfs-file': entry.cid,
    };
    if (head && head.stale && target.kind === 'project') headers['x-abxfs-version'] = 'read earlier; the endpoints cannot be reached now';
    if (!found) return new Response(request.method === 'HEAD' ? null : body, { status: 404, headers });
    return withRange(request, body, { ...headers, 'accept-ranges': 'bytes' });
  } catch (e) {
    if (e.kind === 'mismatch') return mismatchPage(request, e);
    if (e.kind === 'notfound' && e.block !== undefined && target.kind === 'project') return tokenAnswer(request, e.block, e);
    const [status, title] = WHY[e.kind] || [500, 'The viewer failed'];
    return problem(request, status, title, e.message || String(e));
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(OWN)) {
    // The worker script and its imports are fetched by the browser itself and never pass through here.
    if (request.method === 'GET' && !url.pathname.startsWith(`${OWN}store/`)) event.respondWith(ownFile(request));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return void event.respondWith(new Response(null, { status: 405 }));
  if (!target || !chain) return; // the start page explains
  keepAlive = (work) => event.waitUntil(work);
  event.respondWith(settingLoaded.then(() => answer(event)));
});

// The info page asks what this worker is showing and what it has checked.
self.addEventListener('message', (event) => {
  if (!event.data || !event.ports[0]) return;
  // Only the viewer's own pages are answered. A project's scripts share this origin and can still drive one of
  // those pages, so nothing here is treated as proof of who is asking: see the note on the endpoint setting.
  let from = '';
  try { from = new URL(event.source.url).pathname; } catch { /* no client */ }
  if (!from.startsWith(OWN)) return;
  if (event.data.type === 'abxfs-endpoint') return void event.waitUntil(setEndpoint(event.data.value).then((r) => event.ports[0].postMessage(r)));
  if (event.data.type !== 'abxfs-info') return;
  event.waitUntil((async () => {
    await settingLoaded;
    const out = {
      target, build: BUILD, files: FILES, custom: custom && host(custom), check: target && target.kind === 'project' ? checkUrl(target) : null,
      chain: chain && { name: chain.name, id: chain.id, endpoints: chain.rpcs.map(host) },
    };
    try {
      if (!target || !chain) throw new Error('this address does not name a project or a root this viewer reads');
      const root = await currentRoot();
      const tree = await treeOf(root);
      out.root = root;
      out.kind = tree.kind;
      out.unnamed = tree.unnamed;
      out.project = [...tree.files].map(([path, f]) => ({
        path, cid: f.cid, size: f.info.size, mime: f.info.mime, codec: f.info.codecName, checked: bodies.has(f.cid),
      }));
    } catch (e) {
      out.error = e.message || String(e);
    }
    out.head = head;
    // Does the host serve, right now, the files this worker was built with?
    out.host = await Promise.all(Object.keys(FILES).map((path) => fromHost(path).then((r) => [path, r.same ? 'same' : 'differs'], () => [path, 'unreachable'])));
    event.ports[0].postMessage(out);
  })());
});

// The info page sets or clears the reader's own endpoint. It is saved only after it has answered for this chain.
async function setEndpoint(value) {
  await settingLoaded;
  try {
    if (value === null) {
      await (await store()).delete(SETTING);
      custom = null;
    } else {
      const next = validEndpoint(value);
      if (!next) return { error: 'An endpoint is an https:// address with no user name or password in it, or http:// on localhost for a node on this computer.' };
      if (!chain) return { error: 'This address does not name a chain this viewer reads.' };
      chainOk.delete(next);
      await onChain(next);
      await (await store()).put(SETTING, new Response(next));
      custom = next;
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// For tests/head-rule.mjs and tests/settle.mjs, which run these rules against made-up answers.
const standingMismatch = () => (lateMismatch && Date.now() - lateMismatch.at < PROOF_TTL_MS ? lateMismatch.error : null);
export { askHead, proofAllowed, recheck, settle, standingMismatch, tokenGate };
