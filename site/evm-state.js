// Chain state for site/evm.js, with nothing believed: every account, storage word and contract code the EVM asks
// for is fetched from an endpoint with a Merkle proof and checked against a state root that was itself proved.
//
// A call can touch hundreds of storage words, and one request per word would be slow. So an endpoint is first
// asked which accounts and words the call touches (eth_createAccessList). That answer is only a hint for what to
// fetch together: each word is still proved when it arrives, and a word the hint left out is fetched and proved
// when the EVM asks for it.

import { keccak256 } from './keccak-lookup.js';
import { EMPTY_CODE, accountAt, storageAt } from './proof.js';
import { ProvedError, call } from './proved.js';
import { EvmError, run } from './evm.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const PROOF_REPLY_BYTES = 12_000_000, MAX_REQUESTS = 600, SLOTS_PER_REQUEST = 200;

// Proved state at one block from one endpoint. `at` is the block tag to ask for; `stateRoot` is what proofs must match.
function provedState({ url, stateRoot, at }) {
  const accounts = new Map(), words = new Map(), codes = new Map();
  const stats = { requests: 0, accounts: 0, words: 0, codeBytes: 0 };
  const ask = (method, params) => { if (++stats.requests > MAX_REQUESTS) throw new EvmError('limit', 'the call touches more state than this viewer will fetch'); return call(url, method, params, 30_000, PROOF_REPLY_BYTES); };
  // One account with some of its storage words, proved, and remembered.
  async function fetch(address, slots) {
    const reply = await ask('eth_getProof', [address, slots, at]);
    if (!reply || !Array.isArray(reply.accountProof) || !Array.isArray(reply.storageProof) || reply.storageProof.length !== slots.length) throw new ProvedError('check', 'the endpoint did not return the proofs asked for');
    const account = accountAt(stateRoot, address, reply.accountProof);
    if (!accounts.has(address)) { accounts.set(address, account); stats.accounts++; }
    slots.forEach((slot, i) => {
      const sp = reply.storageProof[i];
      if (!sp || !Array.isArray(sp.proof)) throw new ProvedError('check', 'a storage proof is missing');
      const value = account ? storageAt(account.storageRoot, slot, sp.proof) : '0x' + '0'.repeat(64);
      const key = address + slot;
      if (!words.has(key)) { words.set(key, BigInt(value)); stats.words++; }
    });
    return account;
  }
  const account = async (address) => (accounts.has(address) ? accounts.get(address) : fetch(address, []));
  return {
    stats,
    // What the hint names is fetched account by account, many words to a request.
    async prefetch(list) {
      for (const { address, storageKeys } of list) {
        const a = String(address).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(a) || !Array.isArray(storageKeys)) continue;
        const slots = storageKeys.filter((k) => typeof k === 'string' && /^0x[0-9a-f]{64}$/i.test(k)).map((k) => k.toLowerCase());
        if (!slots.length) await fetch(a, []);
        for (let i = 0; i < slots.length; i += SLOTS_PER_REQUEST) await fetch(a, slots.slice(i, i + SLOTS_PER_REQUEST));
      }
    },
    async storage(address, slot) {
      const key = address + '0x' + slot.toString(16).padStart(64, '0');
      if (!words.has(key)) await fetch(address, ['0x' + slot.toString(16).padStart(64, '0')]);
      return words.get(key);
    },
    async balance(address) { const a = await account(address); return a ? BigInt(a.balance) : 0n; },
    async codeHash(address) { const a = await account(address); return a ? BigInt(a.codeHash) : 0n; },
    async code(address) {
      if (codes.has(address)) return codes.get(address);
      const a = await account(address);
      let code = new Uint8Array(0);
      if (a && a.codeHash !== EMPTY_CODE) {
        const hex = await ask('eth_getCode', [address, at]);
        if (typeof hex !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(hex)) throw new ProvedError('check', 'the endpoint did not return code');
        code = fromHex(hex);
        if (toHex(keccak256(code)) !== a.codeHash) throw new ProvedError('check', 'the code the endpoint gave does not hash to the proved code hash');
        stats.codeBytes += code.length;
      }
      codes.set(address, code);
      return code;
    },
  };
}

// Run a view call over proved state at the block a proved header describes.
//   header   from executionHeader(): { stateRoot, number, timestamp, coinbase, gasLimit, baseFee, prevRandao }
//   urls     endpoints that serve proofs at that block; tried in turn
// Returns { success, output (Uint8Array), stats, via }. Throws EvmError 'unsupported' or 'limit' when this EVM
// will not run the call, and ProvedError when no endpoint gave state that checks.
async function provedCall({ chainId, header, urls, to, data, onFail }) {
  const at = '0x' + header.number.toString(16);
  const env = { chainId, number: header.number, timestamp: header.timestamp, baseFee: header.baseFee, prevRandao: header.prevRandao, coinbase: header.coinbase, gasLimit: header.gasLimit, onFail };
  let last = new ProvedError('rpc', 'no endpoint to ask for state');
  for (const url of urls) {
    try {
      const state = provedState({ url, stateRoot: header.stateRoot, at });
      const hint = await call(url, 'eth_createAccessList', [{ to, data }, at], 30_000, PROOF_REPLY_BYTES).catch(() => null);
      if (hint && Array.isArray(hint.accessList)) await state.prefetch(hint.accessList.slice(0, 64));
      const result = await run({ env, state, call: { to: to.toLowerCase(), data: fromHex(data) } });
      return { ...result, stats: state.stats, via: new URL(url).host };
    } catch (e) {
      if (e instanceof EvmError) throw e; // not the endpoint's doing: another endpoint would end the same way
      last = e;
    }
  }
  throw last;
}

export { provedCall, provedState };
