// What site/evm.js refuses on a chain other than Ethereum (the rules site/evm-state.js gives it): an opcode that
// means something else there, an opcode the chain may not have, and a call to a contract built into the chain.
// Each must end the run as unsupported, never as a result. On Ethereum the same programs run.
// usage: node tests/evm-chains.mjs [path to evm.js]
const { run, EvmError } = await import(process.argv[2] || '../site/evm.js');
const fromHex = (h) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const A = '0x' + 'a1'.repeat(20);
const RET = '5f5260205ff3'; // return the top of the stack
const ARBITRUM = { refused: new Set([0x41, 0x43, 0x44, 0x45, 0x48]), builtIn: (a) => (a >= 0x64n && a <= 0xffn) || a === 0xa4b05n, gasOpaque: true };
const BASE = {};
const end = async (code, rules) => {
  const other = rules.stylus ? fromHex('eff00000aabbcc') : new Uint8Array(0);
  const state = { code: async (a) => (a === A ? fromHex(code) : other), storage: async () => 0n, balance: async () => 0n, codeHash: async () => 0n };
  const env = { ...rules, chainId: 1, number: 7, timestamp: 9, baseFee: 0n, prevRandao: '0x' + '00'.repeat(32), coinbase: '0x' + '00'.repeat(20), gasLimit: 30_000_000n };
  try { const r = await run({ env, state, call: { to: A, data: new Uint8Array(0) }, gas: 1_000_000n }); return r.success ? 'ran' : 'failed'; } catch (e) { return e instanceof EvmError ? e.kind : `crash: ${e.message}`; }
};
const call = (to) => '5f5f5f5f' + '60' + to + '5afa' + RET; // STATICCALL to a one-byte address, return its success flag
// [name, code, rules, wanted]
const CASES = [
  ['NUMBER on Ethereum', '43' + RET, {}, 'ran'], ['NUMBER on Arbitrum', '43' + RET, ARBITRUM, 'unsupported'], ['NUMBER on Base', '43' + RET, BASE, 'ran'],
  ['COINBASE on Arbitrum', '41' + RET, ARBITRUM, 'unsupported'], ['PREVRANDAO on Arbitrum', '44' + RET, ARBITRUM, 'unsupported'],
  ['GASLIMIT on Arbitrum', '45' + RET, ARBITRUM, 'unsupported'], ['BASEFEE on Arbitrum', '48' + RET, ARBITRUM, 'unsupported'],
  ['TIMESTAMP on Arbitrum', '42' + RET, ARBITRUM, 'ran'], ['CHAINID on Arbitrum', '46' + RET, ARBITRUM, 'ran'],
  ['CLZ on Ethereum', '60011e' + RET, {}, 'ran'], ['CLZ on Base', '60011e' + RET, BASE, 'ran'], ['CLZ on Arbitrum', '60011e' + RET, ARBITRUM, 'ran'],
  ['a call to ArbosActs (0xa4b05) on Arbitrum', '5f5f5f5f' + '620a4b05' + '5afa' + RET, ARBITRUM, 'unsupported'],
  // The gas left, on a chain whose gas this EVM does not count.
  ['the gas left returned, on Ethereum', '5a' + RET, {}, 'ran'], ['the gas left returned, on Base', '5a' + RET, BASE, 'ran'],
  ['the gas left returned, on Arbitrum', '5a' + RET, ARBITRUM, 'unsupported'],
  ['the gas left read and dropped, on Arbitrum', '5a50' + '6001' + RET, ARBITRUM, 'ran'],
  ['the gas left passed to a call, on Arbitrum', call('63'), ARBITRUM, 'ran'],
  ['the gas left compared, on Arbitrum', '5a61c35010' + RET, ARBITRUM, 'unsupported'],
  ['the gas left less 5,000 passed to a call, on Arbitrum', '5f5f5f5f6063' + '6113885a03' + 'fa' + RET, ARBITRUM, 'unsupported'],
  ['the gas left copied, the copy stored, on Arbitrum', '5a80' + '5f52' + '50' + '6001' + RET, ARBITRUM, 'unsupported'],
  ['the gas left swapped under a value and dropped, on Arbitrum', '5a6007' + '90' + '50' + RET, ARBITRUM, 'ran'],
  ['the gas left swapped under a value, then returned, on Arbitrum', '5a6007' + '90' + '5050' + '5a' + RET, ARBITRUM, 'unsupported'],
  ['the gas left as the address a call is made to, on Arbitrum', '5f5f5f5f' + '5a' + '5a' + 'fa' + RET, ARBITRUM, 'unsupported'],
  ['the gas left used as a jump target, on Arbitrum', '5a56', ARBITRUM, 'unsupported'],
  ['a program that is not EVM code, called on Arbitrum', call('63'), { ...ARBITRUM, stylus: true }, 'unsupported'],
  ['a program that is not EVM code, called on Ethereum', call('63'), { stylus: true }, 'unsupported'],
  ['a refused opcode that is never reached', '6001' + RET + '43', ARBITRUM, 'ran'],
  ['a call to ArbSys (0x64) on Arbitrum', call('64'), ARBITRUM, 'unsupported'], ['a call to 0xff on Arbitrum', call('ff'), ARBITRUM, 'unsupported'],
  ['a call to 0x63 on Arbitrum, an ordinary address', call('63'), ARBITRUM, 'ran'], ['a call to 0x64 on Ethereum, an ordinary address', call('64'), {}, 'ran'],
  ['a call to 0x64 on Base, an ordinary address', call('64'), BASE, 'ran'],
];
let bad = 0;
for (const [name, code, rules, want] of CASES) {
  const got = await end(code, rules);
  if (got !== want) bad++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${name}: ${got}${got === want ? '' : `, wanted ${want}`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} cases`);
process.exit(bad ? 1 : 0);
