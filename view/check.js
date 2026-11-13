// The check page. It runs on its own hostname (check.<host>), where no project's script can reach it, and
// states what can be said about a project's current root: read by proof, read from the endpoints, and compared.
import { CHAINS, quantity, rpc } from './chain.js';
import { hostLabel, parseHost, viewUrl } from './target.js';
import { BEACONS, CHECKPOINTS } from './checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock, provedTokenParam, tokenParamAt } from './proved.js';
import { judge, judgeComputed, judgeRollup, judgeRollupComputed } from './verdict.js';
import { BASE_PROOF_ENDPOINTS, baseClaims, baseTokenParam } from './base.js';
import { agreedTokenUri, generatorPage, readTokenUri, repliesAt } from './token.js';
import { ROLLUPS as ARBITRUM, confirmed, rollupTokenParam } from './arbitrum.js';
import { BUILD } from './files.js';

const $ = (s) => document.querySelector(s);
const ZERO = '0x' + '0'.repeat(64);
const KEY_ABXFS = '61627866732e636964'.padEnd(64, '0'), KEY_BAMFS = '62616d66732e636964'.padEnd(64, '0'); // "abxfs.cid", "bamfs.cid"
const MAX_LAG = { 1: 10, 11155111: 10, 8453: 60, 42161: 480, 4663: 1200 };
// Rollups whose claims on Ethereum this viewer can read, and the chain those claims are on.
const ROLLUPS = { 8453: { name: 'Base', l1: 1, kind: 'base' }, 42161: { name: 'Arbitrum One', l1: 1, kind: 'arbitrum' }, 4663: { name: 'Robinhood Chain', l1: 1, kind: 'arbitrum' } };
const ago = (seconds) => (seconds < 90 ? `${Math.round(seconds)} seconds` : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : seconds < 172800 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 86400)} days`);
const count = (n) => n.toLocaleString('en-US');

function fact(name, value, mono) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = name;
  dd.textContent = value;
  if (mono) dd.className = 'mono';
  $('#facts').append(dt, dd);
  $('#facts').hidden = false;
}
function say(state, text, reason = '') {
  $('#verdict').dataset.state = state;
  $('#verdict').textContent = text;
  $('#reason').textContent = reason;
}

// The root at least two endpoints agree on now: the same rule the reader uses for what it shows (view/sw.js).
async function agreedHead(chain, target) {
  const ctx = (url) => ({ chain, url, requests: 0, ethCalls: 0, block: 'latest' });
  const settled = (list) => list.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  const up = settled(await Promise.allSettled(chain.rpcs.map(async (url) => {
    if (quantity(await rpc(ctx(url), 'eth_chainId', []), 'the chain id') !== chain.id) throw new Error('another chain');
    return { url, block: quantity(await rpc(ctx(url), 'eth_blockNumber', []), 'the block number') };
  })));
  const sorted = up.map((u) => u.block).sort((x, y) => x - y);
  const middle = sorted[(sorted.length - 1) >> 1];
  const near = up.filter((u) => Math.abs(u.block - middle) <= (MAX_LAG[chain.id] ?? 10));
  if (near.length < 2) throw new Error(`fewer than two endpoints for ${chain.name} are at the same height`);
  const block = Math.min(...near.map((u) => u.block));
  // A contract with no token parameters (an image token) reverts; that is an answer, recorded as the zero root.
  const param = async (key) => {
    const data = '0x6bd39222' + BigInt(target.token).toString(16).padStart(64, '0') + key;
    const got = settled(await Promise.allSettled(near.map(async ({ url }) => {
      let reply;
      try { reply = await rpc(ctx(url), 'eth_call', [{ to: target.org, data }, '0x' + block.toString(16)]); } catch (e) {
        if (/revert/i.test(e.message || '')) return [new URL(url).host, ZERO];
        throw e;
      }
      if (typeof reply !== 'string' || reply.length < 66) throw new Error('tokenParam returned too little');
      return [new URL(url).host, reply.slice(0, 66).toLowerCase()];
    })));
    if (got.length < 2) throw new Error(`fewer than two endpoints answered at block ${block}`);
    if (new Set(got.map(([, root]) => root)).size > 1) throw new Error(`the endpoints disagree about this project's current version at block ${block}: ${got.map(([h, r]) => `${h} gives ${r}`).join(', ')}`);
    return got;
  };
  let got = await param(KEY_ABXFS), key = KEY_ABXFS;
  // No ABX FS root: the project may have been published to BAMFS, whose root is kept under another name.
  if (got[0][1] === ZERO) {
    const older = await param(KEY_BAMFS).catch(() => null);
    if (older && older[0][1] !== ZERO) { got = older; key = KEY_BAMFS; }
  }
  return { root: got[0][1], block, sources: got.map(([h]) => h), key };
}

async function proofSwitch() {
  try { const r = await fetch('/_abxfs/switch.json', { cache: 'no-store' }); return !r.ok || (await r.json()).proof !== false; } catch { return true; }
}

async function run() {
  $('#build').textContent = BUILD;
  const label = decodeURIComponent(location.hash.slice(1));
  const target = label && parseHost(label + '.x');
  if (!target) return say('none', 'No project named.', 'Add a project after the # in this address, as "<chain id>-<org address>-<project number>".');
  const chain = Object.values(CHAINS).find((c) => c.id === target.chainId);
  const openUrl = viewUrl(target);
  if (openUrl) { $('#open-link').href = openUrl; }
  if (target.kind === 'root') {
    $('#title').textContent = `Root ${target.root}`;
    $('#open-link').textContent = 'Open this root';
    $('#open').hidden = !openUrl;
    return say('fixed', 'This address names its root.', 'A root never changes, so there is no current version to establish. Every file shown under it is checked against it.');
  }
  $('#title').textContent = `Project ${target.token} of ${target.org}`;
  if (!chain) return say('none', `This viewer does not read chain ${target.chainId}.`);
  fact('Chain', `${chain.name} (${chain.id})`);
  say('working', `Asking the endpoints for ${chain.name}…`);

  let head;
  try { head = await agreedHead(chain, target); } catch (e) { return say('unreachable', 'The endpoints could not be read.', e.message); }
  fact('Root from the endpoints, now', head.root, true);
  if (head.key === KEY_BAMFS) fact('Published to', 'BAMFS, the file store before ABX FS (the token parameter "bamfs.cid")');
  fact('Agreed by', `${head.sources.join(', ')} at block ${count(head.block)}`);
  if (head.root === ZERO) return token(chain, target, head, openUrl);
  $('#open').hidden = !openUrl;

  if (ROLLUPS[chain.id]) return rollup(chain, target, head);
  const cp = CHECKPOINTS[chain.id];
  if (!cp || !PROOF_ENDPOINTS[chain.id]) return say('agreed', 'Agreed by the endpoints. Not proved.', `This viewer has no light client for ${chain.name}. The root above is what ${head.sources.length} public endpoints agree on, and that is all that stands behind it.`);
  if (!await proofSwitch()) return say('agreed', 'Agreed by the endpoints. Proving is switched off.', 'The operator of this host has switched proving off, which is done when a fault is found in it. The root above is what the endpoints agree on.');

  say('working', 'Following the sync committee to the newest finalized block…');
  let found;
  try {
    const fin = await finalizedBlock({ chainId: chain.id, checkpoint: cp.root, beacons: BEACONS[chain.id] });
    say('working', 'Reading the project\'s root by proof…');
    const proved = await provedTokenParam({ fin, urls: PROOF_ENDPOINTS[chain.id], org: target.org, token: target.token, key: head.key });
    const atFinalized = proved.known ? await tokenParamAt({ urls: [...PROOF_ENDPOINTS[chain.id], ...chain.rpcs], org: target.org, token: target.token, blockHash: proved.block.hash, key: head.key }) : [];
    found = { proved, atFinalized };
  } catch (e) {
    fact('Starting block', `slot ${count(cp.slot)}, ${cp.date}`);
    // An expired starting block is not a passing fault: this copy of the viewer proves nothing until it is updated.
    if (e.kind === 'stale') return say('expired', 'Agreed by the endpoints. This copy of the viewer is too old to prove anything.', `${(e.message || '').replace(/^./, (c) => c.toUpperCase())}. Reload the page to fetch a newer copy; if this message stays, the viewer's host has not been updated.`);
    return say('agreed', 'Agreed by the endpoints. Not proved.', `The proof could not be made: ${e.message || e}`);
  }
  const { proved, atFinalized } = found;
  const v = judge({ proved, atFinalized, agreedHead: head });
  if (proved.known) {
    const age = Date.now() / 1000 - proved.block.timestamp;
    fact('Root by proof', proved.root, true);
    fact('Proved at', `block ${count(proved.block.number)}, finalized, ${ago(age)} old`);
    fact('Block hash', proved.block.hash, true);
    if (proved.shipped) fact('Finality', `this is the viewer's own starting block (beacon slot ${count(proved.finalizedSlot)}); no newer finalized block was offered`);
    else fact('Signed by', `${proved.participants} of 512 sync committee members, over a header that names beacon slot ${count(proved.finalizedSlot)} as finalized`);
    fact('Proof served by', `${proved.via} (checked here; it is not trusted)`);
    fact('Endpoints at that block', atFinalized.length ? atFinalized.map(([h, r]) => `${h}: ${r === proved.root ? 'the same root' : r}`).join('; ') : 'none answered');
  }
  fact('Starting block', `slot ${count(cp.slot)}, ${cp.date}; trusted for 14 days`);
  const texts = {
    proved: 'Proved: this is the project\'s root in a finalized block, the endpoints give the same root at that block, and it is still the current one.',
    newer: 'Agreed by the endpoints, not yet provable: this version was published after the last finalized block.',
    mismatch: 'The proof and the endpoints disagree. One of them is wrong.',
    agreed: 'Agreed by the endpoints. Not proved.',
  };
  if (v.state === 'mismatch') $('#open').hidden = true;
  say(v.state, texts[v.state], v.reason.charAt(0).toUpperCase() + v.reason.slice(1) + '.');
}

// A contract's call, run in a worker (view/evm-worker.js) over state read by proof at the finalized block. The
// worker is ended when a run passes RUN_MS, which no limit inside the run can fail to do, and a new one is started
// for the next call. Returns what computedAt returns, without its state; never throws.
const RUN_MS = 200_000;
let worker = null, runs = 0;
function computedAt(args) {
  return new Promise((resolve) => {
    const id = ++runs;
    let timer = 0;
    const end = (result) => { clearTimeout(timer); if (worker) { worker.removeEventListener('message', heard); worker.removeEventListener('error', failed); } resolve(result); };
    const stop = (why) => { if (worker) worker.terminate(); worker = null; end({ done: false, why }); };
    const heard = (e) => { if (e.data && e.data.id === id) end(e.data.result); };
    const failed = (e) => stop(`the worker that runs the contract's code failed: ${e.message || 'it could not be started'}`);
    try {
      worker ??= new Worker(new URL('./evm-worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', heard);
      worker.addEventListener('error', failed);
      timer = setTimeout(() => stop(`the run was ended after ${RUN_MS / 1000} seconds`), RUN_MS);
      worker.postMessage({ id, ...args });
    } catch (e) { stop(`this browser could not start a worker to run the contract's code: ${e.message || e}`); }
  });
}

// No ABX FS root: what the contract's tokenURI holds, or what ABX's generator contract builds for a code project,
// as the endpoints agree on it.
async function token(chain, target, head, openUrl) {
  $('#open').hidden = true;
  say('working', 'No ABX FS root. Asking the endpoints for the token\'s own page…');
  let got = null, read = { kind: 'none', why: 'fewer than two endpoints returned a tokenURI' };
  try {
    got = await agreedTokenUri({ urls: chain.rpcs, org: target.org, token: target.token, block: head.block });
    read = readTokenUri(got.bytes);
    fact('tokenURI', `${count(got.bytes.length)} bytes, the same from ${got.sources.join(', ')} at block ${count(got.block)}`);
  } catch (e) { if (e.kind === 'check') return say('unreachable', 'The endpoints do not agree on this token.', e.message); }
  if (read.name) fact('Name in the metadata', read.name);
  let sources = got ? got.sources : [], shown = got;
  if (read.kind !== 'page') {
    // A code project: the document the generator contract builds from the script the collection stores.
    let made;
    try { made = await generatorPage({ chainId: chain.id, urls: chain.rpcs, more: PROOF_ENDPOINTS[chain.id] || [], org: target.org, token: target.token, block: head.block }); } catch (e) {
      if (e.kind === 'check') return say('unreachable', 'The endpoints do not agree on this project\'s page.', e.message);
      made = null;
    }
    if (made && made.kind === 'page') {
      fact('Generator document', `${count(made.bytes.length)} bytes, the same from ${made.sources.join(', ')} at block ${count(head.block)}`);
      fact('Libraries', made.complete ? 'every library the page loads is stored on chain' : `${made.unresolved || 'at least one'} library is named by address and loaded from there; the chain does not hold it`);
      read = made; sources = made.sources; shown = made;
    } else if (made && made.kind === 'unread') return say('unreachable', 'The project\'s page could not be read.', made.why.charAt(0).toUpperCase() + made.why.slice(1) + '.');
    else if (made && made.kind === 'offchain' && read.kind !== 'offchain') read = made;
  }
  if (read.kind === 'offchain') return say('offchain', 'This token\'s artwork is not on chain.', `The contract says its ${read.what} is at ${read.where}. This viewer shows only what is read from the chain.`);
  if (read.kind !== 'page') return say('none', 'This project has nothing published.', `It has no ABX FS root, and nothing this viewer shows in its tokenURI or from the generator: ${read.why}.`);
  fact('Shown as', read.field === 'generator' ? `${read.mime}, ${count(read.bytes.length)} bytes, the generator contract's document` : `${read.mime}, ${count(read.bytes.length)} bytes, from the metadata's ${read.field}`);
  $('#open-link').textContent = 'Open the token\'s page';
  $('#open').hidden = !openUrl;
  const how = read.field === 'generator' ? 'This is a code project. Its page is built by ABX\'s generator contract from the script the collection stores, when the contract is asked.' : 'This contract keeps its artwork in tokenURI, which the contract computes when asked.';
  const agreed = `${how} ${sources.length} endpoints return the same reply at block ${count(head.block)}, and the page is exactly what that reply holds.`;
  if (RECOMPUTED_ON.has(chain.id)) return rollupToken(chain, target, head, { read, shown, got, agreed });
  const cp = CHECKPOINTS[chain.id];
  if (!cp || !PROOF_ENDPOINTS[chain.id]) return say('agreed', 'Agreed by the endpoints. Not proved.', `${agreed} No storage proof covers a computed reply, and this viewer has no light client for ${chain.name}.`);
  if (!await proofSwitch()) return say('agreed', 'Agreed by the endpoints. Proving is switched off.', `${agreed} The operator of this host has switched proving off, which is done when a fault is found in it.`);

  // Run the contract's call here, over state read by proof at the finalized block, and compare.
  say('working', 'Following the sync committee to the newest finalized block…');
  let computed, atFinalized = [];
  const supporting = [];
  try {
    const fin = await finalizedBlock({ chainId: chain.id, checkpoint: cp.root, beacons: BEACONS[chain.id] });
    say('working', 'Running the contract\'s code here, over state read by proof…');
    computed = await computedAt({ chainId: chain.id, fin, urls: PROOF_ENDPOINTS[chain.id], ...shown.call });
    if (computed.done && computed.success && read.field === 'generator') {
      // The generator's document is shown because of two other replies: the generator's status for the collection,
      // and a tokenURI that holds no page. Each is held to what the page itself is held to: run here to the reply
      // the endpoints agreed on, and returned by at least two endpoints, and no other, at the finalized block.
      const same = async (c, reply) => {
        const [mine, theirs] = await Promise.all([computedAt({ chainId: chain.id, fin, urls: PROOF_ENDPOINTS[chain.id], ...c }), repliesAt({ urls: [...PROOF_ENDPOINTS[chain.id], ...chain.rpcs], ...c, blockHash: fin.executionBlockHash })]);
        return mine.done && mine.success && mine.output === reply && theirs.length >= 2 && theirs.every(([, r]) => r === reply);
      };
      supporting.push({ ok: await same(shown.status.call, shown.status.reply), why: 'the generator\'s status for this collection, which says the page is built on chain, was not recomputed to the same reply' });
      supporting.push({ ok: Boolean(got) && await same(got.call, got.reply), why: got ? 'the token\'s own tokenURI, which holds no page, was not recomputed to the same reply' : 'the endpoints did not agree on the token\'s own tokenURI, so that it holds no page was not established' });
    }
    if (computed.done) atFinalized = await repliesAt({ urls: [...PROOF_ENDPOINTS[chain.id], ...chain.rpcs], ...shown.call, blockHash: fin.executionBlockHash });
    if (computed.done) {
      fact('Run here at', `block ${count(computed.block.number)}, finalized; signed by ${fin.participants} of 512 sync committee members`);
      fact('State read by proof', `${count(computed.stats.accounts)} accounts, ${count(computed.stats.words)} storage words, ${count(computed.stats.codeBytes)} bytes of contract code, served by ${computed.via} (checked here; not trusted)`);
      fact('Endpoints at that block', atFinalized.length ? atFinalized.map(([h, r]) => `${h}: ${computed.success && r === computed.output ? 'the same reply' : 'another reply'}`).join('; ') : 'none answered');
    }
  } catch (e) {
    if (e.kind === 'stale') return say('expired', 'Agreed by the endpoints. This copy of the viewer is too old to prove anything.', `${agreed} ${(e.message || '').replace(/^./, (c) => c.toUpperCase())}. Reload the page to fetch a newer copy; if this message stays, the viewer's host has not been updated.`);
    computed = { done: false, why: `the finalized block could not be established: ${e.message || e}` };
  }
  fact('Starting block', `slot ${count(cp.slot)}, ${cp.date}; trusted for 14 days`);
  const v = judgeComputed({ computed, atFinalized, headReply: shown.reply, headBlock: head.block, supporting });
  const texts = {
    proved: 'Recomputed here from proved state, and the endpoints give the same.',
    newer: 'Agreed by the endpoints, not yet provable: the page changed after the last finalized block.',
    differs: 'Warning: this viewer and an endpoint compute different pages. One of them is wrong.',
    agreed: 'Agreed by the endpoints. Not proved.',
  };
  const reason = v.reason.charAt(0).toUpperCase() + v.reason.slice(1) + '.';
  say(v.state, texts[v.state], v.state === 'proved' ? `${how} This viewer ran that code itself over the state of a finalized block, each account and storage word read with a Merkle proof. ${reason} The page is exactly what that reply holds.${read.field === 'generator' && !read.complete ? ' It loads at least one library from an address off the chain, and nothing here covers what that address serves.' : ''}` : `${agreed} ${reason}`);
}

// A token page on a rollup: the contract's call is run here over the rollup's state at the block its newest claim
// on Ethereum commits to (Base), or its latest confirmed assertion (Arbitrum One). Endpoints seldom keep that
// block, so the result often cannot be compared, and the label is a weaker one of its own: never "proved".
const RECOMPUTED_ON = new Set([8453, 42161]);
async function rollupToken(chain, target, head, { read, shown, got, agreed }) {
  const { name, l1, kind } = ROLLUPS[chain.id];
  const cp = CHECKPOINTS[l1];
  if (!await proofSwitch()) return say('agreed', 'Agreed by the endpoints. Proving is switched off.', `${agreed} The operator of this host has switched proving off, which is done when a fault is found in it.`);
  say('working', 'Following Ethereum\'s sync committee to a finalized block…');
  let computed = null, atClaim = [], final = true;
  const supporting = [];
  try {
    const fin = await finalizedBlock({ chainId: l1, checkpoint: cp.root, beacons: BEACONS[l1] });
    say('working', `Reading what ${name} has on Ethereum by proof…`);
    let hash, urls, what;
    if (kind === 'base') {
      const claims = await baseClaims({ fin, urls: PROOF_ENDPOINTS[l1] });
      const claim = claims.latest || claims.anchor;
      final = !claims.latest;
      hash = (await baseTokenParam({ claim, org: target.org, token: target.token, key: head.key })).block.hash;
      urls = BASE_PROOF_ENDPOINTS;
      what = `game ${claim.proxy}, ${final ? 'final on Ethereum' : 'the newest claim, not final'}`;
    } else {
      const claim = await confirmed({ fin, urls: PROOF_ENDPOINTS[l1], chainId: chain.id });
      hash = claim.blockHash;
      urls = ARBITRUM[chain.id].endpoints;
      what = `assertion ${claim.assertion}, confirmed on Ethereum`;
    }
    say('working', 'Running the contract\'s code here, over that state…');
    const run = (c) => computedAt({ chainId: chain.id, fin: { executionBlockHash: hash }, urls, ...c });
    computed = await run(shown.call);
    if (computed.done) atClaim = await repliesAt({ urls: [...urls, ...chain.rpcs], ...shown.call, blockHash: hash });
    if (computed.done && computed.success && read.field === 'generator') {
      // As on Ethereum, the two replies the choice of this page rested on are run here too.
      const same = async (c, reply) => { const mine = await run(c); return mine.done && mine.success && mine.output === reply; };
      supporting.push({ ok: await same(shown.status.call, shown.status.reply), why: 'the generator\'s status for this collection, which says the page is built on chain, was not recomputed to the same reply' });
      supporting.push({ ok: Boolean(got) && await same(got.call, got.reply), why: got ? 'the token\'s own tokenURI, which holds no page, was not recomputed to the same reply' : 'the endpoints did not agree on the token\'s own tokenURI, so that it holds no page was not established' });
    }
    if (computed.done) {
      fact('Run here at', `${name} block ${count(computed.block.number)}; ${what}`);
      fact('State read by proof', `${count(computed.stats.accounts)} accounts, ${count(computed.stats.words)} storage words, ${count(computed.stats.codeBytes)} bytes of contract code, served by ${computed.via} (checked here; not trusted)`);
      fact('Endpoints at that block', atClaim.length ? atClaim.map(([h, r]) => `${h}: ${computed.success && r === computed.output ? 'the same reply' : 'another reply'}`).join('; ') : 'none keeps that block');
    }
  } catch (e) {
    if (e.kind === 'stale') return say('expired', 'Agreed by the endpoints. This copy of the viewer is too old to prove anything.', `${agreed} ${(e.message || '').replace(/^./, (c) => c.toUpperCase())}. Reload the page to fetch a newer copy; if this message stays, the viewer's host has not been updated.`);
    computed = { done: false, why: `what ${name} has on Ethereum could not be read by proof: ${e.message || e}` };
  }
  fact('Starting block', `Ethereum slot ${count(cp.slot)}, ${cp.date}; trusted for 14 days`);
  const v = judgeRollupComputed({ computed, atClaim, headReply: shown.reply, supporting });
  const texts = {
    recomputed: `Recomputed here from the state of ${name}'s ${kind === 'base' ? (final ? 'final claim' : 'newest claim') : 'confirmed assertion'} on Ethereum. Not proved.`,
    differs: 'Warning: this viewer and an endpoint compute different pages. One of them is wrong.',
    agreed: 'Agreed by the endpoints. Not proved.',
  };
  const reason = v.reason.charAt(0).toUpperCase() + v.reason.slice(1) + '.';
  say(v.state, texts[v.state], v.state === 'recomputed' ? `This viewer ran the contract's code itself over ${name}'s state at the block that ${kind === 'base' ? 'claim' : 'assertion'} commits to, each account and storage word read with a Merkle proof, and got the reply the page is made from. ${reason} With nothing or little to compare it with, a fault in this viewer's own code would not be caught, so this is not called proved.${final ? '' : ` The claim is not final and can still be challenged.`}${read.field === 'generator' && !read.complete ? ' The page loads at least one library from an address off the chain, and nothing here covers what that address serves.' : ''}` : `${agreed} ${reason}`);
}

// A rollup: which of its claims on Ethereum the current root matches.
async function rollup(chain, target, head) {
  const { name, l1, kind } = ROLLUPS[chain.id];
  const cp = CHECKPOINTS[l1];
  if (!await proofSwitch()) return say('agreed', 'Agreed by the endpoints. Proving is switched off.', 'The operator of this host has switched proving off, which is done when a fault is found in it. The root above is what the endpoints agree on.');
  say('working', 'Following Ethereum\'s sync committee to a finalized block…');
  // What the rollup has on Ethereum: `settled` is a claim that is final there, `newest` one that is not (Base only).
  let settled = null, newest = null, anchor = null, latest = null, latestWhy = '', l1Block;
  const unread = (number) => (e) => ({ known: false, why: `the root at ${number} could not be read by proof: ${e.message || e}` });
  try {
    const fin = await finalizedBlock({ chainId: l1, checkpoint: cp.root, beacons: BEACONS[l1] });
    say('working', `Reading what ${name} has on Ethereum by proof…`);
    if (kind === 'base') {
      const claims = await baseClaims({ fin, urls: PROOF_ENDPOINTS[l1] });
      l1Block = claims.l1Block;
      latestWhy = claims.latestWhy || '';
      settled = claims.anchor && { ...claims.anchor, what: `game ${claims.anchor.proxy}` };
      newest = claims.latest && { ...claims.latest, what: `game ${claims.latest.proxy}` };
      say('working', `Reading the project's root on ${name} at the blocks those claims name…`);
      const at = (claim) => (claim ? baseTokenParam({ claim, org: target.org, token: target.token, key: head.key }).catch(unread(`block ${claim.l2Block}`)) : null);
      [anchor, latest] = await Promise.all([at(claims.anchor), at(claims.latest)]);
    } else {
      const claim = await confirmed({ fin, urls: PROOF_ENDPOINTS[l1], chainId: chain.id });
      l1Block = claim.l1Block;
      settled = { ...claim, what: `assertion ${claim.assertion}` };
      say('working', `Reading the project's root on ${name} at the block that assertion commits to…`);
      anchor = await rollupTokenParam({ claim, chainId: chain.id, org: target.org, token: target.token, key: head.key }).catch(unread(`block ${claim.blockHash}`));
    }
  } catch (e) {
    fact('Starting block', `Ethereum slot ${count(cp.slot)}, ${cp.date}`);
    if (e.kind === 'stale') return say('expired', 'Agreed by the endpoints. This copy of the viewer is too old to prove anything.', `${(e.message || '').replace(/^./, (c) => c.toUpperCase())}. Reload the page to fetch a newer copy; if this message stays, the viewer's host has not been updated.`);
    return say('agreed', 'Agreed by the endpoints. Not proved.', `What ${name} has on Ethereum could not be read by proof: ${e.message || e}`);
  }
  const now = Date.now() / 1000;
  const line = (claim, got, what) => {
    if (!claim) return;
    fact(what, `${got && got.block ? `${name} block ${count(got.block.number)}, ${ago(now - got.block.timestamp)} old` : `${name} block ${claim.l2Block ? count(claim.l2Block) : claim.blockHash}`}; ${claim.what}`);
    fact('Root at that block', got && got.known ? got.root : (got && got.why) || 'not read', Boolean(got && got.known));
  };
  line(settled, anchor, 'Final on Ethereum');
  line(newest, latest, 'Newest claim, not final');
  if (!newest && latestWhy) fact('Newest claim', `not counted: ${latestWhy}`);
  fact('Read at', `Ethereum block ${count(l1Block.number)}, finalized`);
  fact('Starting block', `Ethereum slot ${count(cp.slot)}, ${cp.date}; trusted for 14 days`);
  const v = judgeRollup({ anchor, latest, agreedHead: head });
  const texts = {
    settled: `Matches the state ${name} has made final on Ethereum: the endpoints' root is the project's root in that state.`,
    claimed: `Matches ${name}'s newest claim on Ethereum, which is not final. The claim is in a game of the type ${name} uses, its contract has accepted a proof for it, and it can still be challenged.`,
    agreed: 'Agreed by the endpoints. Not covered by any claim on Ethereum yet.',
  };
  // "Not covered yet" is said only when a root was read at a claim and differs; otherwise nothing was proved.
  const read = (anchor && anchor.known) || (latest && latest.known);
  const missed = [anchor, latest].some((c) => c && !c.known);
  say(v.state, v.state === 'agreed' && !read ? 'Agreed by the endpoints. Not proved.' : v.state === 'agreed' && missed ? 'Agreed by the endpoints. One claim on Ethereum could not be read.' : texts[v.state], v.reason.charAt(0).toUpperCase() + v.reason.slice(1) + '.');
}

addEventListener('hashchange', () => location.reload());
run().catch((e) => say('failed', 'The check failed.', e.message || String(e)));
