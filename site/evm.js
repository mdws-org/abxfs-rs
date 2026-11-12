// A read-only EVM: enough of the Ethereum virtual machine to run a view call such as tokenURI, with every piece
// of chain state it touches supplied by the caller (who proves it; see site/evm-state.js).
//
// It is not a general EVM. It runs the opcodes in OPS below and nothing else: an opcode outside that list, a
// state write, a contract creation, a log, or a precompile it does not have stops the run with EvmError
// 'unsupported'. Nothing is guessed. The caller then says "not proved" and never shows a result from here.
//
// Gas is not metered as a node meters it. A node's eth_call runs with a gas limit of its own choosing, so no two
// agree on GAS anyway. Here GAS answers a large constant that shrinks with each call, a call forwards what the
// 63/64 rule allows of what it asked for, and a call given no gas at all fails as it would on chain. A contract
// whose result depends on how much gas is left gives another result than a node does, and the caller's
// comparison with the endpoints' result reports that as a difference.

import { keccak256 } from './keccak-lookup.js';
import { sha256 } from './vendor/noble/hashes/sha2.js';

class EvmError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
const unsupported = (what) => { throw new EvmError('unsupported', `this viewer's EVM does not run ${what}`); };

const M256 = (1n << 256n) - 1n, SIGN = 1n << 255n;
const signed = (x) => (x & SIGN ? x - (1n << 256n) : x);
const MAX_STEPS = 400_000_000, MAX_MEMORY = 96 * 1024 * 1024, MAX_DEPTH = 1024, START_GAS = 1n << 40n;

const toBig = (u) => { let v = 0n; for (const b of u) v = (v << 8n) | BigInt(b); return v; };
function toBytes32(v) { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; }
const addressOf = (v) => '0x' + (v & ((1n << 160n) - 1n)).toString(16).padStart(40, '0');

// Memory that grows in 32-byte words, as the EVM's does.
class Memory {
  constructor() { this.buf = new Uint8Array(4096); this.size = 0; }
  grow(offset, length) {
    if (length === 0) return;
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > MAX_MEMORY) throw new EvmError('limit', 'the call uses more memory than this viewer allows');
    const words = Math.ceil(end / 32) * 32;
    if (words > this.size) this.size = words;
    if (words > this.buf.length) { const bigger = new Uint8Array(Math.max(this.buf.length * 2, words)); bigger.set(this.buf); this.buf = bigger; }
  }
  read(offset, length) { this.grow(offset, length); return this.buf.slice(offset, offset + length); }
  view(offset, length) { this.grow(offset, length); return this.buf.subarray(offset, offset + length); }
  write(offset, bytes) { this.grow(offset, bytes.length); this.buf.set(bytes, offset); }
}
// A stack operand used as an offset or a length: one that cannot be a real one is a run out of memory.
const small = (v) => { if (v > BigInt(MAX_MEMORY)) throw new EvmError('limit', 'the call names more memory than this viewer allows'); return Number(v); };
// Bytes from `source` at `offset` for `length`, zero-filled past its end (CALLDATACOPY, CODECOPY, EXTCODECOPY).
function padded(source, offset, length) {
  const out = new Uint8Array(length);
  if (offset < BigInt(source.length)) { const from = Number(offset); out.set(source.subarray(from, Math.min(source.length, from + length))); }
  return out;
}

// Valid jump destinations of a piece of code: JUMPDEST bytes that are not inside a PUSH's data.
const destinations = new WeakMap();
function jumpdests(code) {
  let set = destinations.get(code);
  if (!set) {
    set = new Uint8Array(code.length);
    for (let i = 0; i < code.length; i++) { const op = code[i]; if (op === 0x5b) set[i] = 1; else if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; }
    destinations.set(code, set);
  }
  return set;
}

// Precompiled contracts this viewer has. Each returns its output, or null when the input makes it fail.
// `cost` is what it needs of the gas it was forwarded.
const PRECOMPILES = {
  2: { cost: (d) => 60n + 12n * BigInt(Math.ceil(d.length / 32)), run: (d) => sha256(d) },
  4: { cost: (d) => 15n + 3n * BigInt(Math.ceil(d.length / 32)), run: (d) => Uint8Array.from(d) },
};

// Run one message call.
//   env    { chainId, number, timestamp, baseFee, prevRandao, coinbase, gasLimit }   from a proved block header
//   state  { code(address) -> Promise<Uint8Array>, storage(address, slot BigInt) -> Promise<BigInt>,
//            balance(address) -> Promise<BigInt>, codeHash(address) -> Promise<BigInt> }      proved by the caller
//   call   { to, data, from? }
// Returns { success, output }. Throws EvmError for anything it will not run.
async function run({ env, state, call }) {
  const counter = { steps: 0 };
  const origin = call.from || '0x' + '00'.repeat(20);
  return message({ env, state, counter, origin, depth: 0, gas: START_GAS, caller: origin, address: call.to, codeAddress: call.to, data: call.data, isStatic: false });
}

async function message(m) {
  if (m.depth > MAX_DEPTH) return { success: false, output: new Uint8Array(0), gasLeft: m.gas };
  const pre = BigInt(m.codeAddress);
  if (pre >= 1n && pre <= 0xffn) {
    const p = PRECOMPILES[Number(pre)];
    if (!p) return pre <= 0x11n ? unsupported(`the precompiled contract at address ${pre}`) : { success: true, output: new Uint8Array(0), gasLeft: m.gas };
    const cost = p.cost(m.data);
    if (m.gas < cost) return { success: false, output: new Uint8Array(0), gasLeft: 0n };
    return { success: true, output: p.run(m.data), gasLeft: m.gas - cost };
  }
  const code = await m.state.code(m.codeAddress);
  if (!code.length) return { success: true, output: new Uint8Array(0), gasLeft: m.gas };
  // Code with no gas to run it fails at once.
  if (m.gas <= 0n) return { success: false, output: new Uint8Array(0), gasLeft: 0n };
  return execute(m, code);
}

async function execute(m, code) {
  const { env, state, counter } = m;
  const stack = [], memory = new Memory(), dests = jumpdests(code);
  let pc = 0, returndata = new Uint8Array(0), gas = m.gas;
  const self = BigInt(m.address);
  const pop = () => { if (!stack.length) throw new EvmError('fault', 'stack underflow'); return stack.pop(); };
  const push = (v) => { if (stack.length >= 1024) throw new EvmError('fault', 'stack overflow'); stack.push(v); };
  let op = 0;
  // `env.onFail`, when given, is told where a frame failed. Tests use it to explain a difference from a node.
  const fail = (why = 'failed') => { if (env.onFail) env.onFail({ address: m.codeAddress, depth: m.depth, pc: pc - 1, op, why }); return { success: false, output: new Uint8Array(0), gasLeft: 0n }; };

  for (;;) {
    if (++counter.steps > MAX_STEPS) throw new EvmError('limit', 'the call runs longer than this viewer allows');
    if (pc >= code.length) return { success: true, output: new Uint8Array(0), gasLeft: gas };
    op = code[pc++];
    try {
      if (op >= 0x60 && op <= 0x7f) { // PUSH1..PUSH32
        const n = op - 0x5f;
        let v = 0n;
        for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(pc + i < code.length ? code[pc + i] : 0);
        pc += n; push(v); continue;
      }
      if (op >= 0x80 && op <= 0x8f) { const n = op - 0x7f; if (stack.length < n) throw new EvmError('fault', 'stack underflow'); push(stack[stack.length - n]); continue; }
      if (op >= 0x90 && op <= 0x9f) { const n = op - 0x8f; if (stack.length <= n) throw new EvmError('fault', 'stack underflow'); const t = stack.length - 1; [stack[t], stack[t - n]] = [stack[t - n], stack[t]]; continue; }
      switch (op) {
        case 0x00: return { success: true, output: new Uint8Array(0), gasLeft: gas }; // STOP
        case 0x01: push((pop() + pop()) & M256); break;
        case 0x02: push((pop() * pop()) & M256); break;
        case 0x03: { const a = pop(), b = pop(); push((a - b) & M256); break; }
        case 0x04: { const a = pop(), b = pop(); push(b === 0n ? 0n : a / b); break; }
        case 0x05: { const a = signed(pop()), b = signed(pop()); push(b === 0n ? 0n : (a / b) & M256); break; }
        case 0x06: { const a = pop(), b = pop(); push(b === 0n ? 0n : a % b); break; }
        case 0x07: { const a = signed(pop()), b = signed(pop()); push(b === 0n ? 0n : (a % b) & M256); break; }
        case 0x08: { const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a + b) % n); break; }
        case 0x09: { const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a * b) % n); break; }
        case 0x0a: { let base = pop(), e = pop(), r = 1n; while (e > 0n) { if (e & 1n) r = (r * base) & M256; base = (base * base) & M256; e >>= 1n; } push(r); break; }
        case 0x0b: { const k = pop(), x = pop(); if (k >= 31n) push(x); else { const bit = 8n * k + 7n, mask = (1n << (bit + 1n)) - 1n; push(x & (1n << bit) ? (x | (M256 ^ mask)) : x & mask); } break; }
        case 0x10: { const a = pop(), b = pop(); push(a < b ? 1n : 0n); break; }
        case 0x11: { const a = pop(), b = pop(); push(a > b ? 1n : 0n); break; }
        case 0x12: { const a = signed(pop()), b = signed(pop()); push(a < b ? 1n : 0n); break; }
        case 0x13: { const a = signed(pop()), b = signed(pop()); push(a > b ? 1n : 0n); break; }
        case 0x14: push(pop() === pop() ? 1n : 0n); break;
        case 0x15: push(pop() === 0n ? 1n : 0n); break;
        case 0x16: push(pop() & pop()); break;
        case 0x17: push(pop() | pop()); break;
        case 0x18: push(pop() ^ pop()); break;
        case 0x19: push(pop() ^ M256); break;
        case 0x1a: { const i = pop(), x = pop(); push(i >= 32n ? 0n : (x >> (8n * (31n - i))) & 0xffn); break; }
        case 0x1b: { const s = pop(), x = pop(); push(s >= 256n ? 0n : (x << s) & M256); break; }
        case 0x1c: { const s = pop(), x = pop(); push(s >= 256n ? 0n : x >> s); break; }
        case 0x1d: { const s = pop(), x = signed(pop()); push((s >= 256n ? (x < 0n ? -1n : 0n) : x >> s) & M256); break; }
        case 0x1e: { const x = pop(); push(x === 0n ? 256n : BigInt(256 - x.toString(2).length)); break; } // CLZ
        case 0x20: { const offset = small(pop()), length = small(pop()); push(toBig(keccak256(memory.view(offset, length)))); break; }
        case 0x30: push(self); break;
        case 0x31: push(await state.balance(addressOf(pop()))); break;
        case 0x32: push(BigInt(m.origin)); break;
        case 0x33: push(BigInt(m.caller)); break;
        case 0x34: push(0n); break; // CALLVALUE: this EVM carries no value
        case 0x35: { const i = pop(); push(toBig(padded(m.data, i, 32))); break; }
        case 0x36: push(BigInt(m.data.length)); break;
        case 0x37: { const to = small(pop()), from = pop(), length = small(pop()); memory.write(to, padded(m.data, from, length)); break; }
        case 0x38: push(BigInt(code.length)); break;
        case 0x39: { const to = small(pop()), from = pop(), length = small(pop()); memory.write(to, padded(code, from, length)); break; }
        case 0x3a: push(0n); break; // GASPRICE of a call
        case 0x3b: push(BigInt((await state.code(addressOf(pop()))).length)); break;
        case 0x3c: { const a = addressOf(pop()), to = small(pop()), from = pop(), length = small(pop()); memory.write(to, padded(await state.code(a), from, length)); break; }
        case 0x3d: push(BigInt(returndata.length)); break;
        case 0x3e: { const to = small(pop()), from = pop(), length = small(pop()); if (from + BigInt(length) > BigInt(returndata.length)) return fail(); memory.write(to, returndata.subarray(Number(from), Number(from) + length)); break; }
        case 0x3f: push(await state.codeHash(addressOf(pop()))); break;
        case 0x40: return unsupported('BLOCKHASH, which needs earlier block headers');
        case 0x41: push(BigInt(env.coinbase)); break;
        case 0x42: push(BigInt(env.timestamp)); break;
        case 0x43: push(BigInt(env.number)); break;
        case 0x44: push(BigInt(env.prevRandao)); break;
        case 0x45: push(BigInt(env.gasLimit)); break;
        case 0x46: push(BigInt(env.chainId)); break;
        case 0x47: push(await state.balance(m.address)); break;
        case 0x48: push(BigInt(env.baseFee)); break;
        case 0x49: push(0n); break; // BLOBHASH: a call carries no blobs
        case 0x4a: return unsupported('BLOBBASEFEE');
        case 0x50: pop(); break;
        case 0x51: push(toBig(memory.view(small(pop()), 32))); break;
        case 0x52: { const offset = small(pop()); memory.write(offset, toBytes32(pop())); break; }
        case 0x53: { const offset = small(pop()); memory.write(offset, Uint8Array.of(Number(pop() & 0xffn))); break; }
        case 0x54: push(await state.storage(m.address, pop())); break;
        case 0x55: return unsupported('a write to storage (SSTORE)');
        case 0x56: { const to = pop(); if (to >= BigInt(code.length) || !dests[Number(to)]) return fail(); pc = Number(to); break; }
        case 0x57: { const to = pop(), cond = pop(); if (cond !== 0n) { if (to >= BigInt(code.length) || !dests[Number(to)]) return fail(); pc = Number(to); } break; }
        case 0x58: push(BigInt(pc - 1)); break;
        case 0x59: push(BigInt(memory.size)); break;
        case 0x5a: push(gas > 0n ? gas : 0n); break;
        case 0x5b: break; // JUMPDEST
        case 0x5c: pop(); push(0n); break; // TLOAD: nothing was stored in this call, and TSTORE is refused
        case 0x5d: return unsupported('a write to transient storage (TSTORE)');
        case 0x5e: { const to = small(pop()), from = small(pop()), length = small(pop()); memory.write(to, memory.read(from, length)); break; }
        case 0x5f: push(0n); break;
        case 0xf1: case 0xf4: case 0xfa: { // CALL, DELEGATECALL, STATICCALL
          let asked = pop();
          const target = addressOf(pop());
          if (op === 0xf1 && pop() !== 0n) return unsupported('a call that sends value');
          const inOffset = small(pop()), inLength = small(pop()), outOffset = small(pop()), outLength = small(pop());
          const input = memory.read(inOffset, inLength);
          memory.grow(outOffset, outLength);
          // All but one 64th of what is left may be passed on, and no more than was asked for.
          const cap = gas - gas / 64n;
          if (asked > cap) asked = cap;
          gas -= asked + 100n;
          const delegate = op === 0xf4;
          const r = await message({
            env, state, counter, origin: m.origin, depth: m.depth + 1, gas: asked, data: input, codeAddress: target,
            caller: delegate ? m.caller : m.address, address: delegate ? m.address : target, isStatic: m.isStatic || op === 0xfa,
          });
          returndata = r.output;
          gas += r.gasLeft; // what the callee did not use comes back
          if (outLength) memory.write(outOffset, padded(returndata, 0n, Math.min(outLength, returndata.length)));
          push(r.success ? 1n : 0n);
          break;
        }
        case 0xf3: { const offset = small(pop()), length = small(pop()); return { success: true, output: memory.read(offset, length), gasLeft: gas }; }
        case 0xfd: { const offset = small(pop()), length = small(pop()); const output = memory.read(offset, length); if (env.onFail) env.onFail({ address: m.codeAddress, depth: m.depth, pc: pc - 1, op, why: 'REVERT', output }); return { success: false, output, gasLeft: gas }; }
        case 0xfe: return fail(); // INVALID
        case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: return unsupported('a log');
        case 0xf0: case 0xf5: return unsupported('creating a contract');
        case 0xf2: return unsupported('CALLCODE');
        case 0xff: return unsupported('SELFDESTRUCT');
        default: return unsupported(`opcode 0x${op.toString(16).padStart(2, '0')}`);
      }
      gas -= 3n;
    } catch (e) {
      // A stack fault or a jump to nowhere ends this frame as a failure; limits and unsupported operations end the run.
      if (e instanceof EvmError && e.kind === 'fault') return fail(e.message);
      throw e;
    }
  }
}

export { EvmError, run };
