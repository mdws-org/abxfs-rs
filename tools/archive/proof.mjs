// The binding proof for an archive bundle (archive/ARCHIVE.md section 6): every account, storage word, code and
// log the from-chain viewer's own rules read to establish a project's root, recorded as the bundle carries them.
// The viewer's modules do the reading and checking (site/proved.js, site/base.js, site/arbitrum.js); this file only
// records what they were given.
//
// usage: node tools/archive/proof.mjs <chain id> <org> <token> <abxfs.cid|bamfs.cid> <ethereum|final|claimed|confirmed|agreed> <out.json>
// Prints the root the proof establishes. Exit 1 when the proof cannot be made.
import { writeFileSync } from 'node:fs';
import { BEACONS, CHECKPOINTS } from '../../site/checkpoint.js';
import { PROOF_ENDPOINTS, ProvedError, call, finalizedBlock, headerOf, paramSlots } from '../../site/proved.js';
import { accountAt, executionHeader, rlpEncode, storageAt } from '../../site/proof.js';
import { BASE_PROOF_ENDPOINTS, baseClaims } from '../../site/base.js';
import { ROLLUPS, confirmed } from '../../site/arbitrum.js';
import { CHAINS } from '../../site/chain.js';
import { keccak256 } from '../../site/keccak-lookup.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const hash = (...hex) => toHex(keccak256(fromHex(hex.map((h) => h.replace(/^0x/, '')).join(''))));
const KEYS = { 'abxfs.cid': '61627866732e636964'.padEnd(64, '0'), 'bamfs.cid': '62616d66732e636964'.padEnd(64, '0') };
const refuse = (m) => { throw new ProvedError('check', m); };

// A header's RLP, in the field order site/proof.js checks; executionHeader refuses one that does not hash right.
const HEADER = [
  ['parentHash', 32], ['sha3Uncles', 32], ['miner', 20], ['stateRoot', 32], ['transactionsRoot', 32], ['receiptsRoot', 32], ['logsBloom', 256],
  ['difficulty', 'q'], ['number', 'q'], ['gasLimit', 'q'], ['gasUsed', 'q'], ['timestamp', 'q'],
  ['extraData', 'b'], ['mixHash', 32], ['nonce', 8],
  ['baseFeePerGas', 'q'], ['withdrawalsRoot', 32], ['blobGasUsed', 'q'], ['excessBlobGas', 'q'], ['parentBeaconBlockRoot', 32],
  ['requestsHash', 32], ['blockAccessListHash', 32], ['slotNumber', 'q'],
];
function headerRlp(blockHash, block) {
  executionHeader(blockHash, block);
  const fields = [];
  for (const [name, type] of HEADER) {
    const v = block[name];
    if (v === undefined || v === null) break;
    if (type === 'q') { const h = v.slice(2); fields.push(v === '0x0' ? new Uint8Array(0) : fromHex(h.length % 2 ? '0' + h : h)); } else fields.push(fromHex(v));
  }
  const rlp = rlpEncode(fields);
  if (toHex(keccak256(rlp)) !== blockHash.toLowerCase()) refuse('the header does not rebuild to its hash');
  return toHex(rlp);
}

// Account evidence for one list: every proof asked for at one state root, merged per address.
class Evidence {
  constructor() { this.accounts = new Map(); this.codes = new Map(); }
  add(address, accountProof, slots, storageProof) {
    const a = address.toLowerCase();
    if (!this.accounts.has(a)) this.accounts.set(a, { address: a, proof: accountProof.map((x) => x.toLowerCase()), storage: new Map() });
    const e = this.accounts.get(a);
    slots.forEach((s, i) => { if (!e.storage.has(s)) e.storage.set(s, storageProof[i].proof.map((x) => x.toLowerCase())); });
  }
  list() {
    return [...this.accounts.values()].sort((x, y) => (x.address < y.address ? -1 : 1))
      .map((e) => ({ address: e.address, proof: e.proof, storage: [...e.storage].sort(([x], [y]) => (x < y ? -1 : 1)).map(([slot, proof]) => ({ slot, proof })) }));
  }
}

// provedAccount and provedCode as site/proved.js has them, recording each proof into `ev`.
function recording(ev) {
  return {
    async provedAccount({ fin, urls, address, slots = [] }) {
      let last = new ProvedError('rpc', 'no endpoint to ask for a proof');
      for (const url of urls) {
        try {
          const header = await headerOf(url, fin.executionBlockHash);
          const reply = await call(url, 'eth_getProof', [address, slots, '0x' + header.number.toString(16)]);
          if (!reply || !Array.isArray(reply.accountProof) || reply.storageProof?.length !== slots.length) throw new ProvedError('check', 'the endpoint did not return the proofs asked for');
          const block = { number: header.number, hash: fin.executionBlockHash, timestamp: header.timestamp };
          const account = accountAt(header.stateRoot, address, reply.accountProof);
          if (!account) { if (slots.length) refuse(`storage asked of ${address}, which does not exist`); ev.add(address, reply.accountProof, [], []); return { exists: false, block }; }
          const words = slots.map((slot, i) => storageAt(account.storageRoot, slot, reply.storageProof[i].proof));
          ev.add(address, reply.accountProof, slots.map((s) => s.toLowerCase()), reply.storageProof);
          return { exists: true, codeHash: account.codeHash, words, block, via: new URL(url).host };
        } catch (e) { last = e; }
      }
      throw last;
    },
    async provedCode({ urls, address, codeHash, blockNumber }) {
      for (const url of urls) {
        try {
          const code = (await call(url, 'eth_getCode', [address, '0x' + blockNumber.toString(16)])).toLowerCase();
          if (toHex(keccak256(fromHex(code))) !== codeHash) continue;
          ev.codes.set(codeHash, code);
          return code;
        } catch { /* the next endpoint */ }
      }
      throw new ProvedError('rpc', 'no endpoint gave the code');
    },
  };
}

// The collection's parameter at a state root an L2 header gives, recorded into `ev`; returns the root it holds.
async function l2Param({ urls, header, at, org, token, key, ev, extra = [] }) {
  const slots = paramSlots(token, KEYS[key]);
  let last;
  for (const url of urls) {
    try {
      for (const [address, s] of extra) {
        const r = await call(url, 'eth_getProof', [address, s, at]);
        if (!accountAt(header.stateRoot, address, r.accountProof)) refuse(`${address} does not exist at that block`);
        ev.add(address, r.accountProof, s, r.storageProof);
      }
      const r = await call(url, 'eth_getProof', [org, slots, at]);
      const acct = accountAt(header.stateRoot, org, r.accountProof) || refuse('the project contract does not exist at that block');
      const words = slots.map((s, i) => storageAt(acct.storageRoot, s, r.storageProof[i].proof));
      ev.add(org, r.accountProof, slots.map((s) => s.toLowerCase()), r.storageProof);
      return words[0];
    } catch (e) { last = e; }
  }
  throw last;
}

async function l1Header(fin) {
  for (const url of PROOF_ENDPOINTS[1]) {
    try { return headerRlp(fin.executionBlockHash, await call(url, 'eth_getBlockByHash', [fin.executionBlockHash, false])); } catch { /* next */ }
  }
  throw new ProvedError('rpc', 'no endpoint gave the anchor header');
}

// Ethereum's finalized block, from the light client, once for any number of proofs.
const finalized = () => finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });

// { root, proof } for one project and proof kind. `fin` is shared between calls; agreed proofs need none.
async function prove({ chain, org: org0, token, key, kind, fin }) {
  const org = org0.toLowerCase();
  if (!KEYS[key]) refuse(`unknown key ${key}`);
  if (kind === 'agreed') {
    const c = Object.values(CHAINS).find((x) => x.id === chain);
    const data = '0x6bd39222' + BigInt(token).toString(16).padStart(64, '0') + KEYS[key];
    const heights = (await Promise.allSettled(c.rpcs.map(async (u) => ({ u, n: parseInt(await call(u, 'eth_blockNumber', []), 16) })))).filter((x) => x.status === 'fulfilled').map((x) => x.value);
    const block = Math.min(...heights.map((x) => x.n)) - 2;
    const got = (await Promise.allSettled(heights.map(async ({ u }) => [new URL(u).host, (await call(u, 'eth_call', [{ to: org, data }, '0x' + block.toString(16)])).slice(0, 66).toLowerCase()]))).filter((x) => x.status === 'fulfilled').map((x) => x.value);
    if (got.length < 2 || new Set(got.map((g) => g[1])).size !== 1) refuse('fewer than two endpoints agree on the root');
    return { root: got[0][1], proof: { kind: 'agreed', block, endpoints: got.map((g) => g[0]) } };
  }
  fin ||= await finalized();
  const l1 = new Evidence();
  const deps = recording(l1);
  const header = await l1Header(fin);
  if (kind === 'ethereum') {
    if (chain !== 1) refuse('an ethereum proof is for an Ethereum project');
    const slots = paramSlots(token, KEYS[key]);
    const a = await deps.provedAccount({ fin, urls: PROOF_ENDPOINTS[1], address: org, slots });
    if (!a.exists) refuse('the project contract does not exist');
    return { root: a.words[0], proof: { kind: 'ethereum', header, accounts: l1.list() } };
  }
  if (kind === 'final' || kind === 'claimed') {
    if (chain !== 8453) refuse('a base proof is for a Base project');
    const claims = await baseClaims({ fin, urls: PROOF_ENDPOINTS[1], deps });
    const game = kind === 'final' ? claims.anchor : claims.latest || refuse(`no claimed game: ${claims.latestWhy}`);
    const l2 = new Evidence();
    const at = '0x' + game.l2Block.toString(16);
    let l2header, root, last;
    for (const url of BASE_PROOF_ENDPOINTS) {
      try {
        const block = await call(url, 'eth_getBlockByNumber', [at, false]);
        l2header = headerRlp(block.hash, block);
        const hd = executionHeader(block.hash, block);
        root = await l2Param({ urls: [url], header: hd, at, org, token, key, ev: l2, extra: [['0x4200000000000000000000000000000000000016', []]] });
        const passer = l2.accounts.get('0x4200000000000000000000000000000000000016');
        const out = hash('0'.repeat(64), hd.stateRoot, accountAt(hd.stateRoot, '0x4200000000000000000000000000000000000016', passer.proof).storageRoot, block.hash);
        if (out !== game.rootClaim) refuse('the L2 block does not make the claim');
        break;
      } catch (e) { last = e; root = undefined; }
    }
    if (root === undefined) throw last;
    return { root, proof: { kind: 'base', final: kind === 'final', l1: { header, accounts: l1.list(), codes: [...l1.codes.values()].sort() }, game: game.proxy, l2: { header: l2header, accounts: l2.list() } } };
  }
  if (kind === 'confirmed') {
    if (chain !== 42161) refuse('an arbitrum proof is for an Arbitrum One project');
    let logs = [];
    const claim = await confirmed({ fin, urls: PROOF_ENDPOINTS[1], chainId: 42161, deps: { provedAccount: deps.provedAccount, logs: async (q) => (logs = await allLogs(q)) } });
    const log = logs.find((l) => { const d = l.data.slice(2).match(/.{64}/g); return d && hash(l.topics[2], hash(...d.slice(13, 19)), d[19]) === claim.assertion; }) || refuse('no log hashes to the assertion');
    const l2 = new Evidence();
    let l2header, root, last;
    for (const url of ROLLUPS[42161].endpoints) {
      try {
        const block = await call(url, 'eth_getBlockByHash', [claim.blockHash, false]);
        l2header = headerRlp(claim.blockHash, block);
        const hd = executionHeader(claim.blockHash, block);
        root = await l2Param({ urls: [url], header: hd, at: '0x' + hd.number.toString(16), org, token, key, ev: l2 });
        break;
      } catch (e) { last = e; root = undefined; }
    }
    if (root === undefined) throw last;
    return { root, proof: { kind: 'arbitrum', l1: { header, accounts: l1.list() }, log: { parent: log.topics[2].toLowerCase(), data: log.data.toLowerCase() }, l2: { header: l2header, accounts: l2.list() } } };
  }
  refuse(`unknown kind ${kind}`);
}

// The AssertionCreated logs of one block, from every Ethereum endpoint that answers (as site/arbitrum.js asks).
async function allLogs({ urls, address, block, assertion }) {
  const at = '0x' + block.toString(16);
  const all = await Promise.allSettled(urls.map((url) => call(url, 'eth_getLogs', [{ address, fromBlock: at, toBlock: at, topics: [null, assertion] }], 6_000)));
  return all.filter((a) => a.status === 'fulfilled' && Array.isArray(a.value)).flatMap((a) => a.value.slice(0, 64));
}

export { KEYS, finalized, prove };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [chain, org, token, key, kind, out] = process.argv.slice(2);
  if (!KEYS[key] || !out) { console.error('usage: proof.mjs <chain id> <org> <token> <abxfs.cid|bamfs.cid> <ethereum|final|claimed|confirmed|agreed> <out.json>'); process.exit(2); }
  try {
    const { root, proof } = await prove({ chain: Number(chain), org, token, key, kind });
    writeFileSync(out, JSON.stringify(proof));
    console.log(root);
  } catch (e) {
    console.error(`no proof: ${e.message}`);
    process.exit(1);
  }
}
