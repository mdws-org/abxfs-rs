// The daily archive run (archive/ARCHIVE.md): find every version of every ABX FS and BAMFS project on Ethereum,
// Base and Arbitrum One, and make each version the bundles it lacks, at the strongest proof that reaches it.
//
//   versions  the root each token holds now, as two public endpoints agree on it; and every root a collection has
//             ever emitted as a new value of its abxfs.cid or bamfs.cid parameter (its logs, read from Blockscout).
//   bundles   Ethereum: one proved at a finalized block. Base: one under the final claim, and until that exists one
//             under the newest claim. Arbitrum One: one under the confirmed assertion. A version no proof reaches
//             gets one bundle that says so: `agreed` while it is current, `logged` once it has been replaced.
//
// State is kept in <dir>/state.json; bundles are written to <dir>/bundles/<index cid>.car; the manifest (section 13)
// to <dir>/manifest.json. Prints one JSON line: { made: [{ file, index, bytes, proof }], versions, failed: [...] }.
//
// usage: node tools/archive/daily.mjs <dir> [--only <chain>-<org>-<token>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, finalized, prove } from './proof.mjs';
import { CHAINS } from '../../site/chain.js';

const DIR = process.argv[2];
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const BIN = new URL('../../target/release/abxfs-rs', import.meta.url).pathname;
const CONTRACTS = 'https://abx.thebenmeadows.com/contracts.json';
const TOPIC = '0xde0436cfd14f6250e38daf8e3605d7a54612abb0d9a1ac04278609edb949cd78';
const RPCS = { 1: CHAINS.ethereum.rpcs, 8453: CHAINS.base.rpcs, 42161: CHAINS['arbitrum-one'].rpcs };
const KEY_OF = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => ['0x' + v, k]));
const MAX_TOKENS = 1200;

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const today = () => new Date().toISOString().slice(0, 10);
async function post(url, body, ms = 20_000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

// The root every token of a collection holds now, under both keys, where two endpoints agree at one block.
async function currentRoots(c) {
  const rpcs = RPCS[c.chainId];
  let heights = [];
  for (let attempt = 0; attempt < 4 && heights.length < 2; attempt++) {
    if (attempt) await sleep(3000 * attempt);
    heights = (await Promise.allSettled(rpcs.map(async (u) => [u, parseInt((await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).result, 16)])))
      .filter((x) => x.status === 'fulfilled' && Number.isFinite(x.value[1])).map((x) => x.value);
  }
  if (heights.length < 2) throw new Error(`fewer than two endpoints answer for chain ${c.chainId}`);
  const block = Math.min(...heights.map((h) => h[1])) - 3;
  const minted = Number.isFinite(Number(c.sale?.minted)) ? Number(c.sale.minted) : 0;
  const n = Math.min(Math.max(minted + 2, 3), MAX_TOKENS);
  const out = [];
  // Tokens past the cap are found only through the collection's logs: say so, so that it is not silent.
  out.capped = minted + 2 > MAX_TOKENS;
  for (const [key, k] of Object.entries(KEYS)) {
    for (let s = 0; s < n; s += 20) {
      const toks = Array.from({ length: Math.min(20, n - s) }, (_, i) => s + i);
      const calls = toks.map((t, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.address, data: '0x6bd39222' + word(t) + k }, '0x' + block.toString(16)] }));
      const value = (r) => (r?.result && r.result.length >= 66 ? r.result.slice(0, 66).toLowerCase() : r?.error && /revert/i.test(r.error.message || '') ? '0x' + '0'.repeat(64) : null);
      // Each endpoint's reply to the batch, by host; null for an endpoint that refused or broke the batch.
      const replies = await Promise.all(heights.map(async ([u]) => {
        const r = await post(u, calls, 30_000).catch(() => null);
        return [new URL(u).host, Array.isArray(r) ? r : null];
      }));
      for (const [i, t] of toks.entries()) {
        // [host, root] from every endpoint whose batch reply answers this token.
        let each = replies.filter(([, r]) => r).map(([host, r]) => [host, value(r.find((x) => x.id === i))]).filter((e) => e[1]);
        // An endpoint may refuse a whole batch or some of its items (a rate limit): those are asked one at a time.
        for (let attempt = 0; attempt < 3 && each.length < 2; attempt++) {
          await sleep(1500 * (attempt + 1));
          each = (await Promise.all(heights.map(async ([u]) => [new URL(u).host, value(await post(u, { ...calls[i], id: 1 }).catch(() => null))]))).filter((e) => e[1]);
        }
        // The endpoints an `agreed` proof names are the ones that gave this answer.
        const got = each.map((e) => e[1]), hosts = each.map((e) => e[0]);
        if (got.length < 2) throw new Error(`fewer than two endpoints answered for ${c.address} token ${t}`);
        if (new Set(got).size > 1) throw new Error(`the endpoints disagree about ${c.address} token ${t} ${key}`);
        if (!/^0x0+$/.test(got[0])) out.push({ token: String(t), key, root: got[0], block, endpoints: hosts });
      }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Public endpoints that serve old logs for a list of addresses, and the widest span each allows (measured 2026-11-13;
// Ethereum's free endpoints refuse logs that old, so its logs come from Blockscout's v2 API, address by address).
const LOG_RPCS = { 8453: ['https://base-rpc.publicnode.com', 50_000], 42161: ['https://arb1.arbitrum.io/rpc', 100_000] };
const BLOCKSCOUT_V2 = 'https://eth.blockscout.com/api/v2';

function decodeLog(l) {
  const key = KEY_OF[l.topics?.[2]?.toLowerCase()];
  const root = '0x' + (l.data || '').replace(/^0x/, '').slice(0, 64).toLowerCase();
  if (!key || root.length !== 66 || /^0x0+$/.test(root)) return null;
  return { org: (l.address?.hash || l.address).toLowerCase(), token: BigInt(l.topics[1]).toString(), key, root, block: Number(l.block_number ?? parseInt(l.blockNumber, 16)), tx: (l.transaction_hash || l.transactionHash).toLowerCase() };
}

// The parameter-change logs of `addresses` (address -> first block not yet read) on one chain, up to `head`.
async function loggedRoots(chainId, addresses, head) {
  const out = [];
  if (chainId === 1) {
    for (const a of Object.keys(addresses)) {
      let params = '';
      let done = false;
      for (let page = 0; !done; page++) {
        if (page >= 400) throw new Error(`Blockscout has more than 400 pages of logs for ${a}`);
        let r;
        for (let attempt = 0; attempt < 4; attempt++) {
          r = await fetch(`${BLOCKSCOUT_V2}/addresses/${a}/logs${params}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
          if (r?.ok) break;
          await sleep(5000 * (attempt + 1));
        }
        if (!r?.ok) throw new Error(`Blockscout answered ${r ? r.status : 'nothing'} for ${a}`);
        const j = await r.json();
        for (const l of j.items || []) {
          if ((l.topics?.[0] || '').toLowerCase() !== TOPIC || Number(l.block_number) < addresses[a]) continue;
          const d = decodeLog({ ...l, address: a });
          if (d) out.push(d);
        }
        if (!Array.isArray(j.items)) throw new Error(`Blockscout gave no list of logs for ${a}`);
        // Logs come newest first: a page that ends before the first block wanted is the last one needed.
        const oldest = j.items.length ? Number(j.items[j.items.length - 1].block_number) : 0;
        if (!j.next_page_params || oldest < addresses[a]) { done = true; break; }
        params = '?' + new URLSearchParams(j.next_page_params);
        await sleep(400);
      }
    }
    return out;
  }
  const [url, widest] = LOG_RPCS[chainId];
  const list = Object.entries(addresses).sort((x, y) => x[1] - y[1]);
  for (let g = 0; g < list.length; g += 10) {
    const group = list.slice(g, g + 10);
    let from = group[0][1], span = widest;
    while (from <= head) {
      const to = Math.min(head, from + span - 1);
      let r;
      try { r = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: group.map((x) => x[0]), topics: [TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] }, 60_000); } catch (e) { r = { error: { message: e.message } }; }
      if (r.error) {
        if (span > 1_000) { span = Math.floor(span / 2); continue; }
        throw new Error(`logs of chain ${chainId} at ${from}: ${(r.error.message || '').slice(0, 120)}`);
      }
      for (const l of r.result) { const d = decodeLog(l); if (d && d.block >= addresses[d.org]) out.push(d); }
      from = to + 1;
      await sleep(150);
    }
  }
  return out;
}

function load() {
  const f = join(DIR, 'state.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { versions: {}, logsFrom: {} };
}
function save(state) {
  const f = join(DIR, 'state.json');
  writeFileSync(f + '.tmp', JSON.stringify(state, null, 1));
  renameSync(f + '.tmp', f);
}
const vkey = (chain, org, token, key, root) => `${chain}-${org}-${token}-${key}-${root}`;

function bundle(v, kind, proof) {
  const p = join(DIR, 'proof.tmp.json');
  writeFileSync(p, JSON.stringify(proof));
  const tmp = join(DIR, 'bundle.tmp.car');
  // `bundle` verifies what it writes; the separate verify-bundle run is the check the archive relies on.
  execFileSync(BIN, ['bundle', `${v.project.chain}-${v.project.org.slice(2)}-${v.project.token}`, '--key', v.project.key, '--root', v.root, '--proof', p, '--out', tmp], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 26 });
  const listing = execFileSync(BIN, ['verify-bundle', tmp], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const index = cidOf(tmp);
  const file = join(DIR, 'bundles', `${index}.car`);
  renameSync(tmp, file);
  const anchor = (listing.match(/^anchor (\d+) /m) || [])[1];
  return { index, file, bytes: statSync(file).size, proof: kind, anchor: anchor ? Number(anchor) : null, made: today() };
}

// The index CID of a bundle file: its header holds it (bytes 14..51 of the file).
function cidOf(file) {
  const b = readFileSync(file);
  const cid = b.subarray(14, 51);
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = 'b', acc = 0, bits = 0;
  for (const x of cid) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; s += A[(acc >> bits) & 31]; } acc &= (1 << bits) - 1; }
  if (bits) s += A[(acc << (5 - bits)) & 31];
  return s;
}

const KIND_NAME = { ethereum: 'ethereum', final: 'base final', claimed: 'base claimed', confirmed: 'arbitrum', agreed: 'agreed', logged: 'logged' };

async function main() {
  mkdirSync(join(DIR, 'bundles'), { recursive: true });
  // One run at a time: two would share the temporary files and the state.
  const lock = join(DIR, 'lock');
  try { mkdirSync(lock); } catch {
    if (Date.now() - statSync(lock).mtimeMs < 6 * 3600_000) { console.log(JSON.stringify({ made: [], versions: 0, failed: ['another run holds the lock'] })); return; }
  }
  try { await run(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function run() {
  const state = load();
  const failed = [], made = [];
  const contracts = (await fetch(CONTRACTS).then((r) => r.json())).contracts.filter((c) => RPCS[c.chainId] && /^0x[0-9a-fA-F]{40}$/.test(c.address) && Number.isSafeInteger(c.block))
    .filter((c) => !ONLY || ONLY.startsWith(`${c.chainId}-${c.address.slice(2).toLowerCase()}-`));
  const note = (chain, org, token, key, root, seen) => {
    const k = vkey(chain, org, token, key, root);
    state.versions[k] ||= { project: { chain, org, token, key }, root, seen, bundles: [] };
    const cur = state.versions[k].seen;
    // The earliest block known, and the first day the archive saw the version current (a log has no such day).
    state.versions[k].seen = { block: Math.min(cur.block, seen.block), date: cur.date ?? seen.date };
    return state.versions[k];
  };
  // Versions now current.
  const current = new Map();
  for (const c of contracts) {
    try {
      const roots = await currentRoots(c);
      if (roots.capped) failed.push(`${c.chainId} ${c.address}: only its first ${MAX_TOKENS} tokens are read for current roots; later ones are found from its logs`);
      for (const r of roots) {
        const v = note(c.chainId, c.address.toLowerCase(), r.token, r.key, r.root, { block: r.block, date: today() });
        current.set(`${c.chainId}-${c.address.toLowerCase()}-${r.token}-${r.key}`, { v, agreed: { kind: 'agreed', block: r.block, endpoints: r.endpoints } });
      }
    } catch (e) { failed.push(`${c.chainId} ${c.address}: ${e.message}`); }
  }
  // Versions ever emitted: each collection's logs from the block after the last one read (its deploy block at first).
  for (const chain of [1, 8453, 42161]) {
    const mine = contracts.filter((c) => c.chainId === chain);
    if (!mine.length) continue;
    try {
      const head = Math.min(...(await Promise.all(RPCS[chain].slice(0, 1).map(async (u) => parseInt((await post(u, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).result, 16))))) - 3;
      const addresses = Object.fromEntries(mine.map((c) => [c.address.toLowerCase(), state.logsFrom[`${chain}:${c.address.toLowerCase()}`] ?? c.block]));
      for (const l of await loggedRoots(chain, addresses, head)) {
        const v = note(chain, l.org, l.token, l.key, l.root, { block: l.block, date: null });
        v.log ||= { block: l.block, tx: l.tx };
      }
      for (const a of Object.keys(addresses)) state.logsFrom[`${chain}:${a}`] = head + 1;
    } catch (e) { failed.push(`logs of chain ${chain}: ${e.message}`); }
  }
  save(state);

  // Bundles: per project, each proof kind is gathered once and serves whichever version it reaches.
  let fin = null;
  const projects = new Map();
  for (const v of Object.values(state.versions)) {
    const p = `${v.project.chain}-${v.project.org}-${v.project.token}-${v.project.key}`;
    if (!projects.has(p)) projects.set(p, []);
    projects.get(p).push(v);
  }
  for (const [p, versions] of projects) {
    const { chain, org, token, key } = versions[0].project;
    const kinds = chain === 1 ? ['ethereum'] : chain === 8453 ? ['final', 'claimed'] : ['confirmed'];
    for (const kind of kinds) {
      const lacking = versions.filter((v) => !v.bundles.some((b) => b.proof === KIND_NAME[kind] || (kind === 'claimed' && b.proof === 'base final')));
      if (!lacking.length) continue;
      try {
        fin ||= await finalized();
        let got;
        for (let attempt = 0; ; attempt++) {
          try { got = await prove({ chain, org, token, key, kind, fin }); break; } catch (e) {
            if (/does not exist at that block|does not exist$/.test(e.message)) { got = null; break; }
            if (attempt >= 1) throw e;
            await sleep(10_000);
          }
        }
        if (!got) continue;
        const { root, proof } = got;
        const v = lacking.find((x) => x.root === root);
        if (!v) continue;
        const b = bundle(v, KIND_NAME[kind], proof);
        v.bundles.push(b); made.push(b); save(state);
      } catch (e) { failed.push(`${p} ${kind}: ${e.message.slice(0, 200)}`); }
    }
    // A version no proof reached gets one bundle that says what it rests on.
    for (const v of versions.filter((x) => !x.bundles.length)) {
      const now = current.get(p);
      try {
        let b;
        if (now && now.v === v) b = bundle(v, 'agreed', now.agreed);
        else if (v.log) b = bundle(v, 'logged', { kind: 'logged', block: v.log.block, tx: v.log.tx });
        else continue;
        v.bundles.push(b); made.push(b); save(state);
      } catch (e) { failed.push(`${p} ${v.root.slice(0, 10)} unproved: ${e.message.slice(0, 200)}`); }
    }
  }
  writeFileSync(join(DIR, 'manifest.json'), manifest(state));
  console.log(JSON.stringify({ made, versions: Object.keys(state.versions).length, failed }));
}

// Section 13, in the index's canonical form.
function manifest(state) {
  const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
  const versions = Object.values(state.versions).filter((v) => v.bundles.length)
    .sort((a, b) => a.project.chain - b.project.chain || a.project.org.localeCompare(b.project.org) || (BigInt(a.project.token) > BigInt(b.project.token)) - (BigInt(a.project.token) < BigInt(b.project.token)) || a.project.key.localeCompare(b.project.key) || a.seen.block - b.seen.block)
    .map((v) => ({ project: v.project, root: v.root, seen: v.seen, bundles: v.bundles.map((b) => ({ bundle: { '/': b.index }, proof: b.proof, anchor: b.anchor, bytes: b.bytes })) }));
  return canon({ format: 'abx-archive-manifest/1', versions }) + '\n';
}

await main();
