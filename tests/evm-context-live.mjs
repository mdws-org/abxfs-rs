// What a contract can read about the call and the block, here and on live nodes: a small program that returns one
// such value is placed at an unused address with a state override, the endpoints are asked for it at one block
// with the gas this viewer names, and site/evm.js runs it with that block's header. Every endpoint that answers
// must return what the EVM returns, and at least two must answer.
// usage: node tests/evm-context-live.mjs
import { CHAINS } from '../site/chain.js';
import { CALL_GAS, PROOF_ENDPOINTS, call } from '../site/proved.js';
import { executionHeader } from '../site/proof.js';
import { callGas, run } from '../site/evm.js';

const chain = Object.values(CHAINS).find((c) => c.id === 1);
const urls = [...new Map([...PROOF_ENDPOINTS[1], ...chain.rpcs].map((u) => [new URL(u).host, u])).values()];
const to = '0x' + '5c'.repeat(20);
const fromHex = (h) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const hex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
// [name, the opcodes that leave the value on the stack, call data, gas named]
const SMALL = 1n << 24n;
const CASES = [
  ['GAS, with 16,777,216 named', '5a', '', SMALL], ['GAS, with call data', '5a', '00ff00ff0000', SMALL],
  ['BASEFEE', '48', '', CALL_GAS], ['GASPRICE', '3a', '', CALL_GAS], ['CALLER', '33', '', CALL_GAS], ['ORIGIN', '32', '', CALL_GAS], ['CALLVALUE', '34', '', CALL_GAS],
  ['GASLIMIT', '45', '', CALL_GAS], ['CHAINID', '46', '', CALL_GAS], ['NUMBER', '43', '', CALL_GAS], ['TIMESTAMP', '42', '', CALL_GAS], ['COINBASE', '41', '', CALL_GAS],
  ['PREVRANDAO', '44', '', CALL_GAS], ['BLOBHASH of index 0', '5f49', '', CALL_GAS], ['ADDRESS', '30', '', CALL_GAS], ['CALLDATASIZE', '36', 'aabbcc', CALL_GAS],
  ['the balance of the zero address, read cold then warm, and the gas left', '5f31505f3150' + '5a', '', SMALL],
  ['the code size of a precompile and the gas left', '6002' + '3b50' + '5a', '', SMALL],
];
let block = null, header = null;
for (const url of urls) { try { block = await call(url, 'eth_getBlockByNumber', ['finalized', false]); header = executionHeader(block.hash, block); break; } catch { /* next */ } }
if (!header) { console.log('FAIL no endpoint gave a block'); process.exit(1); }
console.log(`block ${header.number}, ${urls.length} endpoints`);
const env = { chainId: 1, number: header.number, timestamp: header.timestamp, baseFee: header.baseFee, prevRandao: header.prevRandao, coinbase: header.coinbase, gasLimit: header.gasLimit };
let bad = 0;
for (const [name, ops, data, gas] of CASES) {
  const code = ops + '5f5260205ff3';
  const state = { code: async (a) => (a === to ? fromHex(code) : new Uint8Array(0)), storage: async () => 0n, codeHash: async () => 0n,
    balance: async (a) => BigInt(await call(urls[0], 'eth_getBalance', [a, { blockHash: block.hash }]).catch(() => call(urls[1], 'eth_getBalance', [a, { blockHash: block.hash }]))) };
  const ours = await run({ env, state, call: { to, data: fromHex(data) }, gas: callGas(gas, fromHex(data)) });
  const all = await Promise.allSettled(urls.map(async (url) => [new URL(url).host, await call(url, 'eth_call', [{ to, data: '0x' + data, gas: '0x' + gas.toString(16) }, { blockHash: block.hash }, { [to]: { code: '0x' + code } }], 15_000)]));
  const got = all.filter((a) => a.status === 'fulfilled' && typeof a.value[1] === 'string').map((a) => a.value);
  const other = got.filter(([, reply]) => reply.toLowerCase() !== hex(ours.output));
  const ok = ours.success && got.length >= 2 && !other.length;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${BigInt(hex(ours.output))} here; ${got.length - other.length} of ${got.length} endpoints the same${other.length ? '; another: ' + other.map(([h, r]) => `${h} ${BigInt(r)}`).join(', ') : ''}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} values, the same here and on the endpoints`);
process.exit(bad ? 1 : 0);
