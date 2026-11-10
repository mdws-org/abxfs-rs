// Check site/chain.js against an independent reader and against a lying endpoint.
//
// usage: node tests/chain-read.mjs <chain key> <root> <folder written by `abxfs-rs read <root> --out <folder>`> [tamper path]
//
// 1. Oracle: every file chain.js reads under <root> must equal, byte for byte, the file abxfs-rs wrote.
// 2. Tamper: the replies for one file ([tamper path], default the first file) are recorded, then replayed with one
//    hex digit changed, at many positions in every reply. Each run must either be refused or return the same bytes
//    (a change in ABI padding carries no meaning). A run that returns different bytes fails the test.
import { readFile as fsRead } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAINS, readFile, walk } from '../site/chain.js';

const [chainKey, root, folder, tamperPath] = process.argv.slice(2);
const chain = CHAINS[chainKey];
if (!chain || !/^0x[0-9a-f]{64}$/.test(root || '') || !folder) {
  console.error('usage: node tests/chain-read.mjs <chain key> <root> <folder> [tamper path]');
  process.exit(2);
}
const POSITIONS = 24;
const realFetch = globalThis.fetch;
const newCtx = () => ({ chain, url: chain.rpcs[0], requests: 0, ethCalls: 0, block: 'latest' });
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 1. Oracle.
const tree = await walk(newCtx(), root);
if (tree.kind !== 'directory') throw new Error('the oracle check needs a directory root');
const files = tree.items.filter((x) => !x.isDir && !x.invalid);
let bad = 0;
for (const f of files) {
  const want = new Uint8Array(await fsRead(join(folder, f.path)));
  const got = await readFile(newCtx(), f.cid, f.info);
  if (!same(got, want)) { bad++; console.log(`DIFFERENT ${f.path}: ${got.length} bytes here, ${want.length} from abxfs-rs`); }
}
console.log(`oracle: ${files.length - bad} of ${files.length} files equal abxfs-rs read`);

// 2. Tamper.
const target = tamperPath ? files.find((f) => f.path === tamperPath) : files[0];
if (!target) throw new Error(`no file ${tamperPath} under this root`);
const want = new Uint8Array(await fsRead(join(folder, target.path)));
const tape = new Map(); // request body -> reply text
globalThis.fetch = async (url, init) => {
  const r = await realFetch(url, init);
  const text = await r.text();
  tape.set(init.body, text);
  return new Response(text, { status: r.status });
};
await readFile(newCtx(), target.cid, target.info);
const bodies = [...tape.keys()];
let refused = 0, unchanged = 0, accepted = 0, runs = 0;
for (const body of bodies) {
  const reply = tape.get(body);
  const start = reply.indexOf('"0x') + 3, end = reply.lastIndexOf('"');
  if (start < 3 || end <= start) throw new Error('a recorded reply has no hex result');
  for (let k = 0; k < POSITIONS; k++) {
    const at = start + Math.floor(((end - start - 1) * k) / (POSITIONS - 1));
    const digit = reply[at] === '0' ? '1' : '0';
    const lie = reply.slice(0, at) + digit + reply.slice(at + 1);
    globalThis.fetch = async (_url, init) => new Response(init.body === body ? lie : tape.get(init.body) ?? '{"error":{"message":"not on the tape"}}');
    runs++;
    try {
      const got = await readFile(newCtx(), target.cid, target.info);
      if (same(got, want)) unchanged++;
      else { accepted++; console.log(`ACCEPTED a changed reply: request ${bodies.indexOf(body)}, digit ${at - start}`); }
    } catch {
      refused++;
    }
  }
}
console.log(`tamper (${target.path}, ${bodies.length} replies): ${runs} runs, ${refused} refused, ${unchanged} returned the same bytes, ${accepted} returned different bytes`);
process.exit(bad || accepted || refused === 0 ? 1 : 0);
