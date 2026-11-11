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

// The proved state of one token parameter.
//   chainId     1 or 11155111
//   checkpoint  the block root shipped with the viewer
//   beacon(path)          fetches a beacon API path as JSON; not trusted
//   rpc(method, params)   one JSON-RPC call to an execution endpoint; not trusted
// Returns { known: false, why } when the account is not an ABX collection (or does not exist), else
// { known: true, root, isSet, valueIsHash, block: { number, hash, timestamp }, finalizedSlot, participants }.
async function provedTokenParam({ chainId, checkpoint, beacon, rpc, org, token, key = KEY_CID, now = Date.now }) {
  const net = NETWORKS[chainId] || (() => { throw new ProvedError('unsupported', `no light client for chain ${chainId}`); })();
  const fin = await sync({ net, checkpoint, get: beacon, now });
  const header = executionHeader(fin.executionBlockHash, await rpc('eth_getBlockByHash', [fin.executionBlockHash, false]));
  const slots = paramSlots(token, key);
  const reply = await rpc('eth_getProof', [org, slots, '0x' + header.number.toString(16)]);
  if (!reply || !Array.isArray(reply.accountProof) || !Array.isArray(reply.storageProof) || reply.storageProof.length !== 2) throw new ProvedError('check', 'the endpoint did not return the proofs asked for');
  const block = { number: header.number, hash: fin.executionBlockHash, timestamp: header.timestamp };
  const at = { block, finalizedSlot: fin.finalizedSlot, participants: fin.participants, checkpointSlot: fin.checkpointSlot };
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
}

export { COLLECTION_CODE_HASH, KEY_CID, PROOF_ENDPOINTS, ProvedError, paramSlots, provedTokenParam };
