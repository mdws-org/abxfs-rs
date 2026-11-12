// Chain state for site/evm.js, with nothing believed: every account, storage word and contract code the EVM asks
// for is fetched from an endpoint with a Merkle proof and checked against a state root that was itself proved.
//
// A call can touch hundreds of storage words, and one request per word would be slow. So an endpoint is first
// asked which accounts and words the call touches (eth_createAccessList). That answer is only a hint for what to
// fetch together: each word is still proved when it arrives, and a word the hint left out is fetched and proved
// when the EVM asks for it.

import { keccak256 } from './keccak-lookup.js';
import { EMPTY_CODE, accountAt, storageAt } from './proof.js';
import { CALL_GAS, ProvedError, call, headerOf } from './proved.js';
import { EvmError, callGas, run } from './evm.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const PROOF_REPLY_BYTES = 12_000_000, MAX_REQUESTS = 600, SLOTS_PER_REQUEST = 200, AT_ONCE = 6;
const HINT_ACCOUNTS = 256, HINT_WORDS = 4000, HINT_REQUESTS = 300; // what a hint may make this viewer fetch
const MAX_MS = 120_000; // for all the requests of one call together

// Run the jobs, a few at a time. The first failure is thrown once the jobs under way have ended.
async function pool(jobs, width) {
  let next = 0, failed = null;
  const worker = async () => { while (next < jobs.length && !failed) { try { await jobs[next++](); } catch (e) { failed ??= e; } } };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
  if (failed) throw failed;
}

// Proved state at one block. `at` is the block tag to ask for; `stateRoot` is what proofs must match. Any of the
// endpoints may answer any request, since each answer is checked against the root: when one fails or gives
// something that does not check, the same request goes to the next, and later requests start there.
function provedState({ urls, stateRoot, at }) {
  const accounts = new Map(), words = new Map(), codes = new Map();
  const stats = { requests: 0, accounts: 0, words: 0, codeBytes: 0, hosts: new Set() };
  const deadline = Date.now() + MAX_MS;
  let first = 0, cap = MAX_REQUESTS;
  // Ask the endpoints in turn until `check` accepts a reply.
  async function ask(method, params, check) {
    let last = new ProvedError('rpc', 'no endpoint to ask for state');
    for (let n = 0, i = first; n < urls.length; n++, i = (i + 1) % urls.length) {
      if (++stats.requests > cap || Date.now() > deadline) throw new EvmError('limit', 'the call touches more state than this viewer will fetch');
      try {
        const out = check(await call(urls[i], method, params, 12_000, PROOF_REPLY_BYTES));
        first = i; stats.hosts.add(new URL(urls[i]).host);
        return out;
      } catch (e) { last = e; }
    }
    throw last;
  }
  // One account with some of its storage words, proved, and remembered.
  const fetch = (address, slots) => ask('eth_getProof', [address, slots, at], (reply) => {
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
  });
  const account = async (address) => (accounts.has(address) ? accounts.get(address) : fetch(address, []));
  return {
    stats,
    // What the hint names is fetched a few accounts at a time, many words to a request, each account's code with it.
    // A hint is an endpoint's word: it may use only part of the requests a call is allowed, each account is taken
    // once, and a failure while following it is not the call's failure.
    async prefetch(list) {
      const jobs = [], seen = new Set();
      let room = HINT_WORDS;
      cap = HINT_REQUESTS;
      for (const entry of list.slice(0, HINT_ACCOUNTS)) {
        const a = String(entry?.address).toLowerCase(), storageKeys = entry?.storageKeys;
        if (!/^0x[0-9a-f]{40}$/.test(a) || !Array.isArray(storageKeys) || seen.has(a)) continue;
        seen.add(a);
        const slots = [...new Set(storageKeys.slice(0, room).filter((k) => typeof k === 'string' && /^0x[0-9a-f]{64}$/i.test(k)).map((k) => k.toLowerCase()))];
        room -= slots.length;
        jobs.push(async () => {
          if (!slots.length) await fetch(a, []);
          for (let i = 0; i < slots.length; i += SLOTS_PER_REQUEST) await fetch(a, slots.slice(i, i + SLOTS_PER_REQUEST));
          await this.code(a);
        });
      }
      try { await pool(jobs, AT_ONCE); } catch { /* the EVM fetches what it needs as it goes */ } finally { cap = MAX_REQUESTS; }
    },
    async storage(address, slot) {
      const key = address + '0x' + slot.toString(16).padStart(64, '0');
      if (!words.has(key)) await fetch(address, ['0x' + slot.toString(16).padStart(64, '0')]);
      return words.get(key);
    },
    async balance(address) { const a = await account(address); return a ? BigInt(a.balance) : 0n; },
    // EXTCODEHASH is zero for an account that is not there and for one that is empty: no nonce, no balance, no code (EIP-1052).
    async codeHash(address) { const a = await account(address); return !a || (a.codeHash === EMPTY_CODE && BigInt(a.balance) === 0n && BigInt(a.nonce) === 0n) ? 0n : BigInt(a.codeHash); },
    // The promise is kept, so that two askers at once make one request.
    code(address) {
      if (!codes.has(address)) { codes.set(address, this.fetchCode(address)); codes.get(address).catch(() => codes.delete(address)); }
      return codes.get(address);
    },
    async fetchCode(address) {
      const a = await account(address);
      let code = new Uint8Array(0);
      if (a && a.codeHash !== EMPTY_CODE) {
        code = await ask('eth_getCode', [address, at], (hex) => {
          if (typeof hex !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(hex)) throw new ProvedError('check', 'the endpoint did not return code');
          const bytes = fromHex(hex);
          if (toHex(keccak256(bytes)) !== a.codeHash) throw new ProvedError('check', 'the code the endpoint gave does not hash to the proved code hash');
          return bytes;
        });
        stats.codeBytes += code.length;
      }
      return code;
    },
  };
}

// Run a view call over proved state at the block a proved header describes.
//   header   from executionHeader(): { stateRoot, number, timestamp, coinbase, gasLimit, baseFee, prevRandao }
//   urls     endpoints that serve proofs at that block; each request goes to the next when one fails
// Returns { success, output (Uint8Array), stats, via }. Throws EvmError 'unsupported' or 'limit' when this EVM
// will not run the call, and ProvedError when no endpoint gave state that checks.
async function provedCall({ chainId, header, urls, to, data, onFail, state = null }) {
  const at = '0x' + header.number.toString(16);
  const env = { chainId, number: header.number, timestamp: header.timestamp, baseFee: header.baseFee, prevRandao: header.prevRandao, coinbase: header.coinbase, gasLimit: header.gasLimit, onFail };
  // `state` from an earlier call at the same block may be given: what it proved is not fetched again.
  state ??= provedState({ urls, stateRoot: header.stateRoot, at });
  // The hint may come from any endpoint that gives one; not every endpoint has the method.
  for (const url of urls) {
    const hint = await call(url, 'eth_createAccessList', [{ to, data }, at], 30_000, PROOF_REPLY_BYTES).catch(() => null);
    if (!hint || !Array.isArray(hint.accessList)) continue;
    await state.prefetch([{ address: to, storageKeys: [] }, ...hint.accessList]);
    break;
  }
  const bytes = fromHex(data);
  const result = await run({ env, state, call: { to: to.toLowerCase(), data: bytes }, gas: callGas(CALL_GAS, bytes) });
  return { ...result, gasUsed: callGas(CALL_GAS, bytes) - result.gasLeft, state, stats: state.stats, via: [...state.stats.hosts].join(', ') };
}

// The same, at the finalized block `fin` names, in the form verdict.js judges: never throws.
// Returns { done: true, success, output (0x-hex), block: { number, hash }, stats, via } or { done: false, why }.
async function computedAt({ chainId, fin, urls, to, data, state = null }) {
  let header = null, last = null;
  for (const url of urls) { try { header = await headerOf(url, fin.executionBlockHash); break; } catch (e) { last = e; } }
  if (!header) return { done: false, why: `the finalized block's header could not be read: ${last ? last.message : 'no endpoint'}` };
  try {
    const r = await provedCall({ chainId, header, urls, to, data, state });
    return { done: true, success: r.success, output: toHex(r.output), state: r.state, block: { number: header.number, hash: fin.executionBlockHash }, stats: r.stats, via: r.via };
  } catch (e) {
    if (e instanceof EvmError) return { done: false, why: e.message };
    return { done: false, why: `the state could not be read by proof: ${e.message || e}` };
  }
}

export { computedAt, provedCall, provedState };
