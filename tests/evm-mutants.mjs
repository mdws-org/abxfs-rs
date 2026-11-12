// site/evm.js with one rule or cost changed at a time; tests/evm-fuzz.mjs must FAIL against each.
// usage: EVM_DIR=<dir with node_modules/@ethereumjs> node tests/evm-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/evm.js'), 'utf8');
const MUTANTS = [
  // What an opcode computes.
  ['signed division', 'push(b === 0n ? 0n : (a / b) & M256); break; }', 'push(b === 0n ? 0n : (a / b + 1n) & M256); break; }'],
  ['signed less-than', 'case 0x12: { const a = signed(pop()), b = signed(pop());', 'case 0x12: { const a = pop(), b = pop();'],
  ['sign extension of a full word', 'if (k >= 31n) push(x);', 'if (k >= 30n) push(x);'],
  ['an arithmetic shift of a negative number by a word or more', '(s >= 256n ? (x < 0n ? -1n : 0n) : x >> s)', '(s >= 256n ? 0n : x >> s)'],
  ['a left shift by a word or more', 'push(s >= 256n ? 0n : (x << s) & M256);', 'push((x << (s & 0xffn)) & M256);'],
  ['the leading zeros of zero', 'push(x === 0n ? 256n :', 'push(x === 0n ? 255n :'],
  ['a modulus of zero in ADDMOD', 'push(n === 0n ? 0n : (a + b) % n);', 'push(n === 0n ? a + b : (a + b) % n);'],
  // Where execution may go and what it may read.
  ['a jump only to a JUMPDEST', "case 0x56: { const to = pop(); if (to >= BigInt(code.length) || !dests[Number(to)]) return fail();", 'case 0x56: { const to = pop(); if (to >= BigInt(code.length)) return fail();'],
  ['a conditional jump only to a JUMPDEST', "if (cond !== 0n) { if (to >= BigInt(code.length) || !dests[Number(to)]) return fail();", 'if (cond !== 0n) { if (to >= BigInt(code.length)) return fail();'],
  ['return data read only inside what was returned', "if (from + BigInt(length) > BigInt(returndata.length)) return fail('return data read past its end');", ''],
  ['a delegate call keeping its caller', 'caller: delegate ? m.caller : m.address,', 'caller: m.address,'],
  ['a delegate call keeping its address', 'address: delegate ? m.address : target,', 'address: target,'],
  ['a failed call returning 0', 'push(r.success ? 1n : 0n);', 'push(1n);'],
  ['a precompile failing with too little gas', "if (m.gas < cost) return { success: false, output: new Uint8Array(0), gasLeft: 0n };", ''],
  ['a range of no bytes starting anywhere', '(length === 0 ? 0 : small(offset))', '(small(offset))'],
  ['code at an address just above the precompiles being run', 'if (pre >= 1n && pre <= 0x11n) {', 'if (pre >= 1n && pre <= 0xffn) {'],
  // What it costs.
  ['the cost of hashing by the word', 'use(6n * words(length)); mem(offset, length); push(toBig(keccak256', 'mem(offset, length); push(toBig(keccak256'],
  ['the fixed cost of hashing', '[30, [0x20]]', '[3, [0x20]]'],
  ['the cost of EXP by the size of the exponent', 'use(50n * BigInt(Math.ceil(e.toString(16).length / 2) * (e === 0n ? 0 : 1)));', ''],
  ['the cost of copying call data by the word', 'use(3n * words(length)); mem(to, length); memory.write(to, padded(m.data, from, length));', 'mem(to, length); memory.write(to, padded(m.data, from, length));'],
  ['the cost of copying memory by the word', 'use(3n * words(length)); mem(Math.max(to, from), length);', 'mem(Math.max(to, from), length);'],
  ['memory growth for the source of a memory copy', 'mem(Math.max(to, from), length);', 'mem(to, length);'],
  ['the cost of memory growth', 'return words > this.size ? memoryCost(words) - memoryCost(this.size) : 0n;', 'return 0n;'],
  ['the quadratic part of the cost of memory', 'return 3n * w + (w * w) / 512n;', 'return 3n * w;'],
  ['memory growth for a read', 'case 0x51: { const offset = small(pop()); mem(offset, 32);', 'case 0x51: { const offset = small(pop()); memory.grow(offset, 32);'],
  ['memory growth for what a frame returns', 'case 0xf3: { const o = pop(), length = small(pop()), offset = start(o, length); mem(offset, length);', 'case 0xf3: { const o = pop(), length = small(pop()), offset = start(o, length);'],
  ['the first read of an account costing more', 'const COLD_ACCOUNT = 2600n,', 'const COLD_ACCOUNT = 100n,'],
  ['the first read of a storage slot costing more', 'COLD_SLOT = 2100n,', 'COLD_SLOT = 100n,'],
  ['a later read of a storage slot costing less', "  if (warm.set.has(key)) return WARM;\n", ''],
  ['a failed frame forgetting what it read', 'while (journal.length > mark) set.delete(journal.pop());', ''],
  ['the called contract starting warm', 'new Set([origin, call.to, String(env.coinbase).toLowerCase()])', 'new Set([origin, String(env.coinbase).toLowerCase()])'],
  ['a precompile being warm for a call', 'use(isPrecompile(target) ? WARM : touch(warm, target, COLD_ACCOUNT));', 'use(touch(warm, target, COLD_ACCOUNT));'],
  ['a precompile being warm for a read', 'case 0x3b: { const a = addressOf(pop()); use(isPrecompile(a) ? WARM : touch(warm, a, COLD_ACCOUNT));', 'case 0x3b: { const a = addressOf(pop()); use(touch(warm, a, COLD_ACCOUNT));'],
  ['one 64th of the gas kept back from a call', 'const cap = gas - gas / 64n;', 'const cap = gas;'],
  ['a call given no more gas than it asked for', 'if (asked > cap) asked = cap;', 'asked = cap;'],
  ['the gas given to a call leaving the caller', '          gas -= asked;\n', ''],
  ['unused gas coming back from a call', 'gas += r.gasLeft; // what the callee did not use comes back', ''],
  ['a frame that fails keeping no gas', "return { success: false, output: new Uint8Array(0), gasLeft: 0n }; };", "return { success: false, output: new Uint8Array(0), gasLeft: gas }; };"],
  ['the cost of the sha256 precompile by the word', '60n + 12n * BigInt(Math.ceil(d.length / 32))', '60n'],
  ['the cost of the identity precompile by the word', '15n + 3n * BigInt(Math.ceil(d.length / 32))', '15n'],
  ['the cost of reading transient storage', '[100, [0x5c]]', '[2, [0x5c]]'],
  ['BLOBHASH taking an index', 'case 0x49: pop(); push(0n);', 'case 0x49: push(0n);'],
];

const mutant = join(root, 'site/evm.mutant.js');
let bad = 0;
try {
  for (const [name, find, put] of MUTANTS) {
    if (src.split(find).length !== 2) { console.log(`FAIL ${name}: the line to change is in evm.js ${src.split(find).length - 1} times`); bad++; continue; }
    await writeFile(mutant, src.replace(find, put));
    const r = spawnSync(process.execPath, [join(root, 'tests/evm-fuzz.mjs'), '1500', '../site/evm.mutant.js'], { encoding: 'utf8', env: process.env });
    const caught = r.status === 1 && /FAILED/.test(r.stdout);
    if (!caught) bad++;
    console.log(`${caught ? 'ok  ' : 'FAIL'} without ${name}: the comparison ${caught ? 'fails' : r.status === 0 ? 'still passes' : 'ended another way: ' + (r.stderr || '').trim().split('\n').pop()}`);
  }
} finally { await rm(mutant, { force: true }); }
// The rules for other chains: tests/evm-chains.mjs must fail without each.
const CHAIN_MUTANTS = [
  ['an opcode refused on a chain', "if (env.refused && env.refused.has(op)) return unsupported(", "if (false) return unsupported("],
  ['the gas left being usable only by a call', "if (marks && marks.pop() && !gasUse) unsupported(", "if (marks && marks.pop() && false) unsupported("],
  ['a copy of the gas left staying marked', "push(stack[stack.length - n], Boolean(marks && marks[marks.length - n]));", "push(stack[stack.length - n]);"],
  ['a swapped gas value staying marked', " if (marks) [marks[t], marks[t - n]] = [marks[t - n], marks[t]];", ""],
  ['one allowance for one pop', "    gasUse = false;\n    return stack.pop();", "    return stack.pop();"],
  ['a contract built into a chain', "if (m.env.builtIn && m.env.builtIn(pre)) return unsupported(", "if (false) return unsupported("],
];
try {
  for (const [name, find, put] of CHAIN_MUTANTS) {
    if (src.split(find).length !== 2) { console.log(`FAIL ${name}: the line to change is in evm.js ${src.split(find).length - 1} times`); bad++; continue; }
    await writeFile(mutant, src.replace(find, put));
    const r = spawnSync(process.execPath, [join(root, 'tests/evm-chains.mjs'), '../site/evm.mutant.js'], { encoding: 'utf8' });
    const caught = r.status === 1;
    if (!caught) bad++;
    console.log(`${caught ? 'ok  ' : 'FAIL'} without ${name}: the chain cases ${caught ? 'fail' : 'still pass'}`);
  }
} finally { await rm(mutant, { force: true }); }
console.log(bad ? `${bad} of ${MUTANTS.length} changes NOT caught` : `ok: each of ${MUTANTS.length} changes to evm.js fails the comparison`);
process.exit(bad ? 1 : 0);
