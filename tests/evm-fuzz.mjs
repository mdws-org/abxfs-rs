// site/evm.js against a production EVM (@ethereumjs/evm, test-only, read from EVM_DIR): thousands of generated
// programs are run in both, and each must end the same way with the same output. The programs cover the
// arithmetic, comparison, bit and shift opcodes on edge values; memory, hashing and copying; calldata and code
// access; jumps; calls, delegate calls and static calls between contracts, with return data, reverts and the
// gas a call is given (none at all, or enough); and the precompiles this viewer has.
//
// The gas each one used must be the same too, which checks every cost: the fixed ones, memory growth, hashing and
// copying by the word, first and later access to accounts and storage, and what a call passes on and gets back.
//
// usage: EVM_DIR=<dir with node_modules/@ethereumjs> node tests/evm-fuzz.mjs [count per kind] [path to evm.js]
if (!process.env.EVM_DIR) { console.log('set EVM_DIR to a directory where `npm install @ethereumjs/evm@10.1.3` was run'); process.exit(2); }
const mods = process.env.EVM_DIR + '/node_modules/@ethereumjs/';
const { createEVM } = await import(mods + 'evm/dist/esm/index.js');
const { Common, Mainnet, Hardfork } = await import(mods + 'common/dist/esm/index.js');
const { createAddressFromString } = await import(mods + 'util/dist/esm/index.js');
const { run, EvmError } = await import(process.argv[3] || '../site/evm.js');
const { keccak256 } = await import('../site/keccak-lookup.js');
const N = Number(process.argv[2] || 600);

let seed = 0x1234567;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const pick = (list) => list[rnd() % list.length];
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const MAX = (1n << 256n) - 1n;
const EDGES = [0n, 1n, 2n, 3n, 7n, 8n, 29n, 30n, 31n, 32n, 33n, 255n, 256n, 257n, 0xffffn, 1n << 64n, (1n << 128n) - 1n, 1n << 255n, (1n << 255n) - 1n, (1n << 255n) + 1n, MAX, MAX - 1n, MAX - 255n];
const word = () => (rnd() % 3 === 0 ? pick(EDGES) : rnd() % 3 === 0 ? BigInt(rnd() % 300) : (BigInt(rnd()) << 224n) | (BigInt(rnd()) << 128n) | (BigInt(rnd()) << 32n) | BigInt(rnd()));
const push = (v) => { if (v === 0n && rnd() % 2) return '5f'; const h = v.toString(16); const bytes = h.length % 2 ? '0' + h : h; return (0x5f + bytes.length / 2).toString(16) + bytes; };
const pushN = (n) => push(BigInt(n));
// Leave the top `count` stack words in memory and return them.
const returnTop = (count) => { let out = ''; for (let i = 0; i < count; i++) out += pushN(32 * i) + '52'; return out + pushN(32 * count) + '5f' + 'f3'; };

const BINARY = ['01', '02', '03', '04', '05', '06', '07', '0a', '0b', '10', '11', '12', '13', '14', '16', '17', '18', '1a', '1b', '1c', '1d'], UNARY = ['15', '19', '1e'], TERNARY = ['08', '09'];
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const LOW = '0x' + '00'.repeat(19) + '20'; // an ordinary account at an address just above the precompiles
const FAR = [0x06000001n, 1n << 64n, MAX]; // where no memory could be paid for

// Each generator returns { codes: { address: hex }, data: hex } for a call to A.
const KINDS = {
  arithmetic() {
    let code = '', depth = 0;
    for (let i = 0; i < 4 + (rnd() % 4); i++) { code += push(word()); depth++; }
    for (let i = 0; i < 2 + (rnd() % 10); i++) {
      const r = rnd() % 10;
      if (r < 6 && depth >= 2) { code += pick(BINARY); depth--; } else if (r < 7 && depth >= 3) { code += pick(TERNARY); depth -= 2; } else if (r < 8 && depth >= 1) code += pick(UNARY);
      else if (r < 9 && depth >= 2) code += (0x90 + (rnd() % Math.min(depth - 1, 16))).toString(16);
      else { code += depth && rnd() % 2 ? (0x80 + (rnd() % Math.min(depth, 16))).toString(16) : push(word()); depth++; }
    }
    // A byte index or shift at and around each boundary, last, so that its result is returned as it is.
    if (rnd() % 3 === 0) { code += push(word()) + pushN(pick([0, 1, 7, 8, 29, 30, 31, 32, 33, 255, 256, 257])) + pick(['0b', '1a', '1b', '1c', '1d']); depth++; }
    return { codes: { [A]: code + returnTop(Math.min(depth, 3)) }, data: '' };
  },
  memory() {
    let code = '';
    for (let i = 0; i < 3 + (rnd() % 6); i++) {
      const r = rnd() % 8, at = rnd() % 9 ? rnd() % 200 : rnd() % 150000;
      if (r < 3) code += push(word()) + pushN(at) + '52';
      else if (r < 4) code += push(word()) + pushN(at) + '53';
      else if (r < 5) code += pushN(rnd() % 100) + pushN(at) + '20' + pushN(rnd() % 200) + '52';
      else if (r < 6) code += pushN(rnd() % 4 ? rnd() % 80 : 0) + pushN(rnd() % 200) + pushN(at) + '5e';
      else if (r < 7) code += pushN(rnd() % 4 ? rnd() % 70 : 0) + pushN(rnd() % 90) + pushN(at) + pick(['37', '39']);
      else code += pushN(at) + '51' + pushN(rnd() % 200) + '52';
    }
    const data = hex(Uint8Array.from({ length: rnd() % 70 }, () => rnd() & 255));
    return { codes: { [A]: code + '59' + pushN(260) + '52' + '36' + pushN(292) + '52' + pushN(rnd() % 40) + '35' + pushN(324) + '52' + '38' + pushN(356) + '52' + pushN(388) + '5f' + 'f3' }, data };
  },
  jumps() {
    // if (calldata word 0 <op> constant) return X else return Y; one arm may jump into PUSH data, which must fail.
    const cond = push(word()) + '5f35' + pick(['10', '11', '14', '12', '13']);
    const bad = rnd() % 5 === 0;
    const head = cond + '60ff57'; // JUMPI to a destination patched below
    const armA = push(word()) + returnTop(1);
    const dest = head.length / 2 + armA.length / 2;
    // One time in three the jump is unconditional, over an arm that must never run.
    if (rnd() % 3 === 0) { const at = 3 + armA.length / 2; return { codes: { [A]: '60' + (bad ? at + 1 : at).toString(16).padStart(2, '0') + '56' + armA + '5b' + push(word()) + returnTop(1) }, data: '' }; }
    const code = cond + '60' + (bad ? dest + 1 : dest).toString(16).padStart(2, '0') + '57' + armA + '5b' + push(word()) + returnTop(1);
    return { codes: { [A]: code }, data: hex(Uint8Array.from({ length: 32 }, () => (rnd() % 3 ? 0 : rnd() & 255))) };
  },
  calls() {
    // A calls B (CALL, STATICCALL or DELEGATECALL) with some gas; B returns or reverts some memory, possibly after
    // calling C or a precompile; A returns the success flag, the return data size and the first words of it.
    const leaf = () => { const n = rnd() % 70; return push(word()) + '5f52' + push(word()) + '602052' + pushN(n) + pushN(rnd() % 20) + pick(['f3', 'f3', 'fd']); };
    const callOp = () => pick(['f1', 'fa', 'f4']);
    const call = (to, op, gas, inLen, outLen) => pushN(outLen) + pushN(128) + pushN(inLen) + '5f' + (op === 'f1' ? '5f' : '') + '73' + to.slice(2) + gas + op;
    const gasArg = () => pick(['5a', '5a', '5a', '5f', pushN(1), pushN(40), pushN(3000), pushN(100000)]);
    const target = () => pick([B, B, B, C, LOW, '0x' + '00'.repeat(19) + '04', '0x' + '00'.repeat(19) + '02', '0x' + 'ee'.repeat(20)]);
    const prelude = push(word()) + '5f52' + push(word()) + '602052';
    const mid = rnd() % 2 ? leaf() : prelude + call(target() === B ? C : pick([C, '0x' + '00'.repeat(19) + '04', '0x' + '00'.repeat(19) + '02']), callOp(), gasArg(), rnd() % 64, rnd() % 64) + '5f52' + '3d' + '602052' + pushN(64) + '3d' + '5f' + '3e'.repeat(0) + pushN(rnd() % 64) + '5f' + pick(['f3', 'fd']);
    const a = prelude + call(target(), callOp(), gasArg(), rnd() % 64, rnd() % 96) + '5f52' + '3d' + '602052' + pushN(128) + '51' + '604052' + pushN(160) + '51' + '606052' + pushN(128) + '5f' + 'f3';
    return { codes: { [A]: a, [B]: mid, [C]: leaf(), [LOW]: leaf() }, data: hex(Uint8Array.from({ length: rnd() % 40 }, () => rnd() & 255)) };
  },
  access() {
    // Storage and account reads, first and repeated, some inside a call that then fails (which forgets what it
    // read); A returns the gas left at the end, so a wrong cost shows in the output as well as in the total.
    const slot = () => pushN(rnd() % 3), who = () => '73' + pick([A, B, C, '0x' + '00'.repeat(19) + '02', '0x' + 'ee'.repeat(20)]).slice(2);
    const reads = () => { let out = ''; for (let i = 0; i < 1 + (rnd() % 5); i++) out += rnd() % 2 ? slot() + '54' + '50' : who() + pick(['31', '3b', '3f']) + '50'; return out; };
    const b = reads() + '5f5f' + pick(['f3', 'fd', 'fe']);
    const a = reads() + '5f5f5f5f73' + B.slice(2) + pick(['5a', pushN(3000), pushN(9000)]) + pick(['fa', 'f4']) + '50' + reads() + '5a5f52' + pushN(32) + '5f' + 'f3';
    return { codes: { [A]: a, [B]: b }, data: '' };
  },
  empty() {
    // Ranges of no bytes that start far beyond any memory: hashing, the copies, a call's input and output, and what
    // a frame returns or reverts with. Each costs no memory and must not fail.
    const far = () => push(pick(FAR));
    const piece = () => pick([
      '5f' + far() + '20' + pushN(32 * (rnd() % 4)) + '52',
      '5f' + '5f' + far() + pick(['37', '39']),
      '5f' + far() + far() + '5e',
      '5f' + '5f' + far() + '3e',
      '5f' + far() + '5f' + '73' + B.slice(2) + '3c',
      '5f' + far() + '5f' + far() + '73' + B.slice(2) + '5a' + pick(['fa', 'f4']) + pushN(128) + '52',
    ]);
    let a = push(word()) + '5f52';
    for (let i = 0; i < 1 + (rnd() % 4); i++) a += piece();
    a += rnd() % 4 ? '5a' + pushN(160) + '52' + pushN(192) + '5f' + 'f3' : '5f' + far() + pick(['f3', 'fd']);
    return { codes: { [A]: a, [B]: '5f' + far() + pick(['f3', 'fd', 'f3']) }, data: hex(Uint8Array.from({ length: rnd() % 40 }, () => rnd() & 255)) };
  },
  environment() {
    // What a contract can ask about itself, its caller and the block. Those whose value depends on the block are
    // read and dropped; the rest are returned. The gas left at the end is returned with them.
    const KEPT = ['30', '32', '33', '34', '36', '38', '3a', '3d', '58', '59', '46', '47', '5f49', '60aa60014950', '5f5c', '60075c'], DROPPED = ['41', '42', '43', '44', '45']; // not BASEFEE: the reference's default block has none
    const body = () => { let out = '', kept = 0; for (let i = 0; i < 2 + (rnd() % 8); i++) { if (rnd() % 3) { out += pick(KEPT) + pushN(32 * (kept++ + 1)) + '52'; } else out += pick(DROPPED) + '50'; } return out + '5a5f52' + pushN(32 * (kept + 1)) + '5f' + 'f3'; };
    const inner = body();
    const a = '5f5f' + pushN(rnd() % 40) + '5f73' + B.slice(2) + '5a' + pick(['fa', 'f4']) + '50' + '3d5f5f3e' + '3d5ff3';
    return rnd() % 2 ? { codes: { [A]: inner }, data: hex(Uint8Array.from({ length: rnd() % 40 }, () => rnd() & 255)) } : { codes: { [A]: a, [B]: inner }, data: '' };
  },
  returndata() {
    // RETURNDATACOPY inside and past the end of what a call returned; EXTCODESIZE, EXTCODECOPY and EXTCODEHASH of a contract and of nothing.
    const n = rnd() % 50, b = push(word()) + '5f52' + pushN(n) + '5f' + 'f3';
    const a = '5f5f5f5f73' + B.slice(2) + '5afa' + '50' + pushN(rnd() % 60) + pushN(rnd() % 30) + '5f' + '3e' + '73' + pick([B, C]).slice(2) + '3b' + pushN(64) + '52' + '73' + pick([B, C]).slice(2) + '3f' + pushN(96) + '52' + pushN(rnd() % 40) + pushN(rnd() % 20) + pushN(128) + '73' + B.slice(2) + '3c' + pushN(192) + '5f' + 'f3';
    return { codes: { [A]: a, [B]: b }, data: '' };
  },
};

const common = new Common({ chain: Mainnet, hardfork: Hardfork.Osaka });
async function reference({ codes, data }) {
  const evm = await createEVM({ common });
  for (const [address, code] of Object.entries(codes)) await evm.stateManager.putCode(createAddressFromString(address), fromHex(code));
  // What a transaction makes warm before it runs (EIP-2929, EIP-3651): the sender, the target, the coinbase and the
  // precompiles. runCall alone leaves that to its caller.
  for (const warm of [A.slice(2), '00'.repeat(20), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(warm);
  const r = await evm.runCall({ to: createAddressFromString(A), caller: createAddressFromString('0x' + '00'.repeat(20)), origin: createAddressFromString('0x' + '00'.repeat(20)), data: fromHex(data), gasLimit: 30_000_000n });
  return { success: !r.execResult.exceptionError, output: hex(r.execResult.returnValue), used: r.execResult.executionGasUsed };
}
async function ours({ codes, data }) {
  const state = {
    code: async (address) => fromHex(codes[address] || ''), storage: async () => 0n, balance: async () => 0n,
    codeHash: async (address) => (codes[address] ? BigInt('0x' + hex(keccak256(fromHex(codes[address])))) : 0n),
  };
  const env = { chainId: 1, number: 1, timestamp: 1, baseFee: 7n, prevRandao: '0x' + '00'.repeat(32), coinbase: '0x' + '00'.repeat(20), gasLimit: 30_000_000n };
  try { const r = await run({ env, state, call: { to: A, data: fromHex(data) }, gas: 30_000_000n }); return { success: r.success, output: hex(r.output), used: 30_000_000n - r.gasLeft }; } catch (e) { return { success: `threw ${e instanceof EvmError ? e.kind : e.message}`, output: '', used: -1n }; }
}

let bad = 0, total = 0;
for (const [kind, make] of Object.entries(KINDS)) {
  let same = 0, shown = 0;
  for (let i = 0; i < N; i++) {
    const program = make();
    const [want, got] = [await reference(program), await ours(program)];
    total++;
    if (want.success === got.success && want.output === got.output && want.used === got.used) { same++; continue; }
    bad++;
    if (shown++ < 3) console.log(`FAIL ${kind}: reference ${want.success ? 'returned' : 'failed'} gas ${want.used} ${want.output.slice(0, 80)} | ours gas ${got.used} ${got.success === true ? 'returned' : got.success === false ? 'failed' : got.success} ${got.output.slice(0, 80)}\n     A ${program.codes[A]}${program.codes[B] ? '\n     B ' + program.codes[B] : ''}${program.codes[C] ? '\n     C ' + program.codes[C] : ''}\n     data ${program.data}`);
  }
  console.log(`${same === N ? 'ok  ' : 'FAIL'} ${kind}: ${same} of ${N} programs end the same way and use the same gas in both`);
}
console.log(bad ? `${bad} of ${total} FAILED` : `ok: ${total} programs, the same in both`);
process.exit(bad ? 1 : 0);
