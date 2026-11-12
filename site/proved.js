// A project's current root, proved: the light client's finalized execution block (site/light.js), that block's
// header and the contract's storage (site/proof.js), and the place in storage where an ABX contract keeps a
// token parameter. No reply from any server is believed until it has been checked against the shipped block root.

import { NETWORKS, sync } from './light.js';
import { accountAt, executionHeader, storageAt } from './proof.js';
import { keccak256 } from './keccak-lookup.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const hash = (...hex) => toHex(keccak256(fromHex('0x' + hex.join(''))));

class ProvedError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// An ABX collection is a 44-byte minimal proxy that can only ever run this implementation, so its storage layout
// cannot change. An account whose code is anything else is not read: its layout is not known here.
const IMPLEMENTATION = '785cd3f74e86e4495c178b5ffcd047c57e699270';
const COLLECTION_CODE_HASH = hash('3d3d3d3d363d3d37363d73', IMPLEMENTATION, '5af43d3d93803e602a57fd5bf3');

// ParamsStorage (ERC-7201 namespace "abx.storage.params") opens with
//   mapping(uint256 tokenId => mapping(bytes32 key => Param)) tokenParams;   Param { bytes32 value; bool valueIsHash; bool isSet; }
// so a token's parameter is at keccak(key . keccak(tokenId . base)), with the two flags packed in the next slot.
const PARAMS_BASE = (() => {
  const namespace = BigInt(toHex(keccak256(new TextEncoder().encode('abx.storage.params')))) - 1n;
  return word(BigInt(hash(word(namespace))) & ~0xffn);
})();
// Public endpoints that serve eth_getProof with CORS at a finalized block (75 to 100 blocks behind the head),
// measured 2026-11-11: the first four reach 130 blocks back, the rest about 128. None is trusted; they are tried
// in turn until one returns a proof that checks. ethereum-rpc.publicnode.com serves proofs only at its head.
const PROOF_ENDPOINTS = {
  1: ['https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io', 'https://api.zan.top/eth-mainnet', 'https://rpc.flashbots.net',
    'https://eth.drpc.org', 'https://0xrpc.io/eth', 'https://eth.blockrazor.xyz', 'https://eth.rpc.blxrbdn.com', 'https://public-eth.nownodes.io'],
  11155111: ['https://0xrpc.io/sep', 'https://ethereum-sepolia-rpc.publicnode.com'],
};
const KEY_CID = '61627866732e636964'.padEnd(64, '0'); // "abxfs.cid"
function paramSlots(token, key = KEY_CID) {
  const value = hash(key, hash(word(token), PARAMS_BASE).slice(2));
  return [value, '0x' + word(BigInt(value) + 1n)];
}

// One JSON-RPC call to one endpoint, with a deadline. Nothing it returns is believed unchecked.
async function call(url, method, params, ms = 15_000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new ProvedError('rpc', `${new URL(url).host} answered ${r.status}`);
  const j = await r.json();
  if (j.error || j.result === undefined) throw new ProvedError('rpc', `${new URL(url).host}: ${(j.error && j.error.message) || 'no result'}`);
  return j.result;
}
const beaconGet = (base) => async (path) => {
  const r = await fetch(base + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new ProvedError('rpc', `${new URL(base).host} answered ${r.status}`);
  return r.json();
};

// The newest finalized execution block, from the shipped block root. Each beacon server is tried in turn; a
// server that is down or wrong is passed over, and a refusal that does not depend on the server (a shipped
// root past its 14 days) ends the search.
async function finalizedBlock({ chainId, checkpoint, beacons, now = Date.now }) {
  const net = NETWORKS[chainId];
  if (!net || !checkpoint || !beacons || !beacons.length) throw new ProvedError('unsupported', 'this viewer has no light client for this chain');
  let last;
  for (const base of beacons) {
    try { return await sync({ net, checkpoint, get: beaconGet(base), now }); } catch (e) {
      if (e.kind === 'stale') throw e;
      last = e;
    }
  }
  throw last;
}

// One token parameter, read by proof at the block `fin` names. `urls` are tried in turn until one returns a
// header and proofs that check.
// Returns { known: false, why } when the account is not an ABX collection (or does not exist), else
// { known: true, root, isSet, valueIsHash, block: { number, hash, timestamp }, finalizedSlot, participants, via }.
async function provedTokenParam({ fin, urls, org, token, key = KEY_CID }) {
  const slots = paramSlots(token, key);
  let last = new ProvedError('rpc', 'no endpoint to ask for a proof');
  for (const url of urls) {
    try {
      const header = executionHeader(fin.executionBlockHash, await call(url, 'eth_getBlockByHash', [fin.executionBlockHash, false]));
      const reply = await call(url, 'eth_getProof', [org, slots, '0x' + header.number.toString(16)]);
      if (!reply || !Array.isArray(reply.accountProof) || !Array.isArray(reply.storageProof) || reply.storageProof.length !== 2) throw new ProvedError('check', 'the endpoint did not return the proofs asked for');
      const at = { block: { number: header.number, hash: fin.executionBlockHash, timestamp: header.timestamp }, finalizedSlot: fin.finalizedSlot, participants: fin.participants, checkpointSlot: fin.checkpointSlot, via: new URL(url).host };
      const account = accountAt(header.stateRoot, org, reply.accountProof);
      if (!account) return { known: false, why: 'there is no contract at this address in the finalized block', ...at };
      if (account.codeHash !== COLLECTION_CODE_HASH) return { known: false, why: 'the contract at this address is not an ABX collection this viewer knows the layout of', ...at };
      const read = (i) => {
        const sp = reply.storageProof[i];
        if (!sp || !Array.isArray(sp.proof)) throw new ProvedError('check', 'a storage proof is missing');
        return storageAt(account.storageRoot, slots[i], sp.proof);
      };
      const root = read(0), flags = BigInt(read(1));
      if (flags >> 16n) throw new ProvedError('check', 'the parameter\'s flags hold more than two flags');
      return { known: true, root, valueIsHash: Boolean(flags & 1n), isSet: Boolean((flags >> 8n) & 1n), ...at };
    } catch (e) { last = e; }
  }
  throw last;
}

// What the endpoints return for tokenParam(token, key) at one block, asked of each `url` at once.
// Returns [[host, root], ...] for those that answered; the caller needs at least two.
const TOKEN_PARAM = '0x6bd39222'; // tokenParam(uint256,bytes32)
async function tokenParamAt({ urls, org, token, block, key = KEY_CID }) {
  const data = TOKEN_PARAM + word(token) + key;
  const all = await Promise.allSettled(urls.map(async (url) => {
    const res = await call(url, 'eth_call', [{ to: org, data }, '0x' + block.toString(16)], 10_000);
    if (typeof res !== 'string' || !/^0x[0-9a-f]{64,}$/i.test(res)) throw new ProvedError('check', 'tokenParam returned too little');
    return [new URL(url).host, res.slice(0, 66).toLowerCase()];
  }));
  return all.filter((a) => a.status === 'fulfilled').map((a) => a.value);
}

export { COLLECTION_CODE_HASH, KEY_CID, PROOF_ENDPOINTS, ProvedError, finalizedBlock, paramSlots, provedTokenParam, tokenParamAt };
